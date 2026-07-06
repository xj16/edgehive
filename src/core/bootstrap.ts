/**
 * Shared bootstrap: assemble the app's dependencies (store + broadcaster) and
 * build the Hono app. Every runtime entrypoint calls `buildApp()` so they all
 * share identical wiring — the only per-runtime code lives in the entrypoints.
 */

import { createApp, type AppDeps } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Broadcaster } from "../lib/broadcaster.ts";
import { createStore } from "../lib/store.ts";
import { runtimeLabel } from "./runtime.ts";

export interface BuiltApp {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  port: number;
}

/**
 * Build a ready-to-serve app. Picks the Firestore emulator store when it is
 * reachable, otherwise falls back to the in-memory store.
 */
export async function buildApp(): Promise<BuiltApp> {
  const config = loadConfig();
  const store = await createStore({
    useEmulator: config.useEmulator,
    firestoreEmulatorHost: config.firestoreEmulatorHost,
    projectId: config.projectId,
  });
  const broadcaster = new Broadcaster();
  const deps: AppDeps = { store, broadcaster };
  const app = createApp(deps);

  // eslint-disable-next-line no-console
  console.log(
    `[edgehive] runtime=${runtimeLabel()} store=${store.kind} ` +
      `project=${config.projectId} port=${config.port}`,
  );

  return { app, deps, port: config.port };
}
