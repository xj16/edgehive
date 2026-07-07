# Changelog

All notable changes to EdgeHive are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-07

A production-hardening pass that closes the biggest functional and security gaps
while keeping the "one codebase, three runtimes" guarantee intact. Everything
below runs unmodified on Bun, Deno and Node, and the parity suite proves it.

### Added

- **Query layer on `GET /v1/:col`** — `?limit=`, `?pageToken=`, `?orderBy=`
  (with a `-` prefix or `?direction=` for descending) and repeatable
  `?where=<field><op><value>` filters (`==`, `!=`, `<`, `<=`, `>`, `>=`).
  Responses now include a `nextPageToken` cursor. Implemented identically for
  the in-memory store (in-JS sort/filter/offset) and the Firestore store (via
  the REST `:runQuery` structuredQuery endpoint), so parity holds.
- **Initial-snapshot SSE** — subscribing to `/v1/:col/stream` now emits a
  `snapshot` event carrying the current collection right after `ready`, so a
  fresh client has state immediately instead of waiting for the next mutation.
- **Dedicated heartbeat channel** — keepalives no longer masquerade as a fake
  `ChangeEvent` with id `__heartbeat__`; the stream has a distinct heartbeat
  path and the internal event model is no longer overloaded.
- **Abuse protection** — a runtime-agnostic token-bucket rate limiter on writes
  and `/auth/login` (per-IP, with `X-RateLimit-*` and `Retry-After` headers), a
  hard JSON body-size cap returning `413`, and a per-IP concurrent-SSE cap
  returning `429`.
- **Optional-auth hook** — `EDGEHIVE_REQUIRE_AUTH_FOR_READS=true` promotes the
  public read feed to a fully private API without touching route code.
- **Configurable CORS allowlist** — `EDGEHIVE_CORS_ORIGINS` replaces the
  wide-open default with an explicit origin list for production.
- **Observability** — structured single-line JSON access logs with a
  correlation `x-request-id` on every response, a Prometheus `/metrics`
  endpoint (request counters, a latency histogram, rate-limit and SSE counters),
  and a richer `/health` surfacing p50/p95 latency and live SSE connection
  counts.
- **Self-documenting API** — an OpenAPI 3 spec at `/openapi.json` and a
  dependency-free interactive explorer at `/docs`, replacing the hand-maintained
  Postman collection as the source of truth.
- **Bundled realtime client** — a live, self-contained CRUD board served at
  `/app` (and shipped as `public/index.html`): it renders the collection as a
  live-updating table driven by the SSE snapshot + change events, with create /
  edit / delete wired to the API.
- **Demo mode** — `EDGEHIVE_DEMO=1` self-seeds a realistic dataset on boot; a
  standalone `scripts/seed.ts` (`npm run seed`) can populate any running
  instance over HTTP.
- **Load/soak test** — `scripts/load.ts` (`npm run load`) opens N concurrent SSE
  subscribers, drives a write burst, asserts zero dropped events, and prints
  p50/p95/max fan-out latency. A scaled-down run is wired into CI.
- **Containers & deploy** — a multi-stage distroless `Dockerfile`, a
  `docker-compose.yml` (with a `demo` profile) that runs EdgeHive alongside a
  real Firestore/Auth emulator for one-command full-stack up, and a `fly.toml`
  for a hosted playground.
- **Coverage** — `npm run coverage` (Node's built-in coverage) plus a
  shields.io coverage badge regenerated and committed by CI.
- **Flagship tests** — new suites for the query/pagination layer, rate limiting
  and body caps, the SSE initial snapshot, metrics/observability, and the
  abuse-protection primitives (bringing the suite from 33 to 51 tests).

### Changed

- Bumped version to **0.2.0** across `package.json` and the service banner.
- `GET /v1/:col` now returns a `nextPageToken` field and defaults to a page size
  of 25 (previously returned up to 100 documents with no cursor).
- The keep-alive heartbeat timer is `unref`'d so it never blocks process exit or
  graceful shutdown.

### Security

- Closed the two unbounded surfaces a reviewer flags first: the public write
  path and the unauthenticated SSE stream are now both rate/limit-bounded.
- Request bodies are size-capped before parsing to prevent memory-exhaustion.

## [0.1.0] — 2026-07-06

Initial release.

- One Hono app served identically on Bun, Deno and Node via Web-standard
  `Request`/`Response`; the only per-runtime code is a ~10-line entrypoint.
- Firestore-backed store over a dependency-free REST client, with a transparent
  in-memory fallback when the emulator isn't running.
- Realtime change events over Server-Sent Events.
- HMAC-signed dev bearer tokens via Web Crypto; writes require auth.
- Parity test suite green on Node, Deno and Bun in CI, plus a real Firebase
  emulator integration job.
