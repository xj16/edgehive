/**
 * Test helpers shared by the parity suite.
 *
 * The suite builds the real Hono app against an in-memory store and drives it
 * through `app.fetch(new Request(...))` — the exact same entry path every
 * runtime uses. Because the app is Web-standard, exercising it this way proves
 * the behaviour that Bun, Deno and Node all serve identically. CI additionally
 * boots the app under Node **and** Deno and reruns this suite to confirm parity
 * on real runtimes.
 */

import { createApp } from "../src/core/app.ts";
import { Broadcaster } from "../src/lib/broadcaster.ts";
import { MemoryStore, type Store } from "../src/lib/store.ts";

export interface TestHarness {
  app: ReturnType<typeof createApp>;
  store: Store;
  broadcaster: Broadcaster;
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
}

const BASE = "http://edgehive.test";

export function makeHarness(store: Store = new MemoryStore()): TestHarness {
  const broadcaster = new Broadcaster();
  const app = createApp({ store, broadcaster });

  const request = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`${BASE}${path}`, init)));

  const json = async <T = unknown>(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: T }> => {
    const res = await request(path, init);
    const body = (await res.json()) as T;
    return { status: res.status, body };
  };

  return { app, store, broadcaster, request, json };
}

/** Log in and return a bearer token for use on protected routes. */
export async function login(h: TestHarness, email = "dev@edgehive.test"): Promise<string> {
  const { body } = await h.json<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return body.token;
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}
