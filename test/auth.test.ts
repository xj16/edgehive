/**
 * Auth token unit tests — exercises the runtime-agnostic HMAC token layer
 * directly (independent of the HTTP surface).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { issueToken, verifyToken, bearerFromHeader } from "../src/lib/auth.ts";

const SECRET = "unit-test-secret";

test("issueToken produces a verifiable token", async () => {
  const token = await issueToken(SECRET, { sub: "uid_1", email: "a@b.co" });
  const result = await verifyToken(SECRET, token);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.payload.sub, "uid_1");
    assert.equal(result.payload.email, "a@b.co");
  }
});

test("verifyToken rejects a wrong secret", async () => {
  const token = await issueToken(SECRET, { sub: "uid_1", email: "a@b.co" });
  const result = await verifyToken("other-secret", token);
  assert.equal(result.ok, false);
});

test("verifyToken rejects a malformed token", async () => {
  const result = await verifyToken(SECRET, "not.a.valid.token.here");
  assert.equal(result.ok, false);
});

test("verifyToken rejects an expired token", async () => {
  const token = await issueToken(SECRET, { sub: "u", email: "a@b.co" }, -1);
  const result = await verifyToken(SECRET, token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /expired/);
});

test("bearerFromHeader parses the Authorization header", () => {
  assert.equal(bearerFromHeader("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerFromHeader("bearer xyz"), "xyz");
  assert.equal(bearerFromHeader("Basic abc"), null);
  assert.equal(bearerFromHeader(undefined), null);
  assert.equal(bearerFromHeader(""), null);
});
