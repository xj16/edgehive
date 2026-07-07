/**
 * Shared bootstrap: assemble the app's dependencies (store + broadcaster) and
 * build the Hono app. Every runtime entrypoint calls `buildApp()` so they all
 * share identical wiring — the only per-runtime code lives in the entrypoints.
 */

import { createApp, type AppDeps } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Broadcaster } from "../lib/broadcaster.ts";
import { createStore } from "../lib/store.ts";
import { Metrics } from "../lib/metrics.ts";
import { seedDemoData } from "../lib/seed.ts";
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
  const metrics = new Metrics();
  const deps: AppDeps = { store, broadcaster, config, metrics };
  const app = createApp(deps);

  // Demo mode: land visitors on an already-populated instance.
  if (config.demoMode) {
    const written = await seedDemoData(store);
    console.log(
      JSON.stringify({
        level: "info",
        ts: new Date().toISOString(),
        msg: "demo seed",
        written,
      }),
    );
  }

  console.log(
    `[edgehive] runtime=${runtimeLabel()} store=${store.kind} ` +
      `project=${config.projectId} port=${config.port} ` +
      `demo=${config.demoMode} cors=${config.corsOrigins.join("|")}`,
  );

  return { app, deps, port: config.port };
}
