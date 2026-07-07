/**
 * Storage abstraction.
 *
 * The app depends only on the `Store` interface, never on Firestore directly.
 * Two implementations are provided:
 *
 *   - `FirestoreStore` — backed by the Firestore emulator over REST. This is
 *     the "real" store used when the emulator is reachable.
 *   - `MemoryStore` — an in-process fallback with identical semantics. Used
 *     automatically when the emulator is not running so that the API (and its
 *     parity tests) stay runnable with zero external setup.
 *
 * Because both implementations satisfy the same interface, the route handlers,
 * the SSE broadcaster and the parity test suite are all storage-agnostic.
 */

import type { Json, StoredDoc, QueryOptions, QueryResult } from "./firestore-rest.ts";
import {
  FirestoreRest,
  clampLimit,
  encodeOffsetToken,
  decodeOffsetToken,
} from "./firestore-rest.ts";

export interface Store {
  readonly kind: "firestore" | "memory";
  create(collection: string, data: Record<string, Json>): Promise<StoredDoc>;
  get(collection: string, id: string): Promise<StoredDoc | null>;
  list(collection: string): Promise<StoredDoc[]>;
  /**
   * Ordered, filtered, paginated read. Both stores honour the same
   * `QueryOptions` so the API behaves identically on Firestore and in memory.
   */
  query(collection: string, opts: QueryOptions): Promise<QueryResult>;
  set(collection: string, id: string, data: Record<string, Json>): Promise<StoredDoc>;
  delete(collection: string, id: string): Promise<void>;
  /** True when the underlying backend is reachable. */
  healthy(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Firestore-backed store
// ---------------------------------------------------------------------------

export class FirestoreStore implements Store {
  readonly kind = "firestore" as const;
  private readonly client: FirestoreRest;

  constructor(host: string, projectId: string, fetchImpl?: typeof fetch) {
    this.client = new FirestoreRest({ host, projectId, fetchImpl });
  }

  create(collection: string, data: Record<string, Json>): Promise<StoredDoc> {
    return this.client.create(collection, data);
  }
  get(collection: string, id: string): Promise<StoredDoc | null> {
    return this.client.get(collection, id);
  }
  list(collection: string): Promise<StoredDoc[]> {
    return this.client.list(collection);
  }
  query(collection: string, opts: QueryOptions): Promise<QueryResult> {
    return this.client.query(collection, opts);
  }
  set(collection: string, id: string, data: Record<string, Json>): Promise<StoredDoc> {
    return this.client.set(collection, id, data);
  }
  delete(collection: string, id: string): Promise<void> {
    return this.client.delete(collection, id);
  }

  async healthy(): Promise<boolean> {
    try {
      // Listing an (empty) collection round-trips cheaply. NOTE: Firestore
      // reserves identifiers matching /__.*__/, so we must NOT use a name like
      // "__healthcheck__" here — it returns HTTP 400. "edgehive_health" is safe.
      await this.client.list("edgehive_health", 1);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback store
// ---------------------------------------------------------------------------

let memCounter = 0;

function genId(): string {
  // 20-char lowercase id, mirroring Firestore's auto-id shape.
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 20; i++) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  // Guarantee monotonic uniqueness even if Math.random collides.
  return `${id}${(memCounter++).toString(36)}`;
}

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private readonly data = new Map<string, Map<string, StoredDoc>>();

  private col(collection: string): Map<string, StoredDoc> {
    let c = this.data.get(collection);
    if (!c) {
      c = new Map();
      this.data.set(collection, c);
    }
    return c;
  }

  async create(collection: string, data: Record<string, Json>): Promise<StoredDoc> {
    const id = genId();
    const now = new Date().toISOString();
    const doc: StoredDoc = { id, data, createTime: now, updateTime: now };
    this.col(collection).set(id, doc);
    return structuredCloneDoc(doc);
  }

  async get(collection: string, id: string): Promise<StoredDoc | null> {
    const doc = this.col(collection).get(id);
    return doc ? structuredCloneDoc(doc) : null;
  }

  async list(collection: string): Promise<StoredDoc[]> {
    return [...this.col(collection).values()].map(structuredCloneDoc);
  }

  async query(collection: string, opts: QueryOptions): Promise<QueryResult> {
    const limit = clampLimit(opts.limit);
    const offset = decodeOffsetToken(opts.pageToken);
    let rows = [...this.col(collection).values()].map(structuredCloneDoc);

    // Filter (ANDed clauses).
    if (opts.where && opts.where.length > 0) {
      rows = rows.filter((doc) =>
        opts.where!.every((w) => matchesWhere(pluckField(doc, w.field), w.op, w.value)),
      );
    }

    // Order. Default to `__name__` (document id) — the one key Firestore can
    // always order by — and default to descending, matching the Firestore
    // transport, so both stores return identically-ordered pages.
    const orderField = opts.orderBy ?? "__name__";
    const dir = opts.direction === "asc" ? 1 : -1;
    rows.sort((a, b) => dir * compareValues(sortKey(a, orderField), sortKey(b, orderField)));

    const page = rows.slice(offset, offset + limit);
    const hasMore = rows.length > offset + limit;
    return {
      documents: page,
      nextPageToken: hasMore ? encodeOffsetToken(offset + limit) : null,
    };
  }

  async set(
    collection: string,
    id: string,
    data: Record<string, Json>,
  ): Promise<StoredDoc> {
    const now = new Date().toISOString();
    const existing = this.col(collection).get(id);
    const doc: StoredDoc = {
      id,
      data,
      createTime: existing?.createTime ?? now,
      updateTime: now,
    };
    this.col(collection).set(id, doc);
    return structuredCloneDoc(doc);
  }

  async delete(collection: string, id: string): Promise<void> {
    this.col(collection).delete(id);
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}

function structuredCloneDoc(doc: StoredDoc): StoredDoc {
  return {
    id: doc.id,
    data: JSON.parse(JSON.stringify(doc.data)) as Record<string, Json>,
    createTime: doc.createTime,
    updateTime: doc.updateTime,
  };
}

// ---------------------------------------------------------------------------
// In-memory query helpers — mirror Firestore's ordering/filtering semantics so
// the two stores return identically-ordered pages for the same query.
// ---------------------------------------------------------------------------

/** Resolve a `where` field: document metadata keys or a data field. */
function pluckField(doc: StoredDoc, field: string): Json {
  if (field === "__name__") return doc.id;
  if (field === "createTime") return doc.createTime ?? "";
  if (field === "updateTime") return doc.updateTime ?? "";
  const v = doc.data[field];
  return v === undefined ? null : v;
}

/** Resolve the sort key for ordering; `__name__` sorts by document id. */
function sortKey(doc: StoredDoc, field: string): Json {
  return pluckField(doc, field);
}

/** Total order over the JSON scalar types Firestore supports for ordering. */
function compareValues(a: Json, b: Json): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 1: // number
      return (a as number) - (b as number);
    case 2: // string
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    case 3: // boolean
      return (a === b ? 0 : a ? 1 : -1);
    default:
      return 0;
  }
}

function typeRank(v: Json): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return 1;
  if (typeof v === "string") return 2;
  if (typeof v === "boolean") return 3;
  return 4; // arrays / objects sort last, stably
}

function matchesWhere(actual: Json, op: string, expected: Json): boolean {
  switch (op) {
    case "==":
      return deepEqualJson(actual, expected);
    case "!=":
      return !deepEqualJson(actual, expected);
    case "<":
      return compareValues(actual, expected) < 0;
    case "<=":
      return compareValues(actual, expected) <= 0;
    case ">":
      return compareValues(actual, expected) > 0;
    case ">=":
      return compareValues(actual, expected) >= 0;
    default:
      return false;
  }
}

function deepEqualJson(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Store factory — pick Firestore when reachable, else fall back to memory.
// ---------------------------------------------------------------------------

export interface CreateStoreOptions {
  useEmulator: boolean;
  firestoreEmulatorHost: string;
  projectId: string;
  /** Force a specific store, bypassing the health probe (used in tests). */
  force?: "firestore" | "memory";
  fetchImpl?: typeof fetch;
}

/**
 * Build the best available store. When the emulator is configured and
 * reachable we use it; otherwise we transparently fall back to the in-memory
 * store so the API never hard-fails just because Firebase isn't running.
 */
export async function createStore(opts: CreateStoreOptions): Promise<Store> {
  if (opts.force === "memory") return new MemoryStore();
  if (opts.force === "firestore") {
    return new FirestoreStore(opts.firestoreEmulatorHost, opts.projectId, opts.fetchImpl);
  }

  if (opts.useEmulator) {
    const fs = new FirestoreStore(
      opts.firestoreEmulatorHost,
      opts.projectId,
      opts.fetchImpl,
    );
    if (await fs.healthy()) return fs;
  }
  return new MemoryStore();
}
