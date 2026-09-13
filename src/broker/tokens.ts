import { timingSafeEqual } from "node:crypto";
import type { Labels, TokenClaims } from "../shared/protocol";
import { ANY } from "../shared/protocol";

/**
 * Per-worker capability tokens.
 *
 * The prototype had one shared secret that granted every worker operation, so
 * any holder could claim any task and impersonate any worker. A token here
 * names exactly one worker id, the runtimes it may execute, and the labels it
 * may advertise. Verification is a signature check plus a claims check, with no
 * database round trip, so revocation is by key rotation or expiry rather than a
 * lookup on the hot path — the trade a stateless token always makes.
 */

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (text: string) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

function sign(payload: string, key: string): string {
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(payload);
  return b64url(new Uint8Array(hasher.digest()));
}

export function mint(claims: TokenClaims, key: string): string {
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${sign(payload, key)}`;
}

export class TokenError extends Error {}

export function verify(
  token: string,
  key: string,
  now = Date.now,
): TokenClaims {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new TokenError("malformed token");
  const expected = encoder.encode(sign(payload, key));
  const provided = encoder.encode(signature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  )
    throw new TokenError("bad signature");
  let claims: TokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    throw new TokenError("malformed token payload");
  }
  if (claims.exp !== 0 && claims.exp * 1000 <= now())
    throw new TokenError("token expired");
  if (!["worker", "reader", "admin"].includes(claims.scope))
    throw new TokenError("unknown token scope");
  return claims;
}

/** A worker may only register the runtimes and labels its token allows. */
export function authorizeRegistration(
  claims: TokenClaims,
  workerId: string,
  runtimes: string[],
  labels: Labels,
): void {
  if (claims.scope === "admin") return;
  if (claims.sub !== workerId)
    throw new TokenError(`token is issued for worker '${claims.sub}'`);
  if (!claims.runtimes.includes(ANY))
    for (const runtime of runtimes)
      if (!claims.runtimes.includes(runtime))
        throw new TokenError(`token does not allow runtime '${runtime}'`);
  for (const [key, value] of Object.entries(claims.labels))
    if (labels[key] !== value)
      throw new TokenError(`token pins label ${key}=${value}`);
}

export function authorizeWorker(claims: TokenClaims, workerId: string): void {
  if (claims.scope === "admin") return;
  if (claims.sub !== workerId)
    throw new TokenError(`token is issued for worker '${claims.sub}'`);
}

export function generateKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
