/**
 * The EdgeHive application — a single Hono app that is byte-for-byte identical
 * across Bun, Deno and Node.
 *
 * Hono is built on the Web-standard `Request`/`Response`, which every target
 * runtime implements natively. That is what makes "write once, run on three
 * runtimes" possible: this file contains ZERO runtime-specific code. The thin
 * per-runtime entrypoints in `/entrypoints` only wire this app into the
 * runtime's server primitive (`Bun.serve`, `Deno.serve`, `@hono/node-server`).
 *
 * Features exposed:
 *   GET    /                      — service banner
 *   GET    /health                — runtime + store + subscriber + latency diagnostics
 *   GET    /metrics               — Prometheus text exposition
 *   GET    /openapi.json          — machine-readable OpenAPI 3 contract
 *   GET    /docs                  — interactive API explorer (Scalar, CDN-free fallback)
 *   GET    /app                   — the bundled realtime browser client
 *   POST   /auth/login            — mint a dev bearer token (Firebase-style)
 *   GET    /auth/me               — echo the authenticated user (protected)
 *   GET    /v1/:col               — list/query documents (limit/pageToken/orderBy/where)
 *   POST   /v1/:col               — create a document (protected)   -> emits `created`
 *   GET    /v1/:col/:id           — fetch one document
 *   PUT    /v1/:col/:id           — upsert a document (protected)   -> emits `updated`
 *   DELETE /v1/:col/:id           — delete a document (protected)   -> emits `deleted`
 *   GET    /v1/:col/stream        — realtime SSE change stream (with initial snapshot)
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

import { loadConfig, type EdgeHiveConfig } from "./config.ts";
import { runtimeLabel, RUNTIME } from "./runtime.ts";
import type { Store } from "../lib/store.ts";
import { Broadcaster, toSseFrame, type ChangeEvent } from "../lib/broadcaster.ts";
import { bearerFromHeader, verifyToken, issueToken, type TokenPayload } from "../lib/auth.ts";
import type { Json } from "../lib/firestore-rest.ts";
import { TokenBucket, ConnectionCounter } from "../lib/ratelimit.ts";
import { Metrics } from "../lib/metrics.ts";
import { parseQueryOptions } from "../lib/query-params.ts";
import { openApiSpec } from "./openapi.ts";
import { DOCS_HTML, CLIENT_HTML } from "./assets.ts";

export interface AppDeps {
  store: Store;
  broadcaster: Broadcaster;
  /** Injected config (defaults to `loadConfig()`); lets tests override limits. */
  config?: EdgeHiveConfig;
  /** Injected metrics registry (defaults to a fresh one). */
  metrics?: Metrics;
}

// Hono context variables we set in middleware.
type Variables = { user: TokenPayload | null; requestId: string };

const VERSION = "0.2.0";

// Collection names are restricted to a safe charset to avoid path/injection
// surprises against the Firestore REST API.
const COLLECTION_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isValidCollection(name: string): boolean {
  // `stream` is a reserved sub-path, not a collection name.
  return COLLECTION_RE.test(name);
}

export function createApp(deps: AppDeps): Hono<{ Variables: Variables }> {
  const config = deps.config ?? loadConfig();
  const { store, broadcaster } = deps;
  const metrics = deps.metrics ?? new Metrics();
  const app = new Hono<{ Variables: Variables }>();

  // Abuse-protection state (per-process; swap for Redis to scale horizontally).
  const writeLimiter = new TokenBucket({
    capacity: config.writeBurst,
    refillPerSecond: config.writeRatePerSec,
  });
  const loginLimiter = new TokenBucket({
    capacity: Math.max(3, config.loginRatePerMin),
    refillPerSecond: config.loginRatePerMin / 60,
  });
  const sseConnections = new ConnectionCounter(config.maxSsePerIp);

  // --- CORS (env-configurable allowlist) ---------------------------------
  const allowAll = config.corsOrigins.includes("*");
  app.use(
    "*",
    cors({
      origin: allowAll ? "*" : config.corsOrigins,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      maxAge: 600,
    }),
  );

  // --- Request id + structured access log + latency metric ----------------
  app.use("*", async (c, next) => {
    const started = Date.now();
    const requestId = c.req.header("x-request-id") ?? randomId();
    c.set("requestId", requestId);
    c.set("user", null);
    c.header("x-request-id", requestId);
    try {
      await next();
    } finally {
      const durMs = Date.now() - started;
      metrics.observeLatency(durMs / 1000);
      const status = c.res.status;
      metrics.inc("edgehive_requests_total", {
        method: c.req.method,
        status: String(status),
      });
      // Single-line structured log (skip the noisy SSE + metrics endpoints).
      const path = new URL(c.req.url).pathname;
      if (path !== "/metrics" && !path.endsWith("/stream")) {
        log("info", {
          msg: "request",
          id: requestId,
          method: c.req.method,
          path,
          status,
          durMs,
          runtime: RUNTIME,
        });
      }
    }
  });

  // --- Auth middleware -----------------------------------------------------
  // `mode: "required"` rejects; `mode: "optional"` attaches the user if present
  // but never blocks — the optional-auth hook the README documents.
  const auth =
    (mode: "required" | "optional"): MiddlewareHandler<{ Variables: Variables }> =>
    async (c, next) => {
      const token = bearerFromHeader(c.req.header("authorization"));
      if (!token) {
        if (mode === "required") return c.json({ error: "missing bearer token" }, 401);
        return next();
      }
      const result = await verifyToken(config.authSecret, token);
      if (!result.ok) {
        if (mode === "required") {
          return c.json({ error: `unauthorized: ${result.reason}` }, 401);
        }
        return next();
      }
      c.set("user", result.payload);
      return next();
    };

  const requireAuth = auth("required");
  // Reads are public by default, but honour `requireAuthForReads` for private APIs.
  const readGuard = config.requireAuthForReads ? auth("required") : auth("optional");

  // --- Rate-limit helpers --------------------------------------------------
  const rateLimit = (
    bucket: TokenBucket,
    routeClass: string,
  ): MiddlewareHandler<{ Variables: Variables }> => {
    return async (c, next) => {
      const ip = clientIp(c.req.raw, c.req.header("x-forwarded-for"));
      const r = bucket.take(`${routeClass}:${ip}`);
      c.header("X-RateLimit-Limit", String(r.limit));
      c.header("X-RateLimit-Remaining", String(Math.max(0, r.remaining)));
      if (!r.ok) {
        metrics.inc("edgehive_rate_limited_total", { route: routeClass });
        c.header("Retry-After", String(r.retryAfter));
        return c.json({ error: "rate limit exceeded", retryAfter: r.retryAfter }, 429);
      }
      return next();
    };
  };

  // --- Service banner -----------------------------------------------------
  app.get("/", (c) =>
    c.json({
      name: "EdgeHive",
      description: "Edge-native realtime API for Bun, Deno & Firebase",
      version: VERSION,
      runtime: runtimeLabel(),
      links: { health: "/health", metrics: "/metrics", docs: "/docs", client: "/app" },
      docs: "https://github.com/xj16/edgehive",
    }),
  );

  // --- Health / diagnostics ----------------------------------------------
  app.get("/health", async (c) => {
    const storeHealthy = await store.healthy();
    const perf = metrics.snapshot();
    return c.json({
      status: "ok",
      runtime: RUNTIME,
      runtimeLabel: runtimeLabel(),
      store: { kind: store.kind, healthy: storeHealthy },
      realtime: {
        totalSubscribers: broadcaster.totalSubscribers(),
        sseConnections: sseConnections.total(),
      },
      perf,
      projectId: config.projectId,
      version: VERSION,
    });
  });

  // --- Prometheus metrics -------------------------------------------------
  app.get("/metrics", (c) => {
    const body = metrics.render({
      subscribers: broadcaster.totalSubscribers(),
      storeKind: store.kind,
    });
    return c.text(body, 200, { "content-type": "text/plain; version=0.0.4" });
  });

  // --- OpenAPI spec + interactive docs + bundled browser client -----------
  app.get("/openapi.json", (c) =>
    c.body(JSON.stringify(openApiSpec(VERSION)), 200, {
      "content-type": "application/json; charset=utf-8",
    }),
  );
  app.get("/docs", (c) => c.html(DOCS_HTML));
  app.get("/app", (c) => c.html(CLIENT_HTML));

  // --- Auth: login (mint dev token) --------------------------------------
  app.post("/auth/login", rateLimit(loginLimiter, "login"), async (c) => {
    const body = await safeJson(c.req.raw, config.maxBodyBytes);
    if (body === "too_large") return c.json({ error: "request body too large" }, 413);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return c.json({ error: "a valid `email` is required" }, 400);
    }
    // Deterministic uid from the email so the same user maps to a stable id.
    const sub = `uid_${await shortHash(email)}`;
    const token = await issueToken(config.authSecret, { sub, email });
    return c.json({ token, tokenType: "Bearer", user: { uid: sub, email } });
  });

  // --- Auth: whoami (protected) ------------------------------------------
  app.get("/auth/me", requireAuth, (c) => {
    const user = c.get("user")!;
    return c.json({ uid: user.sub, email: user.email, exp: user.exp });
  });

  // --- Realtime SSE stream (must be declared before /:col/:id) -----------
  app.get("/v1/:col/stream", readGuard, (c) => {
    const col = c.req.param("col");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }

    // Cap concurrent SSE connections per IP to bound the fan-out surface.
    const ip = clientIp(c.req.raw, c.req.header("x-forwarded-for"));
    const release = sseConnections.acquire(ip);
    if (!release) {
      metrics.inc("edgehive_rate_limited_total", { route: "sse" });
      return c.json(
        { error: "too many concurrent streams from this client", limit: config.maxSsePerIp },
        429,
      );
    }

    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      metrics.inc("edgehive_sse_connections_total");

      // Greet the client so it knows the stream is live.
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ collection: col, ts: Date.now() }),
      });

      // Initial snapshot: replay the current collection so a fresh subscriber
      // immediately has state instead of waiting for the next mutation.
      try {
        // Natural order (Firestore returns documents in name order; the memory
        // store preserves insertion order), capped at 100 for the initial burst.
        const snapshot = await store.query(col, { limit: 100 });
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({
            collection: col,
            count: snapshot.documents.length,
            documents: snapshot.documents,
            ts: Date.now(),
          }),
        });
      } catch {
        // A snapshot failure must not tear down the live stream.
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({ collection: col, count: 0, documents: [], ts: Date.now() }),
        });
      }

      // Queue carries real change events; heartbeats use a distinct sentinel so
      // the internal ChangeEvent model is never overloaded with fake ids.
      type Item = { kind: "event"; event: ChangeEvent } | { kind: "heartbeat"; ts: number };
      const queue: Item[] = [];
      let notify: (() => void) | null = null;

      const unsubscribe = broadcaster.subscribe(col, (event) => {
        queue.push({ kind: "event", event });
        notify?.();
      });

      const heartbeat = setInterval(() => {
        queue.push({ kind: "heartbeat", ts: Date.now() });
        notify?.();
      }, 25_000);
      // Don't let the keep-alive timer hold the process open (Node); harmless
      // no-op on runtimes whose timer handle has no `unref`.
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        release();
      };
      stream.onAbort(cleanup);

      try {
        for (;;) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
          }
          const item = queue.shift();
          if (!item) continue;
          if (item.kind === "heartbeat") {
            await stream.writeSSE({ event: "heartbeat", data: `${item.ts}` });
          } else {
            metrics.inc("edgehive_sse_events_total", { type: item.event.type });
            await stream.writeSSE({
              event: item.event.type,
              data: JSON.stringify(item.event),
            });
          }
        }
      } finally {
        cleanup();
      }
    });
  });

  // --- Collection: list / query ------------------------------------------
  app.get("/v1/:col", readGuard, async (c) => {
    const col = c.req.param("col");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    const parsed = parseQueryOptions(new URL(c.req.url));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const result = await store.query(col, parsed.options);
    return c.json({
      collection: col,
      count: result.documents.length,
      documents: result.documents,
      nextPageToken: result.nextPageToken,
    });
  });

  // --- Collection: create (protected) ------------------------------------
  app.post("/v1/:col", rateLimit(writeLimiter, "write"), requireAuth, async (c) => {
    const col = c.req.param("col");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    const body = await safeJson(c.req.raw, config.maxBodyBytes);
    if (body === "too_large") return c.json({ error: "request body too large" }, 413);
    if (!body || typeof body !== "object") {
      return c.json({ error: "request body must be a JSON object" }, 400);
    }
    const data = body as Record<string, Json>;
    const doc = await store.create(col, data);
    broadcaster.publish({
      type: "created",
      collection: col,
      id: doc.id,
      data: doc.data,
      ts: Date.now(),
    });
    return c.json(doc, 201);
  });

  // --- Document: read ----------------------------------------------------
  app.get("/v1/:col/:id", readGuard, async (c) => {
    const col = c.req.param("col");
    const id = c.req.param("id");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    const doc = await store.get(col, id);
    if (!doc) return c.json({ error: "not found" }, 404);
    return c.json(doc);
  });

  // --- Document: upsert (protected) --------------------------------------
  app.put("/v1/:col/:id", rateLimit(writeLimiter, "write"), requireAuth, async (c) => {
    const col = c.req.param("col");
    const id = c.req.param("id");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    const body = await safeJson(c.req.raw, config.maxBodyBytes);
    if (body === "too_large") return c.json({ error: "request body too large" }, 413);
    if (!body || typeof body !== "object") {
      return c.json({ error: "request body must be a JSON object" }, 400);
    }
    const doc = await store.set(col, id, body as Record<string, Json>);
    broadcaster.publish({
      type: "updated",
      collection: col,
      id: doc.id,
      data: doc.data,
      ts: Date.now(),
    });
    return c.json(doc);
  });

  // --- Document: delete (protected) --------------------------------------
  app.delete("/v1/:col/:id", rateLimit(writeLimiter, "write"), requireAuth, async (c) => {
    const col = c.req.param("col");
    const id = c.req.param("id");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    await store.delete(col, id);
    broadcaster.publish({ type: "deleted", collection: col, id, ts: Date.now() });
    return c.json({ deleted: true, collection: col, id });
  });

  // --- 404 fallback ------------------------------------------------------
  app.notFound((c) => c.json({ error: "route not found" }, 404));

  // --- Error handler -----------------------------------------------------
  app.onError((err, c) => {
    log("error", {
      msg: "unhandled error",
      id: c.get("requestId"),
      error: err instanceof Error ? err.message : String(err),
    });
    metrics.inc("edgehive_errors_total");
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}

// Re-export so entrypoints and tests can build an SSE frame consistently.
export { toSseFrame };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Read and JSON-parse a request body with a hard size cap. Returns:
 *   - the parsed object,
 *   - `null` for non-object / unparseable bodies,
 *   - the sentinel string `"too_large"` when the body exceeds `maxBytes`.
 */
async function safeJson(
  req: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | null | "too_large"> {
  // Fast reject via Content-Length when present.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";

  let text: string;
  try {
    text = await readBodyCapped(req, maxBytes);
  } catch (err) {
    if (err instanceof Error && err.message === "too_large") return "too_large";
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read a request body as text, throwing `too_large` once `maxBytes` is passed. */
async function readBodyCapped(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return await req.text();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("too_large");
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Short, stable hex hash of a string via Web Crypto (SHA-256, first 12 hex). */
async function shortHash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 12);
}

/** A short random id for request correlation. */
function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Best-effort client IP. Honours the leftmost `X-Forwarded-For` entry (set by a
 * trusted proxy) and falls back to a fixed key so limiting still works locally.
 */
function clientIp(req: Request, forwarded: string | undefined | null): string {
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  // Some runtimes expose the remote address on a non-standard property.
  const info = (req as unknown as { socket?: { remoteAddress?: string } }).socket;
  return info?.remoteAddress ?? "local";
}

type LogLevel = "info" | "warn" | "error";
function log(level: LogLevel, fields: Record<string, unknown>): void {
  // Structured single-line JSON — greppable and ready for log shippers.
  const line = JSON.stringify({ level, ts: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
