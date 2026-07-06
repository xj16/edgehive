/**
 * End-to-end API tests driving the real Hono app through `app.fetch`.
 * These cover the full CRUD + auth surface that every runtime serves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeHarness, login, authHeaders } from "./helpers.ts";

test("GET / returns the service banner", async () => {
  const h = makeHarness();
  const { status, body } = await h.json<{ name: string; version: string }>("/");
  assert.equal(status, 200);
  assert.equal(body.name, "EdgeHive");
  assert.equal(typeof body.version, "string");
});

test("GET /health reports store + runtime diagnostics", async () => {
  const h = makeHarness();
  const { status, body } = await h.json<{
    status: string;
    store: { kind: string; healthy: boolean };
  }>("/health");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.store.kind, "memory");
  assert.equal(body.store.healthy, true);
});

test("POST /auth/login rejects an invalid email", async () => {
  const h = makeHarness();
  const { status } = await h.json("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  assert.equal(status, 400);
});

test("POST /auth/login mints a token and /auth/me echoes the user", async () => {
  const h = makeHarness();
  const token = await login(h, "alice@edgehive.test");
  assert.ok(token.split(".").length === 3, "token should look like a JWT");

  const { status, body } = await h.json<{ email: string; uid: string }>("/auth/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(status, 200);
  assert.equal(body.email, "alice@edgehive.test");
  assert.ok(body.uid.startsWith("uid_"));
});

test("protected routes reject requests without a token", async () => {
  const h = makeHarness();
  const { status } = await h.json("/v1/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "nope" }),
  });
  assert.equal(status, 401);
});

test("protected routes reject a tampered token", async () => {
  const h = makeHarness();
  const token = await login(h);
  const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
  const { status } = await h.json("/v1/notes", {
    method: "POST",
    headers: authHeaders(tampered),
    body: JSON.stringify({ title: "hax" }),
  });
  assert.equal(status, 401);
});

test("full CRUD lifecycle on a collection", async () => {
  const h = makeHarness();
  const token = await login(h);

  // Create
  const created = await h.json<{ id: string; data: { title: string; done: boolean } }>(
    "/v1/todos",
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ title: "Ship EdgeHive", done: false, priority: 1 }),
    },
  );
  assert.equal(created.status, 201);
  assert.ok(created.body.id.length > 0);
  assert.equal(created.body.data.title, "Ship EdgeHive");
  const id = created.body.id;

  // Read one
  const read = await h.json<{ id: string; data: { priority: number } }>(`/v1/todos/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.priority, 1);

  // List
  const list = await h.json<{ count: number; documents: unknown[] }>("/v1/todos");
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 1);

  // Update (upsert)
  const updated = await h.json<{ data: { done: boolean } }>(`/v1/todos/${id}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify({ title: "Ship EdgeHive", done: true, priority: 2 }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.done, true);

  // Delete
  const deleted = await h.json<{ deleted: boolean }>(`/v1/todos/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);

  // Gone
  const gone = await h.json(`/v1/todos/${id}`);
  assert.equal(gone.status, 404);
});

test("invalid collection names are rejected", async () => {
  const h = makeHarness();
  const { status } = await h.json("/v1/bad%20name!/");
  assert.equal(status, 404); // decoded path won't match the route cleanly
  const bad = await h.json("/v1/" + encodeURIComponent("has space"));
  assert.equal(bad.status, 400);
});

test("mixed value types round-trip through the store", async () => {
  const h = makeHarness();
  const token = await login(h);
  const payload = {
    str: "hello",
    int: 42,
    float: 3.14,
    bool: true,
    nil: null,
    arr: [1, 2, 3],
    nested: { a: 1, b: ["x", "y"] },
  };
  const created = await h.json<{ id: string; data: typeof payload }>("/v1/mixed", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.data, payload);
});
