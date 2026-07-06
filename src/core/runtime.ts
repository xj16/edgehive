/**
 * Runtime detection & environment abstraction.
 *
 * EdgeHive targets three JavaScript runtimes with one codebase:
 *   - Bun     (uses `Bun.env`, `Bun.serve`)
 *   - Deno    (uses `Deno.env`, `Deno.serve`)
 *   - Node.js (uses `process.env`, `@hono/node-server`)
 *
 * This module gives the rest of the app a single, typed way to read env vars
 * and identify the current runtime without sprinkling `typeof Deno` checks
 * everywhere. Every access is written to type-check cleanly under Node's
 * TypeScript, where `Deno` and `Bun` are not part of the global lib.
 */

// Minimal structural declarations so `tsc` (Node types only) is happy when we
// reference the Bun/Deno globals. These are intentionally loose — they only
// describe the surface EdgeHive actually touches.
declare const Deno:
  | {
      env: { get(key: string): string | undefined; toObject(): Record<string, string> };
      serve: (...args: unknown[]) => unknown;
    }
  | undefined;

declare const Bun:
  | {
      env: Record<string, string | undefined>;
      serve: (...args: unknown[]) => unknown;
    }
  | undefined;

export type RuntimeName = "bun" | "deno" | "node" | "unknown";

/**
 * Detect the current runtime. Order matters: Bun also exposes a `process`
 * shim, so we must check `Bun` before falling through to Node.
 */
export function detectRuntime(): RuntimeName {
  if (typeof Deno !== "undefined" && Deno !== null) return "deno";
  if (typeof Bun !== "undefined" && Bun !== null) return "bun";
  if (typeof process !== "undefined" && process.versions?.node) return "node";
  return "unknown";
}

export const RUNTIME: RuntimeName = detectRuntime();

/**
 * Read an environment variable in a runtime-agnostic way.
 * Returns `undefined` when the variable is unset on every runtime.
 */
export function getEnv(key: string): string | undefined {
  switch (RUNTIME) {
    case "deno":
      return Deno?.env.get(key);
    case "bun":
      return Bun?.env[key];
    case "node":
      return typeof process !== "undefined" ? process.env[key] : undefined;
    default:
      // Best-effort: try process if it happens to exist.
      return typeof process !== "undefined" ? process.env[key] : undefined;
  }
}

/**
 * Read an env var with a fallback default.
 */
export function getEnvOr(key: string, fallback: string): string {
  const v = getEnv(key);
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Read a numeric env var with a fallback default.
 */
export function getEnvNumber(key: string, fallback: number): number {
  const raw = getEnv(key);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A short, human-readable description of the runtime, e.g. "node v22.22.3".
 * Used in the health endpoint so you can eyeball which runtime served a request.
 */
export function runtimeLabel(): string {
  switch (RUNTIME) {
    case "node":
      return `node ${typeof process !== "undefined" ? process.version : ""}`.trim();
    case "bun":
      return "bun";
    case "deno":
      return "deno";
    default:
      return "unknown";
  }
}
