/**
 * Parse & validate the query string for `GET /v1/:col` into a typed
 * `QueryOptions`, with clear, boundary-enforced errors.
 *
 * We keep validation dependency-free (no Zod/valibot) to preserve EdgeHive's
 * zero-dependency, three-runtime promise — but it is still strict: unknown
 * operators, malformed `where` clauses, and out-of-range limits are rejected
 * with a 400-friendly message rather than silently ignored.
 *
 * Supported parameters:
 *   ?limit=<1..100>
 *   ?pageToken=<opaque cursor from a previous nextPageToken>
 *   ?orderBy=<field>            (may be prefixed with '-' for descending)
 *   ?direction=asc|desc         (alternative to the '-' prefix)
 *   ?where=<field><op><value>   (repeatable; op ∈ ==,!=,<,<=,>,>=)
 *                                 value is JSON-parsed, falling back to string
 */

import type { QueryOptions, WhereClause, WhereOp } from "./firestore-rest.ts";
import { MAX_PAGE_SIZE } from "./firestore-rest.ts";

export type ParseResult =
  | { ok: true; options: QueryOptions }
  | { ok: false; error: string };

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
// Longest operators first so `<=`/`>=`/`!=` win over `<`/`>`/`=`.
const OPERATORS: WhereOp[] = ["<=", ">=", "!=", "==", "<", ">"];

export function parseQueryOptions(url: URL): ParseResult {
  const params = url.searchParams;
  const options: QueryOptions = {};

  // limit
  if (params.has("limit")) {
    const raw = params.get("limit")!;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      return { ok: false, error: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}` };
    }
    options.limit = n;
  }

  // pageToken (opaque; validated on decode)
  const pageToken = params.get("pageToken");
  if (pageToken) {
    if (pageToken.length > 256 || !/^[A-Za-z0-9_-]+$/.test(pageToken)) {
      return { ok: false, error: "pageToken is malformed" };
    }
    options.pageToken = pageToken;
  }

  // orderBy (+ optional '-' descending prefix) and/or explicit direction
  const orderByRaw = params.get("orderBy");
  if (orderByRaw) {
    let field = orderByRaw;
    let direction: "asc" | "desc" | undefined;
    if (field.startsWith("-")) {
      direction = "desc";
      field = field.slice(1);
    } else if (field.startsWith("+")) {
      field = field.slice(1);
    }
    if (field !== "__name__" && !FIELD_RE.test(field)) {
      return { ok: false, error: `orderBy field '${field}' is invalid` };
    }
    options.orderBy = field;
    if (direction) options.direction = direction;
  }

  const dirRaw = params.get("direction");
  if (dirRaw) {
    if (dirRaw !== "asc" && dirRaw !== "desc") {
      return { ok: false, error: "direction must be 'asc' or 'desc'" };
    }
    options.direction = dirRaw;
  }

  // where (repeatable)
  const whereRaws = params.getAll("where");
  if (whereRaws.length > 0) {
    if (whereRaws.length > 8) {
      return { ok: false, error: "at most 8 where clauses are allowed" };
    }
    const where: WhereClause[] = [];
    for (const raw of whereRaws) {
      const parsed = parseWhere(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      where.push(parsed.clause);
    }
    options.where = where;
  }

  return { ok: true, options };
}

function parseWhere(raw: string):
  | { ok: true; clause: WhereClause }
  | { ok: false; error: string } {
  for (const op of OPERATORS) {
    const idx = raw.indexOf(op);
    if (idx <= 0) continue;
    // Avoid matching the '<' inside '<=' etc.: the char after a 1-char op must
    // not itself be '=' unless this op already ends in '='.
    if (op.length === 1 && raw[idx + 1] === "=") continue;
    const field = raw.slice(0, idx);
    const valueRaw = raw.slice(idx + op.length);
    if (!FIELD_RE.test(field)) {
      return { ok: false, error: `where field '${field}' is invalid` };
    }
    return { ok: true, clause: { field, op, value: coerceValue(valueRaw) } };
  }
  return {
    ok: false,
    error: `where clause '${raw}' must be <field><op><value> with op ∈ ==,!=,<,<=,>,>=`,
  };
}

/** JSON-parse the value; fall back to the raw string when it isn't valid JSON. */
function coerceValue(raw: string): WhereClause["value"] {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
