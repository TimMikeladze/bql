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

/**
 * The signing keys this bus will accept.
 *
 * Two or more at once is the whole point: rotation without downtime means a
 * window where tokens signed by the old key and the new one are both in
 * circulation. Rotation used to be the *only* revocation mechanism, so it had
 * to be possible to do it without invalidating every token in the fleet at
 * once.
 */
export interface Keyring {
  /** The key new tokens are signed with. */
  active: { kid: string; secret: string };
  /** Look up a key by id; `undefined` for anything retired or unknown. */
  secret(kid?: string): string | undefined;
}

/** A keyring with one unnamed key: what a bus with no rotation has. */
export function singleKey(secret: string, kid = "k0"): Keyring {
  return {
    active: { kid, secret },
    // A token minted before keys had ids carries no `kid`, and has to keep
    // verifying against the one key that exists.
    secret: () => secret,
  };
}

export function keyring(keys: Record<string, string>, active: string): Keyring {
  const secret = keys[active];
  if (secret === undefined)
    throw new TokenError(`the active key '${active}' is not in the keyring`);
  return {
    active: { kid: active, secret },
    secret: (kid) => (kid === undefined ? keys[active] : keys[kid]),
  };
}

function asKeyring(key: string | Keyring): Keyring {
  return typeof key === "string" ? singleKey(key) : key;
}

export function mint(claims: TokenClaims, key: string | Keyring): string {
  const ring = asKeyring(key);
  const stamped: TokenClaims = {
    ...claims,
    // Every token gets an id, so every token can be revoked. Minting one
    // without would create a credential nothing but rotation can withdraw.
    jti: claims.jti ?? crypto.randomUUID(),
    ...(typeof key === "string" ? {} : { kid: ring.active.kid }),
  };
  const payload = b64url(encoder.encode(JSON.stringify(stamped)));
  return `${payload}.${sign(payload, ring.active.secret)}`;
}

export class TokenError extends Error {}

/** Read the claims without checking anything. Only for choosing a key. */
function peek(payload: string): TokenClaims {
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    throw new TokenError("malformed token payload");
  }
}

export function verify(
  token: string,
  key: string | Keyring,
  now = Date.now,
): TokenClaims {
  const ring = asKeyring(key);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new TokenError("malformed token");
  const claims = peek(payload);
  const secret = ring.secret(claims.kid);
  if (secret === undefined)
    throw new TokenError(
      claims.kid
        ? `signing key '${claims.kid}' has been retired`
        : "no signing key for this token",
    );
  const expected = encoder.encode(sign(payload, secret));
  const provided = encoder.encode(signature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  )
    throw new TokenError("bad signature");
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
