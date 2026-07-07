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

  // --- Security / limits ---------------------------------------------------
  /**
   * Allowed CORS origins. `["*"]` (the default) allows any origin — fine for a
   * public read API, but set an explicit allowlist in production.
   */
  corsOrigins: string[];
  /** Max JSON request body size in bytes (writes + login). */
  maxBodyBytes: number;
  /** Sustained writes/sec per IP (token-bucket refill rate). */
  writeRatePerSec: number;
  /** Write burst size per IP (token-bucket capacity). */
  writeBurst: number;
  /** Login attempts/min per IP. */
  loginRatePerMin: number;
  /** Max concurrent SSE subscriptions from a single IP. */
  maxSsePerIp: number;
  /**
   * When set, ALL routes (including reads) require a valid bearer token. Off by
   * default so the public read feed stays public; flip on for a private API.
   */
  requireAuthForReads: boolean;

  // --- Demo mode -----------------------------------------------------------
  /** When true, the app self-seeds a realistic dataset on boot. */
  demoMode: boolean;
}

let cached: EdgeHiveConfig | null = null;

export function loadConfig(): EdgeHiveConfig {
  if (cached) return cached;

  const firestoreEmulatorHost = getEnvOr("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
  const authEmulatorHost = getEnvOr("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");

  const corsRaw = getEnvOr("EDGEHIVE_CORS_ORIGINS", "*");
  const corsOrigins = corsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  cached = {
    port: getEnvNumber("PORT", 8787),
    projectId: getEnvOr("GCLOUD_PROJECT", getEnvOr("FIREBASE_PROJECT_ID", "edgehive-demo")),
    firestoreEmulatorHost,
    authEmulatorHost,
    authSecret: getEnvOr("EDGEHIVE_AUTH_SECRET", "dev-secret-change-me"),
    // If either emulator host is explicitly set we assume emulator mode; the
    // demo defaults to emulator mode so the project is runnable with zero setup.
    useEmulator: getEnv("EDGEHIVE_USE_EMULATOR") !== "false",

    corsOrigins: corsOrigins.length > 0 ? corsOrigins : ["*"],
    maxBodyBytes: getEnvNumber("EDGEHIVE_MAX_BODY_BYTES", 64 * 1024),
    writeRatePerSec: getEnvNumber("EDGEHIVE_WRITE_RATE_PER_SEC", 20),
    writeBurst: getEnvNumber("EDGEHIVE_WRITE_BURST", 40),
    loginRatePerMin: getEnvNumber("EDGEHIVE_LOGIN_RATE_PER_MIN", 10),
    maxSsePerIp: getEnvNumber("EDGEHIVE_MAX_SSE_PER_IP", 20),
    requireAuthForReads: getEnv("EDGEHIVE_REQUIRE_AUTH_FOR_READS") === "true",

    demoMode: getEnv("EDGEHIVE_DEMO") === "true" || getEnv("EDGEHIVE_DEMO") === "1",
  };

  return cached;
}

/** Reset the memoised config. Only used by tests. */
export function resetConfigForTests(): void {
  cached = null;
}
