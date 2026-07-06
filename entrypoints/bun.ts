/**
 * Bun entrypoint.
 *
 * `Bun.serve` accepts an object with a `fetch` handler that receives a
 * Web-standard `Request` and returns a `Response` — exactly Hono's `fetch`
 * signature — so wiring is a one-liner.
 *
 * Run with:  bun run entrypoints/bun.ts
 */

import { buildApp } from "../src/core/bootstrap.ts";

// Structural declaration so this file also type-checks under Node's tsc, where
// the `Bun` global is not part of the standard lib.
declare const Bun: {
  serve(options: { port: number; fetch: (req: Request) => Response | Promise<Response> }): {
    port: number;
  };
};

const { app, port } = await buildApp();

const server = Bun.serve({
  port,
  fetch: (req: Request) => app.fetch(req),
});

// eslint-disable-next-line no-console
console.log(`[edgehive] Bun server listening on http://localhost:${server.port}`);
