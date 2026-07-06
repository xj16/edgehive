/**
 * Realtime / SSE tests.
 *
 * Verifies that a mutation on the store publishes a change event that a live
 * SSE subscriber receives. We consume the streaming `Response` body via its
 * web `ReadableStream` reader — the same API on Bun, Deno and Node.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeHarness, login, authHeaders } from "./helpers.ts";
import { Broadcaster, toSseFrame } from "../src/lib/broadcaster.ts";

test("broadcaster delivers events to subscribers and unsubscribes cleanly", () => {
  const b = new Broadcaster();
  const received: string[] = [];
  const off = b.subscribe("rooms", (e) => received.push(e.id));

  assert.equal(b.subscriberCount("rooms"), 1);
  b.publish({ type: "created", collection: "rooms", id: "a", ts: Date.now() });
  b.publish({ type: "created", collection: "other", id: "z", ts: Date.now() });
  assert.deepEqual(received, ["a"]);

  off();
  assert.equal(b.subscriberCount("rooms"), 0);
  b.publish({ type: "created", collection: "rooms", id: "b", ts: Date.now() });
  assert.deepEqual(received, ["a"], "no events after unsubscribe");
});

test("toSseFrame formats a valid SSE frame", () => {
  const frame = toSseFrame({ type: "created", collection: "c", id: "1", ts: 5 });
  assert.match(frame, /^event: created\n/);
  assert.match(frame, /data: \{.*"id":"1".*\}\n\n$/);
});

test("SSE stream emits a ready event then a change event on create", async () => {
  const h = makeHarness();
  const token = await login(h);

  const res = await h.request("/v1/live/stream");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  // Read the initial "ready" frame.
  const first = await reader.read();
  const readyText = decoder.decode(first.value);
  assert.match(readyText, /event: ready/);

  // Trigger a create; the stream should deliver a "created" frame.
  await h.request("/v1/live", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ msg: "hi" }),
  });

  // Read until we see the created event (skip any heartbeats).
  let sawCreated = false;
  for (let i = 0; i < 5 && !sawCreated; i++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const text = decoder.decode(chunk.value);
    if (/event: created/.test(text)) {
      sawCreated = true;
      assert.match(text, /"msg":"hi"/);
    }
  }
  assert.ok(sawCreated, "should receive a created event over SSE");

  await reader.cancel();
});
