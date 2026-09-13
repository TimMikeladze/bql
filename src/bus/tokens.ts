import { timingSafeEqual } from "node:crypto";
import type { TokenClaims } from "../shared/protocol";
import { ANY } from "../shared/protocol";
import { matches } from "./subjects";

/**
 * Scoped bearer tokens.
 *
 * A token names the workspace it belongs to, the subject patterns it may
 * publish to, and the subscriptions it may claim from. Verification is a
 * signature check plus a claims check with no database round trip, which is the
 * trade a stateless token always makes: revocation is by expiry or key
 * rotation, not by a lookup on the hot path.
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
  if (!["consumer", "reader", "admin"].includes(claims.scope))
    throw new TokenError("unknown token scope");
  return claims;
}

export function authorizePublish(claims: TokenClaims, subject: string): void {
  if (claims.scope === "admin") return;
  if (claims.scope === "reader")
    throw new TokenError("a reader token may not publish");
  if (claims.publish.includes(ANY)) return;
  // A grant is a pattern, so `orders.>` licenses every subject beneath it.
  if (!claims.publish.some((pattern) => matches(pattern, subject)))
    throw new TokenError(`token may not publish to '${subject}'`);
}

export function authorizeSubscribe(
  claims: TokenClaims,
  subscription: string,
): void {
  if (claims.scope === "admin") return;
  if (claims.scope === "reader")
    throw new TokenError("a reader token may not consume");
  if (claims.subscribe.includes(ANY)) return;
  if (!claims.subscribe.includes(subscription))
    throw new TokenError(`token may not consume from '${subscription}'`);
}

export function authorizeConsumer(claims: TokenClaims, consumerId: string): void {
  if (claims.scope === "admin") return;
  if (claims.sub !== consumerId)
    throw new TokenError(`token is issued for consumer '${claims.sub}'`);
}

export function generateKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
