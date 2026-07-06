/**
 * A tiny, dependency-free Firestore client that speaks the Firestore REST API
 * over `fetch`.
 *
 * Why REST instead of the Admin SDK?
 *   - The Firebase Admin SDK is a heavy Node-only package with native-ish
 *     transitive deps. It does NOT run on Deno cleanly, and pulling it in would
 *     break EdgeHive's "one codebase, three runtimes" promise.
 *   - The REST API is plain HTTP + JSON, so it works identically under Bun,
 *     Deno and Node — all three ship a global `fetch`.
 *   - Against the emulator no credentials are required, which keeps the whole
 *     project 100% free and offline-friendly.
 *
 * We implement just enough of the API for a realtime CRUD backend:
 * create / get / list / delete documents in a collection, with automatic
 * conversion between plain JS objects and Firestore's typed value format.
 */

// ---------------------------------------------------------------------------
// Firestore typed-value <-> plain JS conversion
// ---------------------------------------------------------------------------

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

interface FsValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  stringValue?: string;
  timestampValue?: string;
  arrayValue?: { values?: FsValue[] };
  mapValue?: { fields?: Record<string, FsValue> };
}

interface FsDocument {
  name?: string;
  fields?: Record<string, FsValue>;
  createTime?: string;
  updateTime?: string;
}

/** Convert a plain JS value into a Firestore typed value. */
export function toFsValue(v: Json): FsValue {
  if (v === null) return { nullValue: null };
  switch (typeof v) {
    case "boolean":
      return { booleanValue: v };
    case "number":
      return Number.isInteger(v)
        ? { integerValue: String(v) }
        : { doubleValue: v };
    case "string":
      return { stringValue: v };
    case "object":
      if (Array.isArray(v)) {
        return { arrayValue: { values: v.map(toFsValue) } };
      }
      return {
        mapValue: {
          fields: Object.fromEntries(
            Object.entries(v).map(([k, val]) => [k, toFsValue(val as Json)]),
          ),
        },
      };
    default:
      // undefined / function / symbol — represent as null.
      return { nullValue: null };
  }
}

/** Convert a Firestore typed value back into a plain JS value. */
export function fromFsValue(v: FsValue): Json {
  if (v.nullValue !== undefined) return null;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue !== undefined) {
    return (v.arrayValue.values ?? []).map(fromFsValue);
  }
  if (v.mapValue !== undefined) {
    const out: { [key: string]: Json } = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) {
      out[k] = fromFsValue(val);
    }
    return out;
  }
  return null;
}

/** Convert a whole Firestore document's `fields` map to a plain object. */
export function fieldsToObject(fields: Record<string, FsValue> | undefined): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    out[k] = fromFsValue(v);
  }
  return out;
}

/** Convert a plain object to a Firestore `fields` map. */
export function objectToFields(obj: Record<string, Json>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = toFsValue(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document id extraction
// ---------------------------------------------------------------------------

/** Pull the trailing document id out of a Firestore resource name. */
export function docIdFromName(name: string | undefined): string {
  if (!name) return "";
  const parts = name.split("/");
  return parts[parts.length - 1] ?? "";
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface FirestoreRestOptions {
  /** e.g. "127.0.0.1:8080" */
  host: string;
  /** Firebase project id. */
  projectId: string;
  /** Optional bearer token (unused against the emulator). */
  accessToken?: string;
  /** Injected fetch — defaults to the global. Lets tests stub the network. */
  fetchImpl?: typeof fetch;
}

export interface StoredDoc {
  id: string;
  data: Record<string, Json>;
  createTime?: string;
  updateTime?: string;
}

export class FirestoreRestError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "FirestoreRestError";
    this.status = status;
    this.body = body;
  }
}

export class FirestoreRest {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly accessToken?: string;

  constructor(opts: FirestoreRestOptions) {
    // The emulator serves HTTP (not HTTPS) on its host:port.
    this.base =
      `http://${opts.host}/v1/projects/${opts.projectId}/databases/(default)/documents`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.accessToken = opts.accessToken;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.accessToken) h["authorization"] = `Bearer ${this.accessToken}`;
    // The emulator ignores auth but accepts an "owner" bearer for admin ops.
    else h["authorization"] = "Bearer owner";
    return h;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? safeJsonParse(text) : undefined;
    if (!res.ok) {
      throw new FirestoreRestError(
        `Firestore ${method} ${path} failed (${res.status})`,
        res.status,
        parsed,
      );
    }
    return parsed;
  }

  /** Create a document with a server-generated id, returning the stored doc. */
  async create(collection: string, data: Record<string, Json>): Promise<StoredDoc> {
    const doc = (await this.request("POST", `/${encodeURIComponent(collection)}`, {
      fields: objectToFields(data),
    })) as FsDocument;
    return this.toStored(doc);
  }

  /** Create or overwrite a document at a specific id. */
  async set(
    collection: string,
    id: string,
    data: Record<string, Json>,
  ): Promise<StoredDoc> {
    const doc = (await this.request(
      "PATCH",
      `/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
      { fields: objectToFields(data) },
    )) as FsDocument;
    return this.toStored(doc);
  }

  /** Fetch a single document, or null when it does not exist. */
  async get(collection: string, id: string): Promise<StoredDoc | null> {
    try {
      const doc = (await this.request(
        "GET",
        `/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
      )) as FsDocument;
      return this.toStored(doc);
    } catch (err) {
      if (err instanceof FirestoreRestError && err.status === 404) return null;
      throw err;
    }
  }

  /** List documents in a collection (newest-first is not guaranteed by REST). */
  async list(collection: string, pageSize = 100): Promise<StoredDoc[]> {
    const res = (await this.request(
      "GET",
      `/${encodeURIComponent(collection)}?pageSize=${pageSize}`,
    )) as { documents?: FsDocument[] };
    return (res.documents ?? []).map((d) => this.toStored(d));
  }

  /** Delete a document. Idempotent — deleting a missing doc resolves quietly. */
  async delete(collection: string, id: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
      );
    } catch (err) {
      if (err instanceof FirestoreRestError && err.status === 404) return;
      throw err;
    }
  }

  private toStored(doc: FsDocument): StoredDoc {
    return {
      id: docIdFromName(doc.name),
      data: fieldsToObject(doc.fields),
      createTime: doc.createTime,
      updateTime: doc.updateTime,
    };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
