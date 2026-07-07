/**
 * Realtime fan-out load/soak test.
 *
 * Opens N concurrent in-process SSE subscribers on one collection, drives a
 * burst of writes, and asserts that EVERY subscriber received EVERY event —
 * then prints p50 / p95 / max fan-out latency and the dropped-event count.
 *
 * It runs entirely in-process against the real Hono app (no server, no external
 * services) and uses only Web + `node:assert` APIs, so the SAME script produces
 * comparable numbers on Node, Bun and Deno:
 *
 *   SUBSCRIBERS=200 EVENTS=50 node --experimental-strip-types scripts/load.ts
 *   deno run --allow-net --allow-env --allow-read scripts/load.ts
 *   bun run scripts/load.ts
 *
 * Exits non-zero if any subscriber drops an event or p95 exceeds the budget, so
 * a scaled-down invocation is safe to wire into CI.
 */

import assert from "node:assert/strict";

import { createApp } from "../src/core/app.ts";
import { Broadcaster } from "../src/lib/broadcaster.ts";
import { MemoryStore } from "../src/lib/store.ts";
import { runtimeLabel, getEnvNumber } from "../src/core/runtime.ts";

const SUBSCRIBERS = getEnvNumber("SUBSCRIBERS", 200);
const EVENTS = getEnvNumber("EVENTS", 50);
const P95_BUDGET_MS = getEnvNumber("P95_BUDGET_MS", 50);
const COL = "load";

// A high SSE-per-IP cap so the load test isn't throttled by its own protection.
const config = {
  ...defaultConfig(),
  maxSsePerIp: SUBSCRIBERS + 10,
  writeBurst: EVENTS + 10,
  writeRatePerSec: 100000,
};

function defaultConfig() {
  return {
    port: 0,
    projectId: "edgehive-load",
    firestoreEmulatorHost: "127.0.0.1:8080",
    authEmulatorHost: "127.0.0.1:9099",
    authSecret: "load-secret",
    useEmulator: false,
    corsOrigins: ["*"],
    maxBodyBytes: 64 * 1024,
    writeRatePerSec: 100000,
    writeBurst: 100000,
    loginRatePerMin: 100000,
    maxSsePerIp: 100000,
    requireAuthForReads: false,
    demoMode: false,
  };
}

interface SubStat {
  received: number;
  latencies: number[];
}

async function main(): Promise<void> {
  console.log(
    `[load] runtime=${runtimeLabel()} subscribers=${SUBSCRIBERS} events=${EVENTS} ` +
      `p95Budget=${P95_BUDGET_MS}ms`,
  );

  const app = createApp({ store: new MemoryStore(), broadcaster: new Broadcaster(), config });
  const base = "http://load.local";
  const call = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`${base}${path}`, init)));

  // Auth for the writer.
  const login = (await (
    await call("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "load@edgehive.dev" }),
    })
  ).json()) as { token: string };
  const auth = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };

  // Open all subscribers and start draining them concurrently.
  const stats: SubStat[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const drainers: Promise<void>[] = [];
  const decoder = new TextDecoder();

  for (let i = 0; i < SUBSCRIBERS; i++) {
    // Distinct IPs so the per-IP SSE cap never triggers.
    const res = await call(`/v1/${COL}/stream`, {
      headers: { "x-forwarded-for": `10.0.${(i >> 8) & 255}.${i & 255}` },
    });
    const reader = res.body!.getReader();
    readers.push(reader);
    const stat: SubStat = { received: 0, latencies: [] };
    stats.push(stat);

    drainers.push(
      (async () => {
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (frame.includes("event: created")) {
              const m = /data: (\{.*\})/.exec(frame);
              if (m) {
                try {
                  const evt = JSON.parse(m[1]) as { data?: { sentAt?: number } };
                  const sentAt = evt.data?.sentAt;
                  if (typeof sentAt === "number") stat.latencies.push(Date.now() - sentAt);
                } catch {
                  /* ignore parse noise */
                }
                stat.received += 1;
              }
            }
          }
        }
      })(),
    );
  }

  // Let every subscription register (ready + snapshot flushed).
  await sleep(100);

  // Write burst — each write is one fan-out to all subscribers.
  for (let n = 0; n < EVENTS; n++) {
    const res = await call(`/v1/${COL}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ n, sentAt: Date.now() }),
    });
    assert.equal(res.status, 201, `write ${n} should succeed`);
  }

  // Wait until every subscriber has seen every event (or time out).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (stats.every((s) => s.received >= EVENTS)) break;
    await sleep(20);
  }

  // Tear down subscribers.
  await Promise.all(readers.map((r) => r.cancel().catch(() => {})));
  await Promise.allSettled(drainers);

  // Aggregate.
  const allLatencies: number[] = [];
  let dropped = 0;
  for (const s of stats) {
    dropped += Math.max(0, EVENTS - s.received);
    allLatencies.push(...s.latencies);
  }
  allLatencies.sort((a, b) => a - b);
  const expected = SUBSCRIBERS * EVENTS;

  const p = (q: number) =>
    allLatencies.length ? allLatencies[Math.min(allLatencies.length - 1, Math.floor(allLatencies.length * q))] : 0;
  const p50 = p(0.5);
  const p95 = p(0.95);
  const max = allLatencies.length ? allLatencies[allLatencies.length - 1] : 0;

  console.log(`[load] delivered ${allLatencies.length}/${expected} events, dropped ${dropped}`);
  console.log(`[load] fan-out latency  p50=${p50}ms  p95=${p95}ms  max=${max}ms`);

  assert.equal(dropped, 0, `no events should be dropped (dropped ${dropped})`);
  assert.ok(
    p95 <= P95_BUDGET_MS,
    `p95 fan-out latency ${p95}ms should be within budget ${P95_BUDGET_MS}ms`,
  );

  console.log(
    `[load] PASS — ${SUBSCRIBERS} subscribers each received all ${EVENTS} events, ` +
      `p95 ${p95}ms on ${runtimeLabel()}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[load] FAIL:", err);
  const g = globalThis as { process?: { exitCode?: number }; Deno?: { exit(code: number): never } };
  if (g.process) g.process.exitCode = 1;
  else if (g.Deno) g.Deno.exit(1);
});
