/**
 * One-command demo seeder.
 *
 * Populates a running EdgeHive instance with a realistic dataset over HTTP, so
 * you can point the browser client at it and immediately see live data. Runs on
 * any runtime:
 *
 *   node --experimental-strip-types scripts/seed.ts            # seeds localhost:8787
 *   BASE=https://your-instance node --experimental-strip-types scripts/seed.ts
 *
 * It logs in, then creates every document in the shared seed set. Idempotency is
 * best-effort (it just POSTs) — run it against a fresh instance.
 */

import { SEED_DOCS } from "../src/lib/seed.ts";
import { getEnvOr } from "../src/core/runtime.ts";

const base = getEnvOr("BASE", "http://localhost:8787").replace(/\/$/, "");

async function main(): Promise<void> {
  console.log(`[seed] target = ${base}`);

  const loginRes = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "seed@edgehive.dev" }),
  });
  if (!loginRes.ok) throw new Error(`login failed: HTTP ${loginRes.status}`);
  const { token } = (await loginRes.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let written = 0;
  for (const doc of SEED_DOCS) {
    const res = await fetch(`${base}/v1/${doc.collection}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(doc.data),
    });
    if (res.ok) written += 1;
    else console.warn(`[seed] failed to write to ${doc.collection}: HTTP ${res.status}`);
  }

  console.log(`[seed] wrote ${written}/${SEED_DOCS.length} documents.`);
  console.log(`[seed] open ${base}/app to see them live.`);
}

main().catch((err) => {
  console.error("[seed] FAIL:", err);
  const g = globalThis as { process?: { exitCode?: number }; Deno?: { exit(code: number): never } };
  if (g.process) g.process.exitCode = 1;
  else if (g.Deno) g.Deno.exit(1);
});
