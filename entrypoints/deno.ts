/**
 * Deno entrypoint.
 *
 * `Deno.serve` also speaks the Web-standard `Request`/`Response` contract, so
 * the Hono app plugs straight in.
 *
 * Run with:  deno run --allow-net --allow-env entrypoints/deno.ts
 */

import { buildApp } from "../src/core/bootstrap.ts";

// Structural declaration so this file type-checks under Node's tsc too.
declare const Deno: {
  serve(
    options: { port: number },
    handler: (req: Request) => Response | Promise<Response>,
  ): unknown;
};

const { app, port } = await buildApp();

Deno.serve({ port }, (req: Request) => app.fetch(req));

// eslint-disable-next-line no-console
console.log(`[edgehive] Deno server listening on http://localhost:${port}`);
