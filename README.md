# EdgeHive

**Edge-native realtime API for Bun, Deno & Firebase.**

EdgeHive is a small, production-shaped realtime backend starter. You write your
handlers **once**, and the exact same code serves requests on **Bun**, **Deno**
and **Node.js** — because everything is built on the Web-standard
`Request`/`Response` contract via [Hono](https://hono.dev). Data is persisted in
**Firestore** (through the Firebase emulator by default), realtime change events
are pushed to clients over **Server-Sent Events**, and a lightweight
HMAC-signed bearer-token layer guards writes.

No paid keys. No cloud account required to run it. `npm install` and go.

[![CI](https://github.com/xj16/edgehive/actions/workflows/ci.yml/badge.svg)](https://github.com/xj16/edgehive/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Runtimes: Bun · Deno · Node](https://img.shields.io/badge/runtimes-Bun%20%C2%B7%20Deno%20%C2%B7%20Node-black)

---

## Why

Most "serverless" starters lock you into one runtime and one hosting provider.
The interesting edge platforms (Bun, Deno Deploy, Cloudflare-style workers) all
converge on the **same Web-standard primitives**, so there's no good reason your
backend code should care which one it runs on.

EdgeHive proves the point: **one handler layer, three runtimes, zero
runtime-specific branches in your business logic.** The only per-runtime code is
a ~10-line entrypoint that hands the app to the runtime's HTTP server. Everything
else — routing, auth, storage, realtime — is shared and identical, and a parity
test suite runs on all three runtimes in CI to keep it honest.

It's also a genuinely useful base for a small realtime app: a public read feed
with authenticated writes and live updates, backed by Firestore.

## Features

- **Runtime-agnostic handler layer** — one Hono app served identically on Bun,
  Deno and Node. The per-runtime entrypoints are the only place any runtime
  global appears.
- **Realtime over SSE** — subscribe to a collection and receive `created`,
  `updated` and `deleted` events live, with heartbeats to keep connections open.
- **Firestore-backed** — a dependency-free Firestore REST client (works on every
  runtime; the Admin SDK does not) talks to the Firebase emulator. Auth +
  Firestore emulator config included.
- **Graceful in-memory fallback** — if the emulator isn't running, EdgeHive
  transparently falls back to an in-process store with identical semantics, so
  the API (and its tests) run with **zero setup**.
- **Auth built in** — `POST /auth/login` mints a compact HMAC-signed token using
  the Web Crypto API (no native deps). Writes require a valid bearer token.
- **Type-safe everywhere** — strict TypeScript that type-checks under Node's
  `tsc` while still running unmodified on Bun and Deno.
- **Parity test suite** — CRUD, auth, realtime and the Firestore codec, all
  green on Node, Bun and Deno in CI, plus a real Firestore-emulator integration
  job.
- **Batteries included** — Postman collection, `.env.example`, a zero-dependency
  browser demo client, and a CLI demo script.

## Tech stack

| Area          | Choice                                                        |
| ------------- | ------------------------------------------------------------ |
| Language      | **TypeScript** (strict, erasable-syntax only)                |
| HTTP layer    | **Hono** (Web-standard `Request`/`Response`)                 |
| Runtimes      | **Bun**, **Deno**, **Node.js 20/22**                         |
| Data          | **Firebase** Firestore (via emulator) + REST client          |
| Auth          | Firebase Auth emulator concept + Web Crypto HMAC dev tokens  |
| Realtime      | Server-Sent Events (SSE)                                      |
| Infra / cloud | **Google Cloud** / Firebase project model, **GitHub Actions**|

## Architecture

```
                       ┌──────────────────────────────────────────┐
   entrypoints/        │            src/core/app.ts               │
   ─────────────       │   (one Hono app — NO runtime-specific     │
   bun.ts   ─┐         │    code; pure Request → Response)         │
   deno.ts  ─┼──▶ buildApp() ──▶  routes ── auth ── SSE stream     │
   node.ts  ─┘         └───────────────┬───────────────┬──────────┘
                                       │               │
                              src/lib/store.ts   src/lib/broadcaster.ts
                                       │            (in-proc pub/sub → SSE)
                         ┌─────────────┴─────────────┐
                         │                           │
                 FirestoreStore                 MemoryStore
              (REST → Firebase emulator)     (zero-setup fallback)
```

The app depends only on a `Store` interface and a `Broadcaster`. Swapping the
backend (Redis pub/sub, real Firestore listeners, Postgres) is a localized
change that never touches your routes.

## Quick start

```bash
git clone https://github.com/xj16/edgehive
cd edgehive
npm install
```

### Run it (any runtime)

```bash
# Node 22 (runs TypeScript directly via type-stripping)
npm run dev:node

# Bun
npm run dev:bun        # or: bun run entrypoints/bun.ts

# Deno
npm run dev:deno       # or: deno task dev
```

Then, in another terminal:

```bash
# Health + which runtime served it
curl localhost:8787/health

# Get a token
TOKEN=$(curl -s -X POST localhost:8787/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}' | npx --yes json token)

# Create a document (writes require auth)
curl -X POST localhost:8787/v1/todos \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Try EdgeHive","done":false}'

# List documents (public read)
curl localhost:8787/v1/todos
```

### See realtime in action

Open two terminals against a running server:

```bash
# Terminal 1 — subscribe to the live change stream
curl -N localhost:8787/v1/todos/stream

# Terminal 2 — create/update/delete and watch events appear in Terminal 1
curl -X POST localhost:8787/v1/todos \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"live!"}'
```

Or just open [`public/index.html`](public/index.html) in a browser for a tiny
zero-dependency realtime UI (set the base URL to your server).

### One-command demo (no server, no services)

```bash
npm run demo     # bun run scripts/demo.ts   |   deno task demo
```

This boots the app in-process and drives login → subscribe → create → update →
delete, printing every SSE event as it arrives.

## Using the Firebase emulator (real Firestore)

By default EdgeHive uses the emulator when it's reachable and falls back to the
in-memory store otherwise. To run against real Firestore locally you only need
the Firebase CLI (free) and a JDK (the Firestore emulator is a Java process):

```bash
npm install -g firebase-tools

# Start the Firestore + Auth emulators (config in firebase.json)
npm run emulators
#   Firestore → 127.0.0.1:8080
#   Auth      → 127.0.0.1:9099
#   UI        → http://127.0.0.1:4000

# In another terminal, start EdgeHive — it auto-detects the emulator
npm run dev:node
```

`GET /health` will now report `"store": { "kind": "firestore" }`. There's also a
full end-to-end integration check that boots the app against a live emulator and
verifies persistence across requests:

```bash
npm run integration
```

## API reference

| Method   | Path                  | Auth | Description                                   |
| -------- | --------------------- | :--: | --------------------------------------------- |
| `GET`    | `/`                   |  –   | Service banner + which runtime is serving     |
| `GET`    | `/health`             |  –   | Runtime, store kind/health, subscriber count  |
| `POST`   | `/auth/login`         |  –   | Mint a dev bearer token for an email          |
| `GET`    | `/auth/me`            |  ✔   | Echo the authenticated user                   |
| `GET`    | `/v1/:col`            |  –   | List documents in a collection                |
| `POST`   | `/v1/:col`            |  ✔   | Create a document → emits `created`           |
| `GET`    | `/v1/:col/:id`        |  –   | Fetch one document                            |
| `PUT`    | `/v1/:col/:id`        |  ✔   | Upsert a document → emits `updated`           |
| `DELETE` | `/v1/:col/:id`        |  ✔   | Delete a document → emits `deleted`           |
| `GET`    | `/v1/:col/stream`     |  –   | Realtime SSE change stream for the collection |

A ready-to-import **Postman collection** lives in
[`postman/EdgeHive.postman_collection.json`](postman/EdgeHive.postman_collection.json)
— run *Login* first and the bearer token is saved automatically for the rest of
the requests.

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)),
and all have sensible defaults so the project runs with none set.

| Variable                      | Default             | Purpose                                   |
| ----------------------------- | ------------------- | ----------------------------------------- |
| `PORT`                        | `8787`              | HTTP port                                 |
| `GCLOUD_PROJECT`              | `edgehive-demo`     | Firebase / GCP project id                 |
| `FIRESTORE_EMULATOR_HOST`     | `127.0.0.1:8080`    | Firestore emulator host                   |
| `FIREBASE_AUTH_EMULATOR_HOST` | `127.0.0.1:9099`    | Auth emulator host                        |
| `EDGEHIVE_USE_EMULATOR`       | `true`              | Set `false` to force the in-memory store  |
| `EDGEHIVE_AUTH_SECRET`        | `dev-secret-...`    | HMAC secret for tokens — **change it**    |

## Testing

```bash
npm test          # Node: type-check-adjacent parity suite (node:test)
npm run smoke     # Node: end-to-end smoke over the real app
deno task test    # Deno: the same parity suite
bun run scripts/smoke.ts   # Bun: end-to-end smoke
```

CI runs the parity suite on **Node 20 & 22**, **Deno** and **Bun**, plus a
dedicated **Firebase emulator integration** job — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Project layout

```
src/
  core/
    app.ts          # the Hono app — the whole API, runtime-agnostic
    bootstrap.ts    # assembles store + broadcaster, builds the app
    config.ts       # env-driven configuration
    runtime.ts      # runtime detection + env abstraction (Bun/Deno/Node)
  lib/
    store.ts        # Store interface + Firestore & in-memory implementations
    firestore-rest.ts  # dependency-free Firestore REST client + value codec
    broadcaster.ts  # in-process pub/sub feeding the SSE streams
    auth.ts         # Web Crypto HMAC token issue/verify
entrypoints/
  bun.ts  deno.ts  node.ts   # ~10 lines each — the only per-runtime code
scripts/
  demo.ts  smoke.ts  integration.ts
test/               # parity + unit suite (node:test)
public/index.html   # zero-dependency browser realtime client
firebase.json  firestore.rules  .firebaserc   # emulator config
postman/            # Postman collection
```

## Scaling notes

The in-process `Broadcaster` is perfect for a single instance. To run multiple
instances, replace it with a shared bus (Redis pub/sub, or a Firestore
`onSnapshot` listener that re-publishes) — the `Broadcaster` interface is the
only seam you need to touch. Nothing in the route handlers changes.

## License

MIT © 2026 xj16 — see [LICENSE](LICENSE).
