/**
 * Centralised configuration, resolved once from environment variables.
 *
 * EdgeHive talks to Firebase through the local emulator by default, so the
 * defaults here point at the standard emulator ports. In production you would
 * point `FIRESTORE_EMULATOR_HOST` at a real host or swap the store for the
 * Firestore REST/Admin transport — the rest of the app does not care.
 */

import { getEnv, getEnvNumber, getEnvOr } from "./runtime.ts";

export interface EdgeHiveConfig {
  /** Port the HTTP server binds to. */
  port: number;
  /** Firebase project id (matches `.firebaserc` / firebase.json). */
  projectId: string;
  /** `host:port` of the Firestore emulator, e.g. "127.0.0.1:8080". */
  firestoreEmulatorHost: string;
  /** `host:port` of the Auth emulator, e.g. "127.0.0.1:9099". */
  authEmulatorHost: string;
  /** Shared secret used to mint/verify EdgeHive's own dev tokens. */
  authSecret: string;
  /** Whether we are running against the emulator (true) or live Firebase. */
  useEmulator: boolean;
}

let cached: EdgeHiveConfig | null = null;

export function loadConfig(): EdgeHiveConfig {
  if (cached) return cached;

  const firestoreEmulatorHost = getEnvOr("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
  const authEmulatorHost = getEnvOr("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");

  cached = {
    port: getEnvNumber("PORT", 8787),
    projectId: getEnvOr("GCLOUD_PROJECT", getEnvOr("FIREBASE_PROJECT_ID", "edgehive-demo")),
    firestoreEmulatorHost,
    authEmulatorHost,
    authSecret: getEnvOr("EDGEHIVE_AUTH_SECRET", "dev-secret-change-me"),
    // If either emulator host is explicitly set we assume emulator mode; the
    // demo defaults to emulator mode so the project is runnable with zero setup.
    useEmulator: getEnv("EDGEHIVE_USE_EMULATOR") !== "false",
  };

  return cached;
}

/** Reset the memoised config. Only used by tests. */
export function resetConfigForTests(): void {
  cached = null;
}
