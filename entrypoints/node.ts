/**
 * Node.js entrypoint.
 *
 * Node's built-in HTTP server predates the Web `Request`/`Response` API, so we
 * use `@hono/node-server`, the official adapter that bridges Node's
 * `IncomingMessage`/`ServerResponse` to Hono's Web-standard handler. The app
 * itself is unchanged — only the serving glue differs from Bun/Deno.
 *
 * Run with:  node --experimental-strip-types entrypoints/node.ts
 * (Node 22 can execute TypeScript directly via type stripping.)
 */

import { serve } from "@hono/node-server";
import { buildApp } from "../src/core/bootstrap.ts";

const { app, port } = await buildApp();

serve({ fetch: app.fetch, port }, (info: { port: number }) => {
  // eslint-disable-next-line no-console
  console.log(`[edgehive] Node server listening on http://localhost:${info.port}`);
});
