/**
 * SSE initial-snapshot + observability tests.
 *
 * The stream now delivers `ready` → `snapshot` (the current collection state) →
 * live change events, so a fresh subscriber has state immediately. It also
 * emits a distinct `heartbeat` channel rather than reusing a fake ChangeEvent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeHarness, login, authHeaders } from "./helpers.ts";

async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
): Promise<string> {
  const { value } = await reader.read();
  return decoder.decode(value);
}

test("SSE sends an initial snapshot of existing documents on connect", async () => {
  const h = makeHarness();
  const token = await login(h);

  // Pre-populate the collection BEFORE subscribing.
  for (const title of ["one", "two", "three"]) {
    await h.request("/v1/tasks", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ title }),
    });
  }

  const res = await h.request("/v1/tasks/stream");
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  // Frame 1: ready. Frame 2: snapshot with all three docs.
  const ready = await readFrame(reader, decoder);
  assert.match(ready, /event: ready/);

  let snapshotText = "";
  for (let i = 0; i < 4 && !/event: snapshot/.test(snapshotText); i++) {
    snapshotText = await readFrame(reader, decoder);
  }
  assert.match(snapshotText, /event: snapshot/);
  const dataLine = /data: (\{.*\})/.exec(snapshotText);
  assert.ok(dataLine, "snapshot carries a data payload");
  const snap = JSON.parse(dataLine![1]) as { count: number; documents: unknown[] };
  assert.equal(snap.count, 3, "snapshot contains the pre-existing documents");
  assert.equal(snap.documents.length, 3);

  await reader.cancel();
});

test("SSE snapshot is empty for a brand-new collection but still arrives", async () => {
  const h = makeHarness();
  const res = await h.request("/v1/fresh/stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  let text = "";
  for (let i = 0; i < 4 && !/event: snapshot/.test(text); i++) {
    text = decoder.decode((await reader.read()).value);
  }
  assert.match(text, /event: snapshot/);
  assert.match(text, /"count":0/);
  await reader.cancel();
});

test("/health surfaces perf percentiles and SSE connection count", async () => {
  const h = makeHarness();
  await h.request("/"); // generate at least one measured request
  const { body } = await h.json<{
    perf: { requests: number; p50Ms: number; p95Ms: number; uptimeSeconds: number };
    realtime: { totalSubscribers: number; sseConnections: number };
  }>("/health");
  assert.equal(typeof body.perf.requests, "number");
  assert.ok(body.perf.requests >= 1);
  assert.equal(typeof body.realtime.sseConnections, "number");
});

test("/metrics renders Prometheus exposition with EdgeHive series", async () => {
  const h = makeHarness();
  const token = await login(h);
  await h.request("/v1/m", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ x: 1 }),
  });
  const res = await h.request("/metrics");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const text = await res.text();
  assert.match(text, /edgehive_requests_total/);
  assert.match(text, /edgehive_request_duration_seconds_bucket/);
  assert.match(text, /edgehive_store_info\{kind="memory"\}/);
});

test("every response carries a correlation x-request-id", async () => {
  const h = makeHarness();
  const res = await h.request("/");
  assert.ok(res.headers.get("x-request-id"), "x-request-id is set on responses");
});
