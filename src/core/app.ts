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
 *   GET    /health                — runtime + store + subscriber diagnostics
 *   POST   /auth/login            — mint a dev bearer token (Firebase-style)
 *   GET    /auth/me               — echo the authenticated user (protected)
 *   GET    /v1/:col               — list documents in a collection
 *   POST   /v1/:col               — create a document (protected)   -> emits `created`
 *   GET    /v1/:col/:id           — fetch one document
 *   PUT    /v1/:col/:id           — upsert a document (protected)   -> emits `updated`
 *   DELETE /v1/:col/:id           — delete a document (protected)   -> emits `deleted`
 *   GET    /v1/:col/stream        — realtime SSE change stream for a collection
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

import { loadConfig } from "./config.ts";
import { runtimeLabel, RUNTIME } from "./runtime.ts";
import type { Store } from "../lib/store.ts";
import { Broadcaster, toSseFrame, type ChangeEvent } from "../lib/broadcaster.ts";
import { bearerFromHeader, issueToken, verifyToken, type TokenPayload } from "../lib/auth.ts";
import type { Json } from "../lib/firestore-rest.ts";

export interface AppDeps {
  store: Store;
  broadcaster: Broadcaster;
}

// Hono context variables we set in middleware.
type Variables = { user: TokenPayload };

const VERSION = "0.1.0";

// Collection names are restricted to a safe charset to avoid path/injection
// surprises against the Firestore REST API.
const COLLECTION_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isValidCollection(name: string): boolean {
  // `stream` is a reserved sub-path, not a collection name.
  return COLLECTION_RE.test(name);
}

export function createApp(deps: AppDeps): Hono<{ Variables: Variables }> {
  const config = loadConfig();
  const { store, broadcaster } = deps;
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", cors());

  // --- Auth middleware (applied selectively below) ------------------------
  const requireAuth: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const token = bearerFromHeader(c.req.header("authorization"));
    if (!token) {
      return c.json({ error: "missing bearer token" }, 401);
    }
    const result = await verifyToken(config.authSecret, token);
    if (!result.ok) {
      return c.json({ error: `unauthorized: ${result.reason}` }, 401);
    }
    c.set("user", result.payload);
    await next();
  };

  // --- Service banner -----------------------------------------------------
  app.get("/", (c) =>
    c.json({
      name: "EdgeHive",
      description: "Edge-native realtime API for Bun, Deno & Firebase",
      version: VERSION,
      runtime: runtimeLabel(),
      docs: "https://github.com/xj16/edgehive",
    }),
  );

  // --- Health / diagnostics ----------------------------------------------
  app.get("/health", async (c) => {
    const storeHealthy = await store.healthy();
    return c.json({
      status: "ok",
      runtime: RUNTIME,
      runtimeLabel: runtimeLabel(),
      store: {
        kind: store.kind,
        healthy: storeHealthy,
      },
      realtime: {
        totalSubscribers: broadcaster.totalSubscribers(),
      },
      projectId: config.projectId,
      version: VERSION,
    });
  });

  // --- Auth: login (mint dev token) --------------------------------------
  app.post("/auth/login", async (c) => {
    const body = await safeJson(c.req.raw);
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
    const user = c.get("user");
    return c.json({ uid: user.sub, email: user.email, exp: user.exp });
  });

  // --- Realtime SSE stream (must be declared before /:col/:id) -----------
  app.get("/v1/:col/stream", (c) => {
    const col = c.req.param("col");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      // Greet the client so it knows the stream is live.
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ collection: col, ts: Date.now() }),
      });

      const queue: ChangeEvent[] = [];
      let notify: (() => void) | null = null;

      const unsubscribe = broadcaster.subscribe(col, (event) => {
        queue.push(event);
        notify?.();
      });

      // Heartbeat keeps proxies from closing an idle connection.
      const heartbeat = setInterval(() => {
        queue.push({ type: "updated", collection: col, id: "__heartbeat__", ts: Date.now() });
        notify?.();
      }, 25_000);

      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      try {
        // Drain the queue forever; block until a new event arrives.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
          }
          const event = queue.shift();
          if (!event) continue;
          if (event.id === "__heartbeat__") {
            await stream.writeSSE({ event: "heartbeat", data: `${event.ts}` });
          } else {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  // --- Collection: list --------------------------------------------------
  app.get("/v1/:col", async (c) => {
    const col = c.req.param("col");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    const docs = await store.list(col);
    return c.json({ collection: col, count: docs.length, documents: docs });
  });

  // --- Collection: create (protected) ------------------------------------
  app.post("/v1/:col", requireAuth, async (c) => {
    const col = c.req.param("col");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    const body = await safeJson(c.req.raw);
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
  app.get("/v1/:col/:id", async (c) => {
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
  app.put("/v1/:col/:id", requireAuth, async (c) => {
    const col = c.req.param("col");
    const id = c.req.param("id");
    if (!isValidCollection(col)) {
      return c.json({ error: "invalid collection name" }, 400);
    }
    const body = await safeJson(c.req.raw);
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
  app.delete("/v1/:col/:id", requireAuth, async (c) => {
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
    console.error("[edgehive] unhandled error:", err);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}

// Re-export so entrypoints and tests can build an SSE frame consistently.
export { toSseFrame };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await req.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
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
