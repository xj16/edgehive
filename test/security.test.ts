/**
 * Abuse-protection tests: rate limiting, body-size cap, SSE per-IP connection
 * cap, and the optional-auth-for-reads hook. These cover the two unbounded
 * surfaces (public writes + the unauthenticated stream) that were the headline
 * security gaps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeHarness, login, authHeaders } from "./helpers.ts";
import { TokenBucket, ConnectionCounter } from "../src/lib/ratelimit.ts";

test("write rate limiting returns 429 with Retry-After once the burst is spent", async () => {
  // Tiny bucket: capacity 3, ~no refill within the test window.
  const h = makeHarness(undefined, { writeBurst: 3, writeRatePerSec: 0.001 });
  const token = await login(h);

  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await h.request("/v1/things", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ n: i }),
    });
    statuses.push(res.status);
    if (res.status === 429) {
      assert.ok(res.headers.get("retry-after"), "429 carries Retry-After");
    }
  }
  assert.ok(statuses.filter((s) => s === 201).length <= 3, "no more than burst succeed");
  assert.ok(statuses.includes(429), "some writes are rate limited");
});

test("login rate limiting throttles credential-stuffing style bursts", async () => {
  const h = makeHarness(undefined, { loginRatePerMin: 3 });
  let limited = false;
  for (let i = 0; i < 8; i++) {
    const res = await h.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "burst@edgehive.test" }),
    });
    if (res.status === 429) limited = true;
  }
  assert.ok(limited, "login is rate limited after the burst");
});

test("oversized request bodies are rejected with 413", async () => {
  const h = makeHarness(undefined, { maxBodyBytes: 256 });
  const token = await login(h);
  const big = { blob: "x".repeat(1024) };
  const res = await h.request("/v1/things", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(big),
  });
  assert.equal(res.status, 413);
});

test("SSE connections are capped per IP (429 past the limit)", async () => {
  const h = makeHarness(undefined, { maxSsePerIp: 2 });
  const ip = { "x-forwarded-for": "203.0.113.7" };

  const a = await h.request("/v1/room/stream", { headers: ip });
  const b = await h.request("/v1/room/stream", { headers: ip });
  const c = await h.request("/v1/room/stream", { headers: ip });

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 429, "third concurrent stream from the same IP is rejected");

  await a.body?.cancel();
  await b.body?.cancel();
});

test("requireAuthForReads makes the public read feed private", async () => {
  const h = makeHarness(undefined, { requireAuthForReads: true });
  const anon = await h.request("/v1/secret");
  assert.equal(anon.status, 401, "reads require a token when the hook is on");

  const token = await login(h);
  const authed = await h.request("/v1/secret", { headers: authHeaders(token) });
  assert.equal(authed.status, 200, "a valid token unlocks reads");
});

test("TokenBucket: refills continuously and enforces capacity", () => {
  let now = 1_000_000;
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, () => now);

  assert.equal(bucket.take("k").ok, true);
  assert.equal(bucket.take("k").ok, true);
  const denied = bucket.take("k");
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfter >= 1);

  now += 1000; // one second => one token back
  assert.equal(bucket.take("k").ok, true);
  assert.equal(bucket.take("k").ok, false);
});

test("ConnectionCounter: caps concurrency and releases cleanly", () => {
  const cc = new ConnectionCounter(2);
  const r1 = cc.acquire("ip");
  const r2 = cc.acquire("ip");
  assert.ok(r1 && r2);
  assert.equal(cc.acquire("ip"), null, "third acquire is refused");
  r1!();
  assert.ok(cc.acquire("ip"), "a slot frees up after release");
  assert.equal(cc.count("ip"), 2);
});
