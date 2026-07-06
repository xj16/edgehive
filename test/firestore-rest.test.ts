/**
 * FirestoreStore wiring tests.
 *
 * We drive `FirestoreStore` with an injected `fetch` that emulates the
 * Firestore emulator's REST responses. This proves the store issues the correct
 * HTTP verbs/paths and decodes the typed-value payloads correctly — without a
 * live emulator. CI additionally runs the full suite against a real emulator.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { FirestoreStore } from "../src/lib/store.ts";
import { objectToFields } from "../src/lib/firestore-rest.ts";

const PROJECT = "edgehive-test";
const HOST = "127.0.0.1:8080";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Build a fake fetch that records calls and returns canned Firestore docs. */
function fakeFetch(handler: (call: Call) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status, json } = handler(call);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("FirestoreStore.create POSTs typed fields and decodes the response", async () => {
  const { impl, calls } = fakeFetch((call) => {
    assert.equal(call.method, "POST");
    assert.match(call.url, /\/documents\/todos$/);
    // Echo back a document with a server-assigned name.
    return {
      status: 200,
      json: {
        name: `projects/${PROJECT}/databases/(default)/documents/todos/generated123`,
        fields: (call.body as { fields: unknown }).fields,
        createTime: "2026-01-01T00:00:00Z",
        updateTime: "2026-01-01T00:00:00Z",
      },
    };
  });

  const store = new FirestoreStore(HOST, PROJECT, impl);
  const doc = await store.create("todos", { title: "buy milk", done: false });

  assert.equal(doc.id, "generated123");
  assert.deepEqual(doc.data, { title: "buy milk", done: false });
  assert.equal(calls.length, 1);
});

test("FirestoreStore.get returns null on 404", async () => {
  const { impl } = fakeFetch(() => ({ status: 404, json: { error: { status: "NOT_FOUND" } } }));
  const store = new FirestoreStore(HOST, PROJECT, impl);
  assert.equal(await store.get("todos", "missing"), null);
});

test("FirestoreStore.get decodes an existing document", async () => {
  const { impl } = fakeFetch(() => ({
    status: 200,
    json: {
      name: `projects/${PROJECT}/databases/(default)/documents/todos/abc`,
      fields: objectToFields({ title: "hi", count: 5 }),
    },
  }));
  const store = new FirestoreStore(HOST, PROJECT, impl);
  const doc = await store.get("todos", "abc");
  assert.ok(doc);
  assert.equal(doc!.id, "abc");
  assert.deepEqual(doc!.data, { title: "hi", count: 5 });
});

test("FirestoreStore.list maps a documents array", async () => {
  const { impl } = fakeFetch(() => ({
    status: 200,
    json: {
      documents: [
        {
          name: `projects/${PROJECT}/databases/(default)/documents/c/one`,
          fields: objectToFields({ n: 1 }),
        },
        {
          name: `projects/${PROJECT}/databases/(default)/documents/c/two`,
          fields: objectToFields({ n: 2 }),
        },
      ],
    },
  }));
  const store = new FirestoreStore(HOST, PROJECT, impl);
  const docs = await store.list("c");
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.id).sort(), ["one", "two"]);
});

test("FirestoreStore.delete tolerates a 404 (idempotent)", async () => {
  const { impl, calls } = fakeFetch((call) => {
    assert.equal(call.method, "DELETE");
    return { status: 404, json: {} };
  });
  const store = new FirestoreStore(HOST, PROJECT, impl);
  await store.delete("c", "gone"); // must not throw
  assert.equal(calls.length, 1);
});

test("FirestoreStore.healthy returns true when the emulator answers", async () => {
  const { impl } = fakeFetch(() => ({ status: 200, json: { documents: [] } }));
  const store = new FirestoreStore(HOST, PROJECT, impl);
  assert.equal(await store.healthy(), true);
});

test("FirestoreStore.healthy returns false when the emulator is down", async () => {
  const impl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const store = new FirestoreStore(HOST, PROJECT, impl);
  assert.equal(await store.healthy(), false);
});
