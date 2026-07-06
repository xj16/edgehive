/**
 * Lightweight, runtime-agnostic auth.
 *
 * EdgeHive issues and verifies compact HMAC-signed tokens (a minimal JWT-style
 * `header.payload.signature`) using the Web Crypto API — `crypto.subtle` is a
 * global on Bun, Deno and modern Node, so no runtime-specific code or native
 * dependency is needed.
 *
 * In emulator/dev mode this lets you `POST /auth/login` with any email and get
 * a bearer token you can use on protected routes, entirely offline and free.
 * The token shape is deliberately compatible with the mental model of a
 * Firebase ID token (it carries a `sub`/uid and an `email`), so swapping in
 * real Firebase Auth verification later is a localized change.
 */

export interface TokenPayload {
  /** Subject / user id. */
  sub: string;
  email: string;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expiry (seconds since epoch). */
  exp: number;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // btoa is a global in all three runtimes.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(encoder.encode(s));
}

function base64UrlDecodeToString(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

/**
 * Mint a signed token for a user. Default TTL is 1 hour.
 */
export async function issueToken(
  secret: string,
  user: { sub: string; email: string },
  ttlSeconds = 3600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: TokenPayload = {
    sub: user.sub,
    email: user.email,
    iat: now,
    exp: now + ttlSeconds,
  };
  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await sign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: string };

/**
 * Verify a token's signature and expiry. Uses a constant-time-ish comparison
 * of the recomputed signature to avoid trivial timing leaks.
 */
export async function verifyToken(secret: string, token: string): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const expected = await sign(signingInput, secret);
  if (!timingSafeEqual(signature, expected)) {
    return { ok: false, reason: "bad signature" };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(encodedPayload)) as TokenPayload;
  } catch {
    return { ok: false, reason: "unparseable payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) {
    return { ok: false, reason: "token expired" };
  }
  return { ok: true, payload };
}

/** Length-safe string equality that does not short-circuit on first mismatch. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFromHeader(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? (m[1] as string) : null;
}
