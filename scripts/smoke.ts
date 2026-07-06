/**
 * Runtime-agnostic smoke test.
 *
 * Boots the real Hono app in-process (in-memory store, no external services)
 * and asserts the core CRUD + auth + realtime behaviour. It relies only on Web
 * APIs plus `node:assert`, which Node, Bun and Deno all provide, so the SAME
 * script proves parity on every runtime:
 *
 *   node --experimental-strip-types scripts/smoke.ts
 *   bun run scripts/smoke.ts
 *   deno run --allow-net --allow-env scripts/smoke.ts
 *
 * Exits non-zero on any assertion failure.
 */

import assert from "node:assert/strict";

import { createApp } from "../src/core/app.ts";
import { Broadcaster } from "../src/lib/broadcaster.ts";
import { MemoryStore } from "../src/lib/store.ts";
import { runtimeLabel } from "../src/core/runtime.ts";

const app = createApp({ store: new MemoryStore(), broadcaster: new Broadcaster() });
const base = "http://smoke.local";
const call = (path: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(app.fetch(new Request(`${base}${path}`, init)));

async function main(): Promise<void> {
  console.log(`[smoke] runtime = ${runtimeLabel()}`);

  // Banner + health
  assert.equal((await call("/")).status, 200);
  const health = (await (await call("/health")).json()) as { status: string };
  assert.equal(health.status, "ok");

  // Login
  const login = (await (
    await call("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "smoke@edgehive.dev" }),
    })
  ).json()) as { token: string };
  assert.ok(login.token.split(".").length === 3);
  const auth = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };

  // Unauthorised write is rejected
  assert.equal((await call("/v1/x", { method: "POST", body: "{}" })).status, 401);

  // Realtime: subscribe, then create, and confirm the event arrives.
  const stream = await call("/v1/smoke/stream");
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // ready frame

  const create = await call("/v1/smoke", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ hello: "world", n: 1 }),
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { id: string };

  let sawCreated = false;
  for (let i = 0; i < 5 && !sawCreated; i++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (/event: created/.test(decoder.decode(chunk.value))) sawCreated = true;
  }
  assert.ok(sawCreated, "SSE delivered the created event");
  await reader.cancel();

  // Read, update, delete
  const got = (await (await call(`/v1/smoke/${created.id}`)).json()) as {
    data: { hello: string };
  };
  assert.equal(got.data.hello, "world");

  const put = await call(`/v1/smoke/${created.id}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ hello: "edge", n: 2 }),
  });
  assert.equal(put.status, 200);

  const del = await call(`/v1/smoke/${created.id}`, { method: "DELETE", headers: auth });
  assert.equal(del.status, 200);
  assert.equal((await call(`/v1/smoke/${created.id}`)).status, 404);

  console.log("[smoke] PASS — CRUD + auth + realtime all green on", runtimeLabel());
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  // Signal failure on whichever runtime we're on.
  const g = globalThis as { process?: { exitCode?: number }; Deno?: { exit(code: number): never } };
  if (g.process) g.process.exitCode = 1;
  else if (g.Deno) g.Deno.exit(1);
});
