// Verifying an identity provider's JWT (docs/plan-web.md, "Accounts"): what `/v1/session { jwt }`
// trusts in place of a visitor id. `auth.ts` verifies bql.sh's own EdDSA tokens against its own
// key ring; this verifies someone else's (Clerk, Supabase, Better-Auth, Auth0) against the keys
// they publish. WebCrypto only, no dependency.
//
// HS* is refused: an HMAC secret would have to be shared with this server, and anyone holding it
// could mint tokens for every user. `none` is refused for the obvious reason.

import { BqlError } from "./errors.ts"

export interface JwtProvider {
  issuer: string
  /** The provider's JWKS URL. */
  jwks: string
  /** When set, `aud` must equal it or, as an array, contain it. */
  audience?: string
}

export interface JwtVerifierOptions {
  fetch?: typeof fetch
  /** How long a fetched key set is used before it is read again. Default 10 minutes. */
  cacheMs?: number
  /** The least time between two reads of one URL forced by an unknown `kid`. Default 30 s. */
  refetchCooldownMs?: number
}

type Alg = "RS256" | "RS384" | "RS512" | "ES256" | "ES384" | "EdDSA"

type ImportParams = Parameters<typeof crypto.subtle.importKey>[2]
type VerifyParams = Parameters<typeof crypto.subtle.verify>[0]

const ALGS: Record<Alg, { kty: string; crv?: string; import: ImportParams; verify: VerifyParams }> = {
  RS256: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS384: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS512: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", crv: "P-256", import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { kty: "EC", crv: "P-384", import: { name: "ECDSA", namedCurve: "P-384" }, verify: { name: "ECDSA", hash: "SHA-384" } },
  EdDSA: { kty: "OKP", crv: "Ed25519", import: { name: "Ed25519" }, verify: { name: "Ed25519" } },
}

const SKEW_S = 30
const FETCH_TIMEOUT_MS = 5_000
const MAX_JWKS_BYTES = 256 * 1024
const MAX_JWT_BYTES = 16 * 1024

interface Jwk {
  kty?: string
  kid?: string
  alg?: string
  crv?: string
  use?: string
}

interface KeySet {
  atMs: number
  jwks: Jwk[]
  /** Imported keys, by `kid` and alg; a JWKS key with no `alg` may be imported under several. */
  imported: Map<string, Promise<CryptoKey | null>>
}

function unauthenticated(message: string): never {
  throw BqlError.unauthenticated(`jwt: ${message}`)
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) unauthenticated("not base64url")
  const standard = text.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function decodeJson(part: string, what: string): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as unknown
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // falls through to the refusal
  }
  unauthenticated(`the ${what} is not a JSON object`)
}

/** Checks provider JWTs against provider keys, caching each JWKS URL's keys per verifier. */
export class JwtVerifier {
  readonly #fetch: typeof fetch
  readonly #cacheMs: number
  readonly #cooldownMs: number
  readonly #sets = new Map<string, KeySet>()
  readonly #inflight = new Map<string, Promise<KeySet>>()
  readonly #lastForcedMs = new Map<string, number>()

  constructor(options: JwtVerifierOptions = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#cacheMs = options.cacheMs ?? 10 * 60_000
    this.#cooldownMs = options.refetchCooldownMs ?? 30_000
  }

  /**
   * Returns the token's claims, or throws `UNAUTHENTICATED` naming the check that failed, or
   * `IDP_UNAVAILABLE` when the provider's keys cannot be read. `nowMs` is for tests.
   */
  async verify(jwt: string, provider: JwtProvider, nowMs = Date.now()): Promise<Record<string, unknown>> {
    if (jwt.length > MAX_JWT_BYTES) unauthenticated("token is too large")
    const parts = jwt.split(".")
    if (parts.length !== 3) unauthenticated("not a compact JWS (three dot-separated parts)")
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    const header = decodeJson(headerPart, "header")
    const alg = header.alg
    if (typeof alg !== "string" || !(alg in ALGS)) {
      unauthenticated(`alg ${JSON.stringify(alg)} is not accepted (RS256/384/512, ES256/384, EdDSA)`)
    }
    const kid = typeof header.kid === "string" ? header.kid : null
    const claims = decodeJson(payloadPart, "payload")
    const signature = fromBase64Url(signaturePart)
    const input = new TextEncoder().encode(`${headerPart}.${payloadPart}`)

    let set = await this.#keys(provider.jwks, false, nowMs)
    let candidates = this.#candidates(set, alg as Alg, kid)
    // A kid the cached set lacks may be a key the provider rotated in since: read once more.
    if (candidates.length === 0 && kid !== null && this.#mayForce(provider.jwks, set, nowMs)) {
      set = await this.#keys(provider.jwks, true, nowMs)
      candidates = this.#candidates(set, alg as Alg, kid)
    }
    if (candidates.length === 0) unauthenticated(kid === null ? `no ${alg} key in the provider's JWKS` : `the provider has no key ${kid}`)
    let valid = false
    for (const jwk of candidates) {
      const key = await this.#import(set, jwk, alg as Alg)
      if (key && (await crypto.subtle.verify(ALGS[alg as Alg].verify, key, signature, input))) {
        valid = true
        break
      }
    }
    if (!valid) unauthenticated("bad signature")

    const nowS = nowMs / 1000
    if (claims.iss !== provider.issuer) unauthenticated(`iss ${JSON.stringify(claims.iss)} is not ${provider.issuer}`)
    if (typeof claims.exp !== "number") unauthenticated("no exp")
    if (claims.exp + SKEW_S < nowS) unauthenticated("expired")
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - SKEW_S > nowS)) unauthenticated("not valid yet (nbf)")
    if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat - SKEW_S > nowS)) unauthenticated("issued in the future (iat)")
    if (provider.audience !== undefined) {
      const aud = claims.aud
      const ok = Array.isArray(aud) ? aud.includes(provider.audience) : aud === provider.audience
      if (!ok) unauthenticated(`aud ${JSON.stringify(aud)} does not name ${provider.audience}`)
    }
    return claims
  }

  #candidates(set: KeySet, alg: Alg, kid: string | null): Jwk[] {
    const want = ALGS[alg]
    return set.jwks.filter(
      (jwk) =>
        (kid === null || jwk.kid === kid) &&
        jwk.kty === want.kty &&
        (want.crv === undefined || jwk.crv === want.crv) &&
        (jwk.alg === undefined || jwk.alg === alg) &&
        (jwk.use === undefined || jwk.use === "sig"),
    )
  }

  #mayForce(url: string, set: KeySet, nowMs: number): boolean {
    if (nowMs - set.atMs < this.#cooldownMs) return false
    const last = this.#lastForcedMs.get(url)
    if (last !== undefined && nowMs - last < this.#cooldownMs) return false
    this.#lastForcedMs.set(url, nowMs)
    return true
  }

  #import(set: KeySet, jwk: Jwk, alg: Alg): Promise<CryptoKey | null> {
    const id = `${jwk.kid ?? set.jwks.indexOf(jwk)}|${alg}`
    let key = set.imported.get(id)
    if (!key) {
      // `alg`, `use` and `key_ops` in a JWK make importKey stricter than this needs; the checks
      // above already matched them.
      const { alg: _alg, use: _use, key_ops: _ops, ...bare } = jwk as Jwk & { key_ops?: unknown }
      key = crypto.subtle
        .importKey("jwk", bare as never, ALGS[alg].import, false, ["verify"])
        .catch(() => null)
      set.imported.set(id, key)
    }
    return key
  }

  async #keys(url: string, force: boolean, nowMs: number): Promise<KeySet> {
    const cached = this.#sets.get(url)
    if (cached && !force && nowMs - cached.atMs < this.#cacheMs) return cached
    let pending = this.#inflight.get(url)
    if (!pending) {
      pending = this.#read(url, nowMs).finally(() => this.#inflight.delete(url))
      this.#inflight.set(url, pending)
    }
    try {
      const set = await pending
      this.#sets.set(url, set)
      return set
    } catch (err) {
      // A provider outage should not lock out users whose keys we already hold.
      if (cached) return cached
      throw err
    }
  }

  async #read(url: string, nowMs: number): Promise<KeySet> {
    const unavailable = (why: string) => new BqlError("IDP_UNAVAILABLE", `could not read the identity provider's keys at ${url}: ${why}`, 503)
    let response: Response
    try {
      response = await this.#fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (err) {
      throw unavailable(err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable")
    }
    if (!response.ok) throw unavailable(`answered ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_JWKS_BYTES) throw unavailable("over 256 KiB")
    let body: { keys?: unknown }
    try {
      body = JSON.parse(text) as { keys?: unknown }
    } catch {
      throw unavailable("not JSON")
    }
    if (!Array.isArray(body.keys)) throw unavailable("no keys array")
    return { atMs: nowMs, jwks: body.keys.filter((k): k is Jwk => typeof k === "object" && k !== null), imported: new Map() }
  }
}
