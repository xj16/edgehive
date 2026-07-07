/**
 * Query-layer parity tests: pagination, ordering and field filters over the
 * public `GET /v1/:col` endpoint.
 *
 * These run against the in-memory store (which mirrors Firestore's
 * order/filter/offset semantics). The Firestore transport is separately covered
 * by the emulator integration job, so both stores are exercised end to end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeHarness, login, authHeaders } from "./helpers.ts";
import { parseQueryOptions } from "../src/lib/query-params.ts";

interface ListResp {
  count: number;
  documents: Array<{ id: string; data: Record<string, unknown> }>;
  nextPageToken: string | null;
}

async function seed(h: ReturnType<typeof makeHarness>, token: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await h.request("/v1/items", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ i, even: i % 2 === 0, name: `item-${i}` }),
    });
    assert.equal(res.status, 201);
  }
}

test("query: limit + pageToken paginate deterministically with no overlap", async () => {
  const h = makeHarness();
  const token = await login(h);
  await seed(h, token, 25);

  const seen = new Set<string>();
  let pageToken: string | null = null;
  let pages = 0;

  do {
    const url: string =
      "/v1/items?limit=10&orderBy=i&direction=asc" +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const { status, body } = await h.json<ListResp>(url);
    assert.equal(status, 200);
    assert.ok(body.documents.length <= 10);
    for (const doc of body.documents) {
      assert.ok(!seen.has(doc.id), "no document appears on two pages");
      seen.add(doc.id);
    }
    pageToken = body.nextPageToken;
    pages += 1;
    assert.ok(pages <= 5, "pagination terminates");
  } while (pageToken);

  assert.equal(seen.size, 25, "every document is returned exactly once across pages");
  assert.equal(pages, 3, "25 items at limit 10 => 3 pages");
});

test("query: orderBy ascending and descending are honoured", async () => {
  const h = makeHarness();
  const token = await login(h);
  await seed(h, token, 5);

  const asc = await h.json<ListResp>("/v1/items?orderBy=i&direction=asc&limit=5");
  const ascVals = asc.body.documents.map((d) => d.data.i);
  assert.deepEqual(ascVals, [0, 1, 2, 3, 4]);

  const desc = await h.json<ListResp>("/v1/items?orderBy=-i&limit=5");
  const descVals = desc.body.documents.map((d) => d.data.i);
  assert.deepEqual(descVals, [4, 3, 2, 1, 0]);
});

test("query: where filters (equality + comparison) narrow the result set", async () => {
  const h = makeHarness();
  const token = await login(h);
  await seed(h, token, 10);

  const evens = await h.json<ListResp>("/v1/items?where=even==true&limit=100");
  assert.equal(evens.body.count, 5);
  assert.ok(evens.body.documents.every((d) => d.data.even === true));

  const gte = await h.json<ListResp>("/v1/items?where=i>=7&orderBy=i&direction=asc&limit=100");
  assert.deepEqual(gte.body.documents.map((d) => d.data.i), [7, 8, 9]);

  const combined = await h.json<ListResp>(
    "/v1/items?where=even==true&where=i>4&orderBy=i&direction=asc&limit=100",
  );
  assert.deepEqual(combined.body.documents.map((d) => d.data.i), [6, 8]);
});

test("query: default limit caps a large collection and exposes a next page", async () => {
  const h = makeHarness();
  const token = await login(h);
  await seed(h, token, 30);
  const { body } = await h.json<ListResp>("/v1/items");
  assert.equal(body.count, 25, "default page size is 25");
  assert.ok(body.nextPageToken, "a next page token is returned when more remain");
});

test("query: invalid parameters are rejected with 400", async () => {
  const h = makeHarness();
  for (const q of ["?limit=0", "?limit=1000", "?limit=abc", "?direction=sideways", "?where=bogus"]) {
    const { status } = await h.json(`/v1/items${q}`);
    assert.equal(status, 400, `${q} should be a 400`);
  }
});

test("parseQueryOptions: unit-level parsing of the query string", () => {
  const url = new URL("http://x/v1/c?limit=5&orderBy=-priority&where=done==false&where=n>=2");
  const r = parseQueryOptions(url);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.options.limit, 5);
    assert.equal(r.options.orderBy, "priority");
    assert.equal(r.options.direction, "desc");
    assert.deepEqual(r.options.where, [
      { field: "done", op: "==", value: false },
      { field: "n", op: ">=", value: 2 },
    ]);
  }
});
