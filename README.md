# EdgeHive

**One backend. Three runtimes. Realtime out of the box.**

EdgeHive is a small, production-shaped realtime API. You write your handlers
**once**, and the exact same code serves requests on **Bun**, **Deno** and
**Node.js** — because everything is built on the Web-standard `Request`/`Response`
contract via [Hono](https://hono.dev). Data is persisted in **Firestore**
(through the Firebase emulator by default, with a transparent in-memory
fallback), realtime change events stream to clients over **Server-Sent Events**,
and an HMAC-signed bearer-token layer guards writes.

No paid keys. No cloud account required to run it. `npm install` and go.

[![CI](https://github.com/xj16/edgehive/actions/workflows/ci.yml/badge.svg)](https://github.com/xj16/edgehive/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/xj16/edgehive/main/.github/badges/coverage.json)](https://github.com/xj16/edgehive/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Runtimes: Bun · Deno · Node](https://img.shields.io/badge/runtimes-Bun%20%C2%B7%20Deno%20%C2%B7%20Node-black)
![Zero deps](https://img.shields.io/badge/dependencies-1%20(hono)-brightgreen)

```bash
npm install && npm run demo     # zero services, watch realtime events fly
```

---

## Why

Most "serverless" starters lock you into one runtime and one hosting provider.
The interesting edge platforms (Bun, Deno Deploy, Cloudflare-style workers) all
converge on the **same Web-standard primitives**, so there's no good reason your
backend code should care which one it runs on.

EdgeHive proves the point: **one handler layer, three runtimes, zero
runtime-specific branches in your business logic.** The only per-runtime code is
a ~10-line entrypoint that hands the app to the runtime's HTTP server. Everything
else — routing, auth, storage, realtime, rate limiting, metrics — is shared and
identical, and a parity test suite runs on all three runtimes in CI to keep it
honest.

## Features

- **Runtime-agnostic handler layer** — one Hono app served identically on Bun,
  Deno and Node. The per-runtime entrypoints are the only place any runtime
  global appears.
- **Realtime over SSE, with an initial snapshot** — subscribe to a collection
  and immediately receive a `snapshot` of current state, then live `created`,
  `updated` and `deleted` events, with a dedicated heartbeat channel.
- **Query API** — `GET /v1/:col` supports `?limit=`, `?pageToken=`, `?orderBy=`
  and repeatable `?where=` filters, returning a `nextPageToken` cursor. Both the
  Firestore and in-memory stores honour the same query semantics.
- **Firestore-backed** — a dependency-free Firestore REST client (works on every
  runtime; the Admin SDK does not) talks to the Firebase emulator. Ordered,
  filtered queries use the REST `:runQuery` structuredQuery endpoint.
- **Graceful in-memory fallback** — if the emulator isn't running, EdgeHive
  transparently falls back to an in-process store with identical semantics, so
  the API (and its tests) run with **zero setup**.
- **Auth built in** — `POST /auth/login` mints a compact HMAC-signed token using
  the Web Crypto API (no native deps). Writes require a valid bearer token; an
  optional hook can require auth on reads too.
- **Abuse protection** — per-IP token-bucket rate limiting on writes and login,
  a request body-size cap, and a per-IP concurrent-SSE connection cap.
- **Observability** — Prometheus `/metrics`, structured JSON access logs with a
  correlation `x-request-id`, and a `/health` endpoint reporting store health,
  p50/p95 latency and live subscriber counts.
- **Self-documenting** — an OpenAPI 3 spec at `/openapi.json` and an interactive
  explorer at `/docs`, plus a bundled realtime web client at `/app`.
- **Batteries included** — Docker + docker-compose (with a demo profile), a
  `fly.toml`, a seed script, a load/soak test, and a Postman collection.
- **Type-safe & tested** — strict TypeScript that type-checks under Node's `tsc`,
  a 51-test parity suite, coverage in CI, and a real Firestore-emulator
  integration job.

## Architecture

```
                       ┌──────────────────────────────────────────┐
   entrypoints/        │            src/core/app.ts               │
   ─────────────       │  one Hono app — NO runtime-specific code  │
   bun.ts   ─┐         │  middleware: CORS · request-id/log ·      │
   deno.ts  ─┼──▶ buildApp() ─▶  rate-limit · auth · routes · SSE   │
   node.ts  ─┘         └───────┬───────────┬───────────┬──────────┘
                               │           │           │
                     src/lib/store.ts  broadcaster.ts  metrics.ts
                               │        (pub/sub→SSE)   ratelimit.ts
                 ┌─────────────┴─────────────┐
                 │                           │
         FirestoreStore                 MemoryStore
      (REST + :runQuery → emulator)  (zero-setup fallback, same query semantics)
```

The app depends only on a `Store` interface and a `Broadcaster`. Swapping the
backend (Redis pub/sub, real Firestore listeners, Postgres) is a localized change
that never touches your routes. The rate limiter and broadcaster are in-process
by design for a single instance; both interfaces are the only seams you touch to
scale horizontally (see [Scaling notes](#scaling-notes)).

## Quick start

```bash
git clone https://github.com/xj16/edgehive
cd edgehive
npm install
```

### Run it (any runtime)

```bash
npm run dev:node       # Node 22+ (runs TypeScript directly via type-stripping)
npm run dev:bun        # Bun    (or: bun run entrypoints/bun.ts)
npm run dev:deno       # Deno   (or: deno task dev)
```

Then open **<http://localhost:8787/app>** for the live realtime client, or
**<http://localhost:8787/docs>** for the interactive API explorer.

### Talk to it

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
  -d '{"title":"Try EdgeHive","done":false,"priority":1}'

# Query: filter + order + paginate (public read)
curl "localhost:8787/v1/todos?where=done==false&orderBy=priority&direction=asc&limit=10"
```

### See realtime in action

```bash
# Terminal 1 — subscribe (you'll get a snapshot, then live events)
curl -N localhost:8787/v1/todos/stream

# Terminal 2 — mutate and watch Terminal 1 update instantly
curl -X POST localhost:8787/v1/todos \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"live!"}'
```

Or open **`/app`** in two browser tabs and watch changes fan out across both.

### One-command demo (no server, no services)

```bash
npm run demo     # bun run scripts/demo.ts   |   deno task demo
```

Boots the app in-process and drives login → subscribe → create → update → delete,
printing every SSE event as it arrives.

## Live demo mode

Bring an instance up **already populated** with realistic data:

```bash
EDGEHIVE_DEMO=1 npm run dev:node      # self-seeds on boot
# ...then open http://localhost:8787/app
```

Or seed a running instance over HTTP:

```bash
npm run seed                          # seeds http://localhost:8787
BASE=https://your-instance npm run seed
```

## Run with Docker (real Firestore, one command)

No local JDK or Firebase CLI needed — the compose stack bundles the emulator:

```bash
docker compose up                     # EdgeHive + Firestore/Auth emulator
docker compose --profile demo up      # same, pre-seeded (EdgeHive on :8788)
```

`GET /health` will report `"store": { "kind": "firestore" }`. A standalone
distroless image is also provided:

```bash
docker build -t edgehive .
docker run -p 8787:8787 -e EDGEHIVE_DEMO=1 edgehive
```

A [`fly.toml`](fly.toml) is included for a hosted playground (`fly deploy`).

## Realtime performance

`scripts/load.ts` opens N concurrent SSE subscribers, drives a write burst, and
asserts **every subscriber receives every event**, printing fan-out latency:

```bash
SUBSCRIBERS=200 EVENTS=50 npm run load
# [load] delivered 10000/10000 events, dropped 0
# [load] fan-out latency  p50=2ms  p95=9ms  max=14ms
```

A scaled-down run (`SUBSCRIBERS=100 EVENTS=25`) runs on every CI build, so the
realtime layer can't silently regress.

## API reference

| Method   | Path                  | Auth | Description                                        |
| -------- | --------------------- | :--: | -------------------------------------------------- |
| `GET`    | `/`                   |  –   | Service banner + which runtime is serving          |
| `GET`    | `/health`             |  –   | Runtime, store health, latency + subscriber counts |
| `GET`    | `/metrics`            |  –   | Prometheus text exposition                         |
| `GET`    | `/openapi.json`       |  –   | OpenAPI 3 contract                                 |
| `GET`    | `/docs`               |  –   | Interactive API explorer                           |
| `GET`    | `/app`                |  –   | Bundled realtime browser client                    |
| `POST`   | `/auth/login`         |  –   | Mint a dev bearer token for an email               |
| `GET`    | `/auth/me`            |  ✔   | Echo the authenticated user                        |
| `GET`    | `/v1/:col`            |  –   | List / query documents (`limit`,`pageToken`,`orderBy`,`where`) |
| `POST`   | `/v1/:col`            |  ✔   | Create a document → emits `created`                |
| `GET`    | `/v1/:col/:id`        |  –   | Fetch one document                                 |
| `PUT`    | `/v1/:col/:id`        |  ✔   | Upsert a document → emits `updated`                |
| `DELETE` | `/v1/:col/:id`        |  ✔   | Delete a document → emits `deleted`                |
| `GET`    | `/v1/:col/stream`     |  –   | SSE change stream (`ready`→`snapshot`→live events) |

The full contract — parameters, schemas, status codes — is served live at
`/openapi.json` and browsable at `/docs`. A Postman collection is also included
under [`postman/`](postman/EdgeHive.postman_collection.json).

### Query parameters (`GET /v1/:col`)

| Parameter    | Example                        | Notes                                    |
| ------------ | ------------------------------ | ---------------------------------------- |
| `limit`      | `?limit=10`                    | 1–100, default 25                        |
| `pageToken`  | `?pageToken=<from response>`   | Opaque cursor; returned as `nextPageToken` |
| `orderBy`    | `?orderBy=priority` / `-priority` | `-` prefix = descending               |
| `direction`  | `?direction=desc`              | Alternative to the `-` prefix            |
| `where`      | `?where=done==false` (repeatable) | ops: `==` `!=` `<` `<=` `>` `>=`      |

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)),
and all have sensible defaults so the project runs with none set.

| Variable                          | Default          | Purpose                                        |
| --------------------------------- | ---------------- | ---------------------------------------------- |
| `PORT`                            | `8787`           | HTTP port                                      |
| `GCLOUD_PROJECT`                  | `edgehive-demo`  | Firebase / GCP project id                      |
| `FIRESTORE_EMULATOR_HOST`         | `127.0.0.1:8080` | Firestore emulator host                        |
| `FIREBASE_AUTH_EMULATOR_HOST`     | `127.0.0.1:9099` | Auth emulator host                             |
| `EDGEHIVE_USE_EMULATOR`           | `true`           | Set `false` to force the in-memory store       |
| `EDGEHIVE_AUTH_SECRET`            | `dev-secret-…`   | HMAC secret for tokens — **change it**         |
| `EDGEHIVE_CORS_ORIGINS`           | `*`              | Comma-separated CORS allowlist                 |
| `EDGEHIVE_MAX_BODY_BYTES`         | `65536`          | Max JSON body size (writes + login)            |
| `EDGEHIVE_WRITE_RATE_PER_SEC`     | `20`             | Sustained writes/sec per IP                    |
| `EDGEHIVE_WRITE_BURST`            | `40`             | Write burst per IP                             |
| `EDGEHIVE_LOGIN_RATE_PER_MIN`     | `10`             | Login attempts/min per IP                      |
| `EDGEHIVE_MAX_SSE_PER_IP`         | `20`             | Max concurrent SSE streams per IP              |
| `EDGEHIVE_REQUIRE_AUTH_FOR_READS` | `false`          | Require a token on reads too (private API)      |
| `EDGEHIVE_DEMO`                   | `0`              | Self-seed demo data on boot                    |

## Testing

```bash
npm test           # Node: 51-test parity + unit suite (node:test)
npm run coverage   # Node: same suite with coverage report
npm run smoke      # Node: end-to-end smoke over the real app
npm run load       # Node: realtime fan-out load/soak test
deno task test     # Deno: the same parity suite
bun run scripts/smoke.ts   # Bun: end-to-end smoke
```

CI runs the parity suite on **Node 22 & 24**, **Deno** and **Bun**, a coverage
job (which refreshes the badge), the load test, plus a dedicated **Firebase
emulator integration** job — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Using the Firebase emulator (real Firestore)

By default EdgeHive uses the emulator when it's reachable and falls back to the
in-memory store otherwise. The Docker path above bundles it; to run it directly
you need the Firebase CLI (free) and a JDK:

```bash
npm install -g firebase-tools
npm run emulators        # Firestore :8080, Auth :9099, UI :4000
npm run dev:node         # in another terminal — auto-detects the emulator
npm run integration      # full end-to-end persistence check against it
```

## Project layout

```
src/
  core/
    app.ts          # the Hono app — the whole API, runtime-agnostic
    bootstrap.ts    # assembles store + broadcaster + metrics, seeds demo data
    config.ts       # env-driven configuration
    runtime.ts      # runtime detection + env abstraction (Bun/Deno/Node)
    openapi.ts      # OpenAPI 3 spec served at /openapi.json
    assets.ts       # bundled /docs explorer + /app realtime client
  lib/
    store.ts        # Store interface + Firestore & in-memory impls (with query)
    firestore-rest.ts  # dependency-free Firestore REST client + value codec
    query-params.ts # parse/validate the ?limit/pageToken/orderBy/where query
    broadcaster.ts  # in-process pub/sub feeding the SSE streams
    ratelimit.ts    # token-bucket limiter + per-IP connection counter
    metrics.ts      # Prometheus registry (counters + latency histogram)
    auth.ts         # Web Crypto HMAC token issue/verify
    seed.ts         # demo dataset
entrypoints/        # bun.ts deno.ts node.ts — the only per-runtime code
scripts/            # demo · smoke · seed · load · integration · coverage-badge
test/               # 51-test parity + unit suite (node:test)
public/index.html   # standalone realtime client (same as /app)
Dockerfile  docker-compose.yml  docker/  fly.toml
firebase.json  firestore.rules  .firebaserc   # emulator config
```

## Scaling notes

The in-process `Broadcaster` and rate limiter are perfect for a single instance.
To run multiple instances, replace the `Broadcaster` with a shared bus (Redis
pub/sub, or a Firestore `onSnapshot` listener that re-publishes) and key the rate
limiter off a shared store — both are the only seams you need to touch. Nothing
in the route handlers changes.

## License

MIT © 2026 xj16 — see [LICENSE](LICENSE).
