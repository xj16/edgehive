/**
 * Firestore-emulator integration test.
 *
 * Run inside `firebase emulators:exec` (see .github/workflows/ci.yml). It:
 *   1. Forces the Firestore-backed store (no in-memory fallback).
 *   2. Confirms the emulator is reachable via the store health probe.
 *   3. Boots the real Hono app and drives the full CRUD + auth lifecycle over
 *      HTTP against a `Bun.serve`-equivalent Node server, asserting that data
 *      actually persists in Firestore between requests.
 *
 * A non-zero exit code fails CI. This is the proof that the Firestore transport
 * (not just the in-memory fallback) works end to end.
 */

import { serve } from "@hono/node-server";
import assert from "node:assert/strict";

import { createApp } from "../src/core/app.ts";
import { Broadcaster } from "../src/lib/broadcaster.ts";
import { createStore } from "../src/lib/store.ts";
import { loadConfig } from "../src/core/config.ts";

async function main(): Promise<void> {
  const config = loadConfig();

  // Force the Firestore-backed store; if the emulator is down this throws and
  // the integration test correctly fails.
  const store = await createStore({
    useEmulator: true,
    firestoreEmulatorHost: config.firestoreEmulatorHost,
    projectId: config.projectId,
    force: "firestore",
  });
  assert.equal(store.kind, "firestore", "must use the Firestore store");
  assert.equal(await store.healthy(), true, "Firestore emulator must be reachable");
  console.log("[integration] Firestore emulator reachable at", config.firestoreEmulatorHost);

  const app = createApp({ store, broadcaster: new Broadcaster() });
  const port = 8899;
  const server = serve({ fetch: app.fetch, port });
  const base = `http://127.0.0.1:${port}`;

  try {
    // Login
    const loginRes = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ci@edgehive.dev" }),
    });
    assert.equal(loginRes.status, 200);
    const { token } = (await loginRes.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    // Create
    const createRes = await fetch(`${base}/v1/ci_todos`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "persisted in firestore", done: false, n: 7 }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { id: string; data: Record<string, unknown> };
    assert.ok(created.id, "created doc has an id");
    console.log("[integration] created", created.id);

    // Read back from Firestore (proves persistence across requests)
    const getRes = await fetch(`${base}/v1/ci_todos/${created.id}`);
    assert.equal(getRes.status, 200);
    const fetched = (await getRes.json()) as { data: { title: string; n: number } };
    assert.equal(fetched.data.title, "persisted in firestore");
    assert.equal(fetched.data.n, 7);
    console.log("[integration] read back from Firestore OK");

    // Update
    const putRes = await fetch(`${base}/v1/ci_todos/${created.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ title: "persisted in firestore", done: true, n: 8 }),
    });
    assert.equal(putRes.status, 200);
    const updated = (await putRes.json()) as { data: { done: boolean; n: number } };
    assert.equal(updated.data.done, true);
    assert.equal(updated.data.n, 8);

    // List
    const listRes = await fetch(`${base}/v1/ci_todos`);
    const list = (await listRes.json()) as { count: number };
    assert.ok(list.count >= 1, "list contains the created doc");

    // Delete
    const delRes = await fetch(`${base}/v1/ci_todos/${created.id}`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(delRes.status, 200);

    // Gone
    const goneRes = await fetch(`${base}/v1/ci_todos/${created.id}`);
    assert.equal(goneRes.status, 404);
    console.log("[integration] delete + 404 verified");

    console.log("\n[integration] PASS — Firestore-backed CRUD works end to end.");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("[integration] FAIL:", err);
  process.exitCode = 1;
});
