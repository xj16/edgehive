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

/**
 * Poll the Firestore emulator's REST endpoint until it answers, logging the
 * raw diagnostic on each miss. The emulator can take a moment after "started"
 * before its REST surface accepts requests, so we retry rather than fail on the
 * first probe.
 */
async function waitForEmulator(host: string, projectId: string, attempts = 30): Promise<void> {
  // Firestore reserves identifiers matching /__.*__/, so use a plain name.
  const url =
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/edgehive_health?pageSize=1`;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { authorization: "Bearer owner" } });
      // Any HTTP answer (even 4xx) proves the emulator is up and routing.
      if (res.status < 500) {
        console.log(`[integration] emulator answered on attempt ${i} (HTTP ${res.status})`);
        return;
      }
      console.log(`[integration] attempt ${i}: HTTP ${res.status}, retrying…`);
    } catch (err) {
      console.log(`[integration] attempt ${i}: ${(err as Error).message}, retrying…`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Firestore emulator at ${host} never became reachable`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Wait for the emulator's REST endpoint to come up before we assert on it.
  await waitForEmulator(config.firestoreEmulatorHost, config.projectId);

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

    // Query path against REAL Firestore: seed a few more, then exercise
    // ordering + filtering + pagination through the :runQuery structuredQuery
    // endpoint (this is the only place the Firestore query transport runs).
    for (const n of [1, 2, 3, 4, 5]) {
      const r = await fetch(`${base}/v1/ci_query`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ n, even: n % 2 === 0 }),
      });
      assert.equal(r.status, 201);
    }
    const orderedRes = await fetch(`${base}/v1/ci_query?orderBy=n&direction=asc&limit=2`);
    const ordered = (await orderedRes.json()) as {
      documents: Array<{ data: { n: number } }>;
      nextPageToken: string | null;
    };
    assert.equal(ordered.documents.length, 2, "limit is honoured");
    assert.deepEqual(
      ordered.documents.map((d) => d.data.n),
      [1, 2],
      "Firestore query orders ascending by n",
    );
    assert.ok(ordered.nextPageToken, "Firestore query returns a next page token");

    const page2Res = await fetch(
      `${base}/v1/ci_query?orderBy=n&direction=asc&limit=2&pageToken=${ordered.nextPageToken}`,
    );
    const page2 = (await page2Res.json()) as { documents: Array<{ data: { n: number } }> };
    assert.deepEqual(page2.documents.map((d) => d.data.n), [3, 4], "pageToken advances the cursor");

    const filteredRes = await fetch(`${base}/v1/ci_query?where=even==true&limit=10`);
    const filtered = (await filteredRes.json()) as { documents: Array<{ data: { even: boolean } }> };
    assert.ok(filtered.documents.length >= 2, "where filter returns the even docs");
    assert.ok(
      filtered.documents.every((d) => d.data.even === true),
      "every filtered doc matches the predicate",
    );
    console.log("[integration] Firestore query (order/filter/paginate) OK");

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
