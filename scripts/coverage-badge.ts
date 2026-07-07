/**
 * Generate a coverage badge from Node's built-in test-coverage report.
 *
 * Runs the coverage suite, parses the `all files` line percentage out of the
 * native coverage table, and writes a shields.io "endpoint" JSON to
 * `.github/badges/coverage.json`. The README references that file via
 * shields.io's `endpoint` badge, so the badge updates whenever CI regenerates
 * and commits the file.
 *
 * Zero dependencies; runs on any runtime. Exits non-zero if it can't parse a
 * percentage so a broken coverage run can't silently ship a stale badge.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function runCoverage(): string {
  const res = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--experimental-test-coverage",
      "--test-coverage-exclude=test/**",
      "--test-coverage-exclude=scripts/**",
      "--test-coverage-exclude=src/core/openapi.ts",
      "--test-coverage-exclude=src/core/assets.ts",
      "--test",
      ...globTests(),
    ],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
  );
  return (res.stdout ?? "") + (res.stderr ?? "");
}

function globTests(): string[] {
  // The suite is a fixed, small set; list explicitly to avoid a glob dep.
  return [
    "test/api.test.ts",
    "test/auth.test.ts",
    "test/firestore-rest.test.ts",
    "test/query.test.ts",
    "test/realtime.test.ts",
    "test/security.test.ts",
    "test/sse-snapshot.test.ts",
    "test/store.test.ts",
  ];
}

function parseLinePct(output: string): number {
  // e.g. "# all files                |  87.77 |    82.94 |   91.82 |"
  const m = /all files\s*\|\s*([\d.]+)\s*\|/.exec(output);
  if (!m) throw new Error("could not find the 'all files' coverage line");
  return Number(m[1]);
}

function color(pct: number): string {
  if (pct >= 90) return "brightgreen";
  if (pct >= 80) return "green";
  if (pct >= 70) return "yellowgreen";
  if (pct >= 60) return "yellow";
  return "red";
}

function main(): void {
  const output = runCoverage();
  const pct = parseLinePct(output);
  const rounded = Math.round(pct * 10) / 10;

  const badge = {
    schemaVersion: 1,
    label: "coverage",
    message: `${rounded}%`,
    color: color(pct),
  };

  const outDir = join(repoRoot, ".github", "badges");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "coverage.json"), JSON.stringify(badge, null, 2) + "\n");

  console.log(`[coverage-badge] line coverage ${rounded}% -> .github/badges/coverage.json`);
}

main();
