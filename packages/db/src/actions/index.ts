// `bql.sh/actions`: what the owner's function imports to accept a `url` action from bql.sh
// (docs/plan-web.md). bql.sh POSTs the checked input, the caller and a short-lived token, signed
// with its Ed25519 key; `verifyAction` checks the signature against the server's published keys,
// the expiry and the URL, and returns the call. The function holds no bql.sh secret.
//
// WebCrypto and fetch only, so it runs in Bun, Node 20+, Deno and Workers alike.
//
//   import { verifyAction } from "bql.sh/actions"
//
//   export default async function (request: Request) {
//     const call = await verifyAction(request, { bql: "https://db.acme.app" })
//     // call.input, call.user, call.token (rw on call.dbs.shared and call.dbs.private, ~60 s)
//     return Response.json({ ok: true })
//   }

/** What bql.sh sends, once verified. */
export interface ActionCall {
  v: 1
  app: string
  action: string
  /** The input after bql.sh checked it against the action's schema (a bool arrives as 0 or 1). */
  input: Record<string, string | number | null>
  /** The caller's sub: their rows' `author`, and the suffix of their own database. */
  user: string
  url: string
  iat: number
  exp: number
  nonce: string
  /** Bearer for bql.sh: `rw` on both databases below, no table ACL, `sub` = `user`. */
  token: string
  dbs: { shared: string; private: string }
}

export interface VerifyOptions {
  /** The bql.sh server's base URL; its keys are read from `<bql>/.well-known/jwks.json`. */
  bql: string
  /**
   * The URL the action is configured with. Default: the request's own URL, which is wrong behind
   * a proxy that rewrites it, so pass it there.
   */
  url?: string
  fetch?: typeof fetch
  /** Seconds since the epoch; for tests. */
  now?: number
}

export class ActionVerifyError extends Error {
  readonly status = 401
  constructor(message: string) {
    super(message)
    this.name = "ActionVerifyError"
  }
}

const PREFIX = "bql-action:"
const KEY_CACHE_MS = 5 * 60_000
const SKEW_S = 30
const keyCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>()

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const standard = text.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function keysOf(bql: string, doFetch: typeof fetch, refresh: boolean): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(bql)
  if (cached && !refresh && Date.now() - cached.at < KEY_CACHE_MS) return cached.keys
  const response = await doFetch(`${bql.replace(/\/+$/, "")}/.well-known/jwks.json`)
  if (!response.ok) throw new ActionVerifyError(`could not read ${bql}/.well-known/jwks.json (${response.status})`)
  const body = (await response.json()) as { keys?: { kid?: string; crv?: string; x?: string }[] }
  const keys = new Map<string, CryptoKey>()
  for (const jwk of body.keys ?? []) {
    if (jwk.crv !== "Ed25519" || !jwk.kid || !jwk.x) continue
    keys.set(jwk.kid, await crypto.subtle.importKey("raw", fromBase64Url(jwk.x), { name: "Ed25519" }, false, ["verify"]))
  }
  keyCache.set(bql, { at: Date.now(), keys })
  return keys
}

/**
 * Checks a request from bql.sh and returns the call. Throws `ActionVerifyError` (answer 401) for
 * a missing or bad signature, an unknown key, an expired call or one signed for another URL.
 */
export async function verifyAction(request: Request, options: VerifyOptions): Promise<ActionCall> {
  const doFetch = options.fetch ?? fetch
  const signature = request.headers.get("bql-signature")
  const kid = request.headers.get("bql-key-id")
  if (!signature || !kid) throw new ActionVerifyError("not a bql.sh action request: no bql-signature")
  const body = await request.text()
  // An unknown kid may be a key the server rotated in since the cache was filled: read once more.
  let key = (await keysOf(options.bql, doFetch, false)).get(kid)
  key ??= (await keysOf(options.bql, doFetch, true)).get(kid)
  if (!key) throw new ActionVerifyError(`bql.sh has no key ${kid}`)
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(PREFIX + body),
  )
  if (!valid) throw new ActionVerifyError("the signature does not match the body")
  const call = JSON.parse(body) as ActionCall
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (call.v !== 1) throw new ActionVerifyError(`unknown action request version ${String(call.v)}`)
  if (call.exp < now) throw new ActionVerifyError("the action request has expired")
  if (call.iat > now + SKEW_S) throw new ActionVerifyError("the action request is from the future")
  const expected = options.url ?? request.url
  if (call.url !== expected) throw new ActionVerifyError(`signed for ${call.url}, received at ${expected}`)
  return call
}
