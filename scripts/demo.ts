/**
 * Standalone demo / smoke script.
 *
 * Boots the app in-process against the in-memory store and drives the full
 * lifecycle (login -> create -> subscribe over SSE -> update -> delete),
 * printing what happens. Run it on any runtime to see EdgeHive work end to end
 * with zero external services:
 *
 *   node --experimental-strip-types scripts/demo.ts
 *   bun run scripts/demo.ts
 *   deno run --allow-net --allow-env scripts/demo.ts
 */

import { createApp } from "../src/core/app.ts";
import { Broadcaster } from "../src/lib/broadcaster.ts";
import { MemoryStore } from "../src/lib/store.ts";

const app = createApp({ store: new MemoryStore(), broadcaster: new Broadcaster() });
const base = "http://demo.local";
const call = (path: string, init?: RequestInit) =>
  Promise.resolve(app.fetch(new Request(`${base}${path}`, init)));

async function main(): Promise<void> {
  console.log("EdgeHive demo — everything runs in-process, no services needed.\n");

  // 1. Login
  const loginRes = await call("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "demo@edgehive.dev" }),
  });
  const { token } = (await loginRes.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  console.log("1. Logged in, got a bearer token.");

  // 2. Subscribe to the SSE stream and log events as they arrive.
  const streamRes = await call("/v1/messages/stream");
  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value).trim();
      if (text && !text.includes("heartbeat")) {
        console.log("   [SSE] " + text.replace(/\n/g, " | "));
      }
    }
  })();
  console.log("2. Subscribed to /v1/messages/stream (realtime).");

  // Give the subscription a tick to register.
  await new Promise((r) => setTimeout(r, 50));

  // 3. Create
  const createRes = await call("/v1/messages", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ text: "hello world", from: "demo" }),
  });
  const created = (await createRes.json()) as { id: string };
  console.log(`3. Created message ${created.id}.`);
  await new Promise((r) => setTimeout(r, 50));

  // 4. Update
  await call(`/v1/messages/${created.id}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ text: "hello world (edited)", from: "demo" }),
  });
  console.log("4. Updated the message.");
  await new Promise((r) => setTimeout(r, 50));

  // 5. Delete
  await call(`/v1/messages/${created.id}`, { method: "DELETE", headers: auth });
  console.log("5. Deleted the message.");
  await new Promise((r) => setTimeout(r, 50));

  await reader.cancel();
  console.log("\nDone. All five realtime events were delivered over SSE above.");
}

main().catch((err) => {
  console.error(err);
  // process may not exist on Deno; guard the exit.
  if (typeof process !== "undefined") process.exitCode = 1;
});
