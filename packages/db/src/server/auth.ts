// Invariant: a token can only widen its own scope by being re-minted. Everything a request is
// allowed to do is decided here, once, from claims that were signed — never from anything the
// request body says — and is then enforced by SQLite itself (`query_only` plus the authorizer),
// so a statement that slips past the router still cannot read or write outside the token.
//
// Two facts the policy relies on, both verified against the driver in test/server/policy.test.ts:
// installing an authorizer re-authorizes statements already in the connection's prepared-statement
// cache, and `query_only` is enforced when a statement steps, not when it is prepared. So a
// pooled connection can be re-scoped between requests without clearing its cache.

import {
  SQLITE_ALTER_TABLE,
  SQLITE_ANALYZE,
  SQLITE_ATTACH,
  SQLITE_COPY,
  SQLITE_CREATE_INDEX,
  SQLITE_CREATE_TABLE,
  SQLITE_CREATE_TEMP_INDEX,
  SQLITE_CREATE_TEMP_TABLE,
  SQLITE_CREATE_TEMP_TRIGGER,
  SQLITE_CREATE_TEMP_VIEW,
  SQLITE_CREATE_TRIGGER,
  SQLITE_CREATE_VIEW,
  SQLITE_CREATE_VTABLE,
  SQLITE_DELETE,
  SQLITE_DENY,
  SQLITE_DETACH,
  SQLITE_DROP_INDEX,
  SQLITE_DROP_TABLE,
  SQLITE_DROP_TEMP_INDEX,
  SQLITE_DROP_TEMP_TABLE,
  SQLITE_DROP_TEMP_TRIGGER,
  SQLITE_DROP_TEMP_VIEW,
  SQLITE_DROP_TRIGGER,
  SQLITE_DROP_VIEW,
  SQLITE_DROP_VTABLE,
  SQLITE_FUNCTION,
  SQLITE_IGNORE,
  SQLITE_INSERT,
  SQLITE_OK,
  SQLITE_PRAGMA,
  SQLITE_READ,
  SQLITE_REINDEX,
  SQLITE_UPDATE,
} from "../sqlite/constants.ts"
import type { Authorizer, Database } from "../sqlite/index.ts"
import { VIRTUAL_TABLES_SQL, shadowOwner, virtualTables } from "../sqlite/shadow.ts"
import { BqlError } from "./errors.ts"
import { fromBase64, toBase64Url } from "./json.ts"

// ── Claims (design §6: libsql's shape, extended with `t` and a real `jti`/`kid`) ────────────────

/** Access to one table: read, or read and write. */
export type TableScope = "r" | "rw"

/** Access to a database as a whole. */
export type Scope = "rw" | "ro"

export interface NamespaceGrant {
  /** Database name globs, e.g. `["acme", "acme-*"]`. */
  ns: string[]
}

export interface TokenPermissions {
  ro?: NamespaceGrant
  rw?: NamespaceGrant
}

export interface TokenClaims {
  p?: TokenPermissions
  /** Per-table ACL. When present, tables not listed here are invisible to the token. */
  t?: Record<string, TableScope>
  /** Expiry, seconds since the epoch. */
  exp?: number
  /** Not valid before, seconds since the epoch. */
  nbf?: number
  /** Issued at, seconds since the epoch. */
  iat: number
  /** Token id, for revocation. */
  jti: string
  /** Signing key id, mirrored from the JWT header. */
  kid?: string
  sub?: string
}

export interface JwtHeader {
  alg: "EdDSA"
  typ?: string
  kid?: string
}

// bun-types builds the WebCrypto globals out of node's own declarations but does not re-export
// the helper type names those signatures use. These are type positions only: nothing about
// node is imported at runtime.
type WebCryptoAlgorithm = import("node:crypto").webcrypto.AlgorithmIdentifier
type WebCryptoKeyUsage = import("node:crypto").webcrypto.KeyUsage

/** A JSON Web Key in the shape `crypto.subtle` imports and exports. */
export type Ed25519Jwk = import("node:crypto").webcrypto.JsonWebKey

/** Bytes over a plain ArrayBuffer, which is all WebCrypto takes. */
type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ED25519: WebCryptoAlgorithm = { name: "Ed25519" }

/** No view this module makes is SharedArrayBuffer-backed; this says so to the type checker. */
function src(bytes: Uint8Array): Bytes {
  return bytes as Bytes
}

function encodeSegment(value: unknown): string {
  return toBase64Url(encoder.encode(JSON.stringify(value)))
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(decoder.decode(fromBase64(segment)))
  } catch {
    throw BqlError.unauthenticated("token is not valid JWT")
  }
}

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One Ed25519 signing key. `kid` is derived from the public key, so the same key always has the
 * same id wherever it is loaded and rotation needs no registry.
 */
export class AuthKeys {
  readonly kid: string
  readonly publicKey: CryptoKey
  readonly privateKey: CryptoKey | null
  readonly rawPublicKey: Uint8Array

  private constructor(
    kid: string,
    publicKey: CryptoKey,
    privateKey: CryptoKey | null,
    rawPublicKey: Uint8Array,
  ) {
    this.kid = kid
    this.publicKey = publicKey
    this.privateKey = privateKey
    this.rawPublicKey = rawPublicKey
  }

  /** True when this key can mint tokens as well as check them. */
  get canSign(): boolean {
    return this.privateKey !== null
  }

  static async generate(): Promise<AuthKeys> {
    const pair = (await crypto.subtle.generateKey(ED25519, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
    return new AuthKeys(await deriveKid(raw), pair.publicKey, pair.privateKey, raw)
  }

  /** Loads a private key from PKCS#8 DER, or from its base64 text. */
  static async fromPkcs8(pkcs8: Uint8Array | string): Promise<AuthKeys> {
    const bytes = typeof pkcs8 === "string" ? fromBase64(pkcs8) : pkcs8
    const privateKey = await importOrFail("pkcs8", bytes, ["sign"])
    const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as Ed25519Jwk
    if (typeof jwk.x !== "string") {
      throw BqlError.badRequest("private key does not carry its public half")
    }
    const raw = fromBase64(jwk.x)
    const publicKey = await importOrFail("raw", raw, ["verify"])
    return new AuthKeys(await deriveKid(raw), publicKey, privateKey, raw)
  }

  /** Loads a verify-only key from its 32 raw public bytes, or their base64 text. */
  static async fromRawPublic(raw: Uint8Array | string): Promise<AuthKeys> {
    const bytes = typeof raw === "string" ? fromBase64(raw) : raw
    if (bytes.byteLength !== 32) {
      throw BqlError.badRequest(`an Ed25519 public key is 32 bytes, got ${bytes.byteLength}`)
    }
    const publicKey = await importOrFail("raw", bytes, ["verify"])
    return new AuthKeys(await deriveKid(bytes), publicKey, null, bytes)
  }

  /** Loads either half from a JWK (`kty: "OKP"`, `crv: "Ed25519"`). */
  static async fromJwk(jwk: Ed25519Jwk): Promise<AuthKeys> {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      throw BqlError.badRequest("expected an OKP/Ed25519 JWK")
    }
    if (typeof jwk.x !== "string") throw BqlError.badRequest("JWK has no public component")
    const raw = fromBase64(jwk.x)
    const publicKey = await importOrFail("raw", raw, ["verify"])
    if (typeof jwk.d !== "string") {
      return new AuthKeys(await deriveKid(raw), publicKey, null, raw)
    }
    const privateKey = (await crypto.subtle.importKey(
      "jwk",
      { ...jwk, key_ops: ["sign"] },
      ED25519,
      true,
      ["sign"],
    )) as CryptoKey
    return new AuthKeys(await deriveKid(raw), publicKey, privateKey, raw)
  }

  exportRawPublic(): Uint8Array {
    return this.rawPublicKey
  }

  async exportPkcs8(): Promise<Bytes> {
    if (!this.privateKey) throw BqlError.badRequest("this key has no private half")
    return new Uint8Array(await crypto.subtle.exportKey("pkcs8", this.privateKey))
  }

  async exportJwk(which: "public" | "private" = "public"): Promise<Ed25519Jwk> {
    if (which === "private") {
      if (!this.privateKey) throw BqlError.badRequest("this key has no private half")
      return (await crypto.subtle.exportKey("jwk", this.privateKey)) as Ed25519Jwk
    }
    return (await crypto.subtle.exportKey("jwk", this.publicKey)) as Ed25519Jwk
  }

  async sign(data: Uint8Array): Promise<Bytes> {
    if (!this.privateKey) throw BqlError.badRequest("this key has no private half")
    return new Uint8Array(await crypto.subtle.sign(ED25519, this.privateKey, src(data)))
  }

  verify(data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return crypto.subtle.verify(ED25519, this.publicKey, src(signature), src(data))
  }
}

async function importOrFail(
  format: "raw" | "pkcs8",
  bytes: Uint8Array,
  usages: WebCryptoKeyUsage[],
): Promise<CryptoKey> {
  try {
    return (await crypto.subtle.importKey(
      format as "raw",
      src(bytes),
      ED25519,
      true,
      usages,
    )) as CryptoKey
  } catch {
    throw BqlError.badRequest(`not a usable Ed25519 ${format} key`)
  }
}

/** First 16 base64url characters of SHA-256 over the raw public key. */
async function deriveKid(rawPublicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", src(rawPublicKey))
  return toBase64Url(new Uint8Array(digest)).slice(0, 16)
}

/** The keys this node trusts. Verification picks by `kid`; minting uses the active key. */
export class KeyRing {
  #keys = new Map<string, AuthKeys>()
  #signingKid: string | null = null
  #version = 0

  constructor(keys: readonly AuthKeys[] = []) {
    for (const key of keys) this.add(key)
  }

  /** Adds a key; the first signing-capable key added becomes the active one. */
  add(key: AuthKeys): this {
    this.#keys.set(key.kid, key)
    if (key.canSign && this.#signingKid === null) this.#signingKid = key.kid
    this.#version += 1
    return this
  }

  /**
   * Bumped by every change to the ring. `SignatureCache` records it beside each entry, so a key
   * added or rotated out invalidates every signature that ring had vouched for.
   */
  get version(): number {
    return this.#version
  }

  get(kid: string): AuthKeys | undefined {
    return this.#keys.get(kid)
  }

  list(): AuthKeys[] {
    return [...this.#keys.values()]
  }

  get size(): number {
    return this.#keys.size
  }

  /** The key new tokens are signed with. */
  get signing(): AuthKeys {
    const key = this.#signingKid ? this.#keys.get(this.#signingKid) : undefined
    if (!key) throw new BqlError("INTERNAL", "no signing key is configured", 500)
    return key
  }

  setSigning(kid: string): this {
    const key = this.#keys.get(kid)
    if (!key?.canSign) throw BqlError.badRequest(`no signing key with kid ${kid}`)
    this.#signingKid = kid
    this.#version += 1
    return this
  }

  /**
   * The only key on the ring, when there is exactly one. A token minted before `kid` existed
   * (or minted elsewhere without one) still verifies on a single-key node.
   */
  soleKey(): AuthKeys | undefined {
    return this.#keys.size === 1 ? this.#keys.values().next().value : undefined
  }
}

// ── Revocation ─────────────────────────────────────────────────────────────────────────────────

export interface RevocationList {
  isRevoked(jti: string): boolean | Promise<boolean>
}

/** Process-local revocations. A cluster backs this with the catalog database instead. */
export class MemoryRevocationList implements RevocationList {
  /** jti → the second after which the entry can be dropped, or Infinity. */
  #revoked = new Map<string, number>()

  revoke(jti: string, expiresAtSec = Number.POSITIVE_INFINITY): void {
    this.#revoked.set(jti, expiresAtSec)
  }

  restore(jti: string): void {
    this.#revoked.delete(jti)
  }

  isRevoked(jti: string): boolean {
    return this.#revoked.has(jti)
  }

  /** Drops entries whose token has expired anyway. */
  purge(nowSec = Math.floor(Date.now() / 1000)): void {
    for (const [jti, expiry] of this.#revoked) {
      if (expiry <= nowSec) this.#revoked.delete(jti)
    }
  }

  get size(): number {
    return this.#revoked.size
  }
}

// ── Minting and verification ───────────────────────────────────────────────────────────────────

export interface TokenGrant {
  /** Database name globs this token may read. */
  ro?: readonly string[]
  /** Database name globs this token may read and write. */
  rw?: readonly string[]
  /** Optional per-table ACL, e.g. `{todos: "r", users: "rw"}`. */
  tables?: Readonly<Record<string, TableScope>>
  sub?: string
  /** Lifetime in milliseconds. Omit for a token that never expires. */
  ttlMs?: number
  jti?: string
  /** Clock override, milliseconds since the epoch. */
  now?: number
}

/** Claims for a grant, without signing them. */
export function claimsFor(grant: TokenGrant): TokenClaims {
  const iat = Math.floor((grant.now ?? Date.now()) / 1000)
  const p: TokenPermissions = {}
  if (grant.ro?.length) p.ro = { ns: [...grant.ro] }
  if (grant.rw?.length) p.rw = { ns: [...grant.rw] }
  const claims: TokenClaims = { iat, jti: grant.jti ?? crypto.randomUUID() }
  if (p.ro || p.rw) claims.p = p
  if (grant.tables && Object.keys(grant.tables).length > 0) claims.t = { ...grant.tables }
  if (grant.ttlMs !== undefined) claims.exp = iat + Math.floor(grant.ttlMs / 1000)
  if (grant.sub !== undefined) claims.sub = grant.sub
  return claims
}

/** Signs a grant as an EdDSA JWT. */
export async function mintToken(key: AuthKeys, grant: TokenGrant = {}): Promise<string> {
  const claims = claimsFor(grant)
  claims.kid = key.kid
  const header: JwtHeader = { alg: "EdDSA", typ: "JWT", kid: key.kid }
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`
  const signature = await key.sign(encoder.encode(signingInput))
  return `${signingInput}.${toBase64Url(signature)}`
}

export interface VerifyOptions {
  /** Clock override, milliseconds since the epoch. */
  now?: number
  /** Slack on `exp` and `nbf`, in seconds. Default 30. */
  clockToleranceSec?: number
  revocations?: RevocationList
  /**
   * Skips the **signature check** for a token whose signature this ring has already checked, and
   * nothing else: expiry, not-before and revocation are re-evaluated on a hit exactly as on a
   * miss, because those are the inputs that change between two requests carrying one token.
   */
  cache?: SignatureCache
}

/**
 * Verified signatures, by token. A signature is a pure function of the token and the key ring, so
 * caching it removes arithmetic and no decision: `verifyToken` still re-checks `exp`, `nbf` and
 * the revocation list on every hit, and an entry is bound to the ring version that vouched for it,
 * so rotating a key out invalidates every signature it had signed.
 *
 * An EdDSA verification measures 28.3 µs, which is most of an HTTP request that does a point read
 * (`docs/performance.md` §2). Bounded, because the keys are attacker-supplied: past `max` the
 * least recently used entry goes.
 */
export class SignatureCache {
  /** Insertion order is the LRU order; a hit re-inserts. */
  #entries = new Map<string, { claims: TokenClaims; ringVersion: number }>()
  readonly max: number

  constructor(max = 1024) {
    this.max = Math.max(0, Math.floor(max))
  }

  get size(): number {
    return this.#entries.size
  }

  get(token: string, ringVersion: number): TokenClaims | undefined {
    const hit = this.#entries.get(token)
    if (!hit) return undefined
    if (hit.ringVersion !== ringVersion) {
      this.#entries.delete(token)
      return undefined
    }
    this.#entries.delete(token)
    this.#entries.set(token, hit)
    return hit.claims
  }

  set(token: string, claims: TokenClaims, ringVersion: number): void {
    if (this.max === 0) return
    this.#entries.delete(token)
    this.#entries.set(token, { claims, ringVersion })
    while (this.#entries.size > this.max) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  /** Drops one token, which is what a revocation does. */
  delete(token: string): void {
    this.#entries.delete(token)
  }

  clear(): void {
    this.#entries.clear()
  }
}

/**
 * Checks an EdDSA JWT against the ring and returns its claims. Every failure is a 401 with a
 * short reason; nothing about the key material reaches the client.
 */
export async function verifyToken(
  ring: KeyRing,
  token: string,
  options: VerifyOptions = {},
): Promise<TokenClaims> {
  const cached = options.cache?.get(token, ring.version)
  if (cached) return checkClaims(cached, token, options)

  const parts = token.split(".")
  if (parts.length !== 3) throw BqlError.unauthenticated("token is not a JWT")
  const [headerText, claimsText, signatureText] = parts as [string, string, string]

  const header = decodeSegment(headerText) as JwtHeader
  if (!header || typeof header !== "object") throw BqlError.unauthenticated("malformed JWT header")
  if (header.alg !== "EdDSA") {
    throw BqlError.unauthenticated(`unsupported JWT algorithm ${String(header.alg)}`)
  }
  if (header.typ !== undefined && header.typ.toUpperCase() !== "JWT") {
    throw BqlError.unauthenticated(`unsupported JWT type ${String(header.typ)}`)
  }

  const key = header.kid ? ring.get(header.kid) : ring.soleKey()
  if (!key) throw BqlError.unauthenticated("token was signed by an unknown key")

  let signature: Uint8Array
  try {
    signature = fromBase64(signatureText)
  } catch {
    throw BqlError.unauthenticated("malformed JWT signature")
  }
  const ok = await key.verify(encoder.encode(`${headerText}.${claimsText}`), signature)
  if (!ok) throw BqlError.unauthenticated("token signature does not check out")

  const claims = decodeSegment(claimsText) as TokenClaims
  if (!claims || typeof claims !== "object") throw BqlError.unauthenticated("malformed JWT claims")
  if (typeof claims.jti !== "string" || claims.jti.length === 0) {
    throw BqlError.unauthenticated("token has no jti")
  }
  if (claims.kid !== undefined && header.kid !== undefined && claims.kid !== header.kid) {
    throw BqlError.unauthenticated("token header and claims disagree about the key")
  }

  options.cache?.set(token, claims, ring.version)
  return checkClaims(claims, token, options)
}

/**
 * Everything about a token that is not its signature. Called on a cache hit and on a miss, so the
 * two answer identically — a cached token that has since expired or been revoked is refused, and
 * evicted on the way out.
 */
async function checkClaims(
  claims: TokenClaims,
  token: string,
  options: VerifyOptions,
): Promise<TokenClaims> {
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000)
  const slack = options.clockToleranceSec ?? 30
  if (typeof claims.exp === "number" && claims.exp + slack < nowSec) {
    options.cache?.delete(token)
    throw BqlError.unauthenticated("token has expired")
  }
  if (typeof claims.nbf === "number" && claims.nbf - slack > nowSec) {
    throw BqlError.unauthenticated("token is not valid yet")
  }
  if (options.revocations && (await options.revocations.isRevoked(claims.jti))) {
    options.cache?.delete(token)
    throw BqlError.unauthenticated("token has been revoked")
  }
  return claims
}

// ── Principals ─────────────────────────────────────────────────────────────────────────────────

export interface AdminPrincipal {
  readonly kind: "admin"
}

export interface TokenPrincipal {
  readonly kind: "token"
  readonly claims: TokenClaims
  /** Per-table ACL, when the token carries one. */
  readonly tables?: Readonly<Record<string, TableScope>>
  /** Widest access this token has to `db`, or null when it has none. */
  scopeFor(db: string): Scope | null
}

export type Principal = AdminPrincipal | TokenPrincipal

export const ADMIN: AdminPrincipal = Object.freeze({ kind: "admin" })

/**
 * Anchored glob over a database name: `*` matches any run of characters, `?` exactly one.
 * Matched without regular expressions so a pattern from a token cannot be a denial of service.
 */
export function globMatch(pattern: string, value: string): boolean {
  let p = 0
  let v = 0
  let star = -1
  let mark = 0
  while (v < value.length) {
    const pc = pattern[p]
    if (p < pattern.length && (pc === "?" || pc === value[v])) {
      p++
      v++
    } else if (p < pattern.length && pc === "*") {
      star = p++
      mark = v
    } else if (star >= 0) {
      p = star + 1
      v = ++mark
    } else {
      return false
    }
  }
  while (pattern[p] === "*") p++
  return p === pattern.length
}

function matchesAny(globs: readonly string[] | undefined, db: string): boolean {
  if (!globs) return false
  for (const glob of globs) {
    if (globMatch(glob, db)) return true
  }
  return false
}

export function tokenPrincipal(claims: TokenClaims): TokenPrincipal {
  const tables = claims.t
  return {
    kind: "token",
    claims,
    ...(tables ? { tables } : {}),
    scopeFor(db: string): Scope | null {
      if (matchesAny(claims.p?.rw?.ns, db)) return "rw"
      if (matchesAny(claims.p?.ro?.ns, db)) return "ro"
      return null
    },
  }
}

/**
 * Who a pin belongs to, for `[limits] maxPinnedPerPrincipal` (L4). A pin lasts as long as a client
 * keeps a subscription open, so it is charged to the identity behind the token — `sub` when the
 * token names one, and the token id otherwise, which is the honest fallback when it does not.
 *
 * The admin key is **not** capped: it is the operator, and refusing the operator's own
 * subscription because they have sixty-five of them would be a worse failure than the one this
 * ceiling prevents.
 */
export interface PinHolder {
  /** The key pins are grouped under in `TenantRegistry`. */
  readonly owner: string
  /** Whether this holder is charged against `[limits] maxPinnedPerPrincipal`. */
  readonly capped: boolean
}

/**
 * A holder that is not a client: the embedded API, a replica stream, the node's own housekeeping.
 * None of them is the thing `maxPinnedPerPrincipal` exists to bound, and one of them is the
 * in-process caller who owns the machine.
 */
export const INTERNAL_HOLDER: PinHolder = Object.freeze({ owner: "default", capped: false })

export function pinOwner(principal: Principal): PinHolder {
  if (principal.kind === "admin") return { owner: "admin", capped: false }
  const claims = principal.claims
  return { owner: `p:${claims.sub ?? claims.jti}`, capped: true }
}

/** Raises 403 unless the principal has at least `need` on `db`; returns its actual scope. */
export function requireScope(principal: Principal, db: string, need: Scope): Scope {
  if (principal.kind === "admin") return "rw"
  const scope = principal.scopeFor(db)
  if (scope === null) throw BqlError.notAuthorized(`token has no access to database ${db}`)
  if (need === "rw" && scope !== "rw") {
    throw BqlError.notAuthorized(`token is read-only on database ${db}`)
  }
  return scope
}

// ── Authenticating a request ───────────────────────────────────────────────────────────────────

export interface AuthenticatorOptions {
  keys?: KeyRing | AuthKeys | readonly AuthKeys[]
  /** Config admin key for the lifecycle routes. Presented as a bearer token. */
  adminKey?: string | null
  revocations?: RevocationList
  clockToleranceSec?: number
  /**
   * Verified signatures held, so a client that sends one token per request pays for its EdDSA
   * verification once rather than 28 µs every time. `0` turns the cache off. Expiry and revocation
   * are re-checked on every request either way — see `SignatureCache`.
   */
  verifyCacheSize?: number
  /** Clock override, milliseconds since the epoch. */
  now?: () => number
}

export class Authenticator {
  readonly keys: KeyRing
  readonly revocations: RevocationList | undefined
  /** Verified signatures for this ring. Null when the node turned the cache off. */
  readonly signatures: SignatureCache | null
  #adminKey: Uint8Array | null
  #clockToleranceSec: number
  #now: () => number

  constructor(options: AuthenticatorOptions = {}) {
    const keys = options.keys
    this.keys =
      keys instanceof KeyRing
        ? keys
        : new KeyRing(keys === undefined ? [] : keys instanceof AuthKeys ? [keys] : [...keys])
    this.#adminKey = options.adminKey ? encoder.encode(options.adminKey) : null
    this.revocations = options.revocations
    const cacheSize = options.verifyCacheSize ?? 1024
    this.signatures = cacheSize > 0 ? new SignatureCache(cacheSize) : null
    this.#clockToleranceSec = options.clockToleranceSec ?? 30
    this.#now = options.now ?? Date.now
  }

  /** True when this node has an admin key configured. */
  get hasAdminKey(): boolean {
    return this.#adminKey !== null
  }

  /**
   * The principal behind a request, a bearer token, or a WebSocket `hello`. Raises 401 when no
   * usable credential is present.
   */
  async authenticate(source: Request | string | null | undefined): Promise<Principal> {
    const token = typeof source === "string" ? source : source ? tokenFromRequest(source) : null
    if (!token) throw BqlError.unauthenticated("no bearer token")
    return this.authenticateToken(token)
  }

  async authenticateToken(token: string): Promise<Principal> {
    if (this.#adminKey && constantTimeEqual(encoder.encode(token), this.#adminKey)) return ADMIN
    if (this.keys.size === 0) throw BqlError.unauthenticated("this node accepts no tokens")
    const claims = await verifyToken(this.keys, token, {
      now: this.#now(),
      clockToleranceSec: this.#clockToleranceSec,
      revocations: this.revocations,
      ...(this.signatures ? { cache: this.signatures } : {}),
    })
    return tokenPrincipal(claims)
  }

  /** Mints a token with the ring's active signing key. */
  mint(grant: TokenGrant = {}): Promise<string> {
    return mintToken(this.keys.signing, { now: this.#now(), ...grant })
  }
}

/** `Authorization: Bearer …` first, then `?token=…` for clients that cannot set headers. */
export function tokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (header) {
    const space = header.indexOf(" ")
    if (space > 0 && header.slice(0, space).toLowerCase() === "bearer") {
      const token = header.slice(space + 1).trim()
      if (token.length > 0) return token
    }
  }
  const query = new URL(request.url).searchParams.get("token")
  return query && query.length > 0 ? query : null
}

/** Compares two secrets without an early exit on the first differing byte. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const shared = a.length < b.length ? a.length : b.length
  for (let i = 0; i < shared; i++) diff |= (a[i] as number) ^ (b[i] as number)
  // Keep the work done independent of which side was shorter.
  for (let i = shared; i < b.length; i++) diff |= b[i] as number
  for (let i = shared; i < a.length; i++) diff |= a[i] as number
  return diff === 0
}

// ── Connection policy (design §4.7) ────────────────────────────────────────────────────────────

/** Actions that change the database, which a read-only token may not take. */
const WRITE_ACTIONS: ReadonlySet<number> = new Set([
  SQLITE_INSERT,
  SQLITE_UPDATE,
  SQLITE_DELETE,
  SQLITE_CREATE_INDEX,
  SQLITE_CREATE_TABLE,
  SQLITE_CREATE_TEMP_INDEX,
  SQLITE_CREATE_TEMP_TABLE,
  SQLITE_CREATE_TEMP_TRIGGER,
  SQLITE_CREATE_TEMP_VIEW,
  SQLITE_CREATE_TRIGGER,
  SQLITE_CREATE_VIEW,
  SQLITE_CREATE_VTABLE,
  SQLITE_DROP_INDEX,
  SQLITE_DROP_TABLE,
  SQLITE_DROP_TEMP_INDEX,
  SQLITE_DROP_TEMP_TABLE,
  SQLITE_DROP_TEMP_TRIGGER,
  SQLITE_DROP_TEMP_VIEW,
  SQLITE_DROP_TRIGGER,
  SQLITE_DROP_VIEW,
  SQLITE_DROP_VTABLE,
  SQLITE_ALTER_TABLE,
  SQLITE_REINDEX,
  SQLITE_ANALYZE,
])

/** Schema changes, which a table-scoped token may never make. */
const DDL_ACTIONS: ReadonlySet<number> = new Set([
  SQLITE_CREATE_INDEX,
  SQLITE_CREATE_TABLE,
  SQLITE_CREATE_TEMP_INDEX,
  SQLITE_CREATE_TEMP_TABLE,
  SQLITE_CREATE_TEMP_TRIGGER,
  SQLITE_CREATE_TEMP_VIEW,
  SQLITE_CREATE_TRIGGER,
  SQLITE_CREATE_VIEW,
  SQLITE_CREATE_VTABLE,
  SQLITE_DROP_INDEX,
  SQLITE_DROP_TABLE,
  SQLITE_DROP_TEMP_INDEX,
  SQLITE_DROP_TEMP_TABLE,
  SQLITE_DROP_TEMP_TRIGGER,
  SQLITE_DROP_TEMP_VIEW,
  SQLITE_DROP_TRIGGER,
  SQLITE_DROP_VIEW,
  SQLITE_DROP_VTABLE,
  SQLITE_ALTER_TABLE,
])

/** Pragmas whose argument names a table rather than setting a value: always a read. */
const PRAGMA_SUBJECT: ReadonlySet<string> = new Set([
  "table_info",
  "table_list",
  "index_list",
  "foreign_key_list",
])

/** Pragmas allowed only in their reading form, i.e. with no value after `=`. */
const PRAGMA_READ: ReadonlySet<string> = new Set([
  "user_version",
  "schema_version",
  "journal_mode",
  "page_count",
  "page_size",
  "freelist_count",
  "data_version",
  "compile_options",
])

export interface AuthorizerRules {
  scope: Scope
  /** Per-table ACL. When absent, every table in the database is in scope. */
  tables?: Readonly<Record<string, TableScope>>
  /**
   * Answer `SQLITE_IGNORE` to `SQLITE_DELETE`, which turns off SQLite's truncate optimisation so
   * `DELETE FROM t` reports every row to the change feed (design §4.6). Only needed in the
   * update-hook fallback mode; a registered preupdate hook does this by itself.
   */
  reportEveryDelete?: boolean
  /**
   * The virtual table a storage (shadow) table belongs to, lower-cased, or undefined. With a
   * per-table ACL, a shadow table is allowed exactly when its owner is, for the same action class:
   * FTS5, vec0 and R*Tree read and write their own storage through statements on this connection,
   * which this authorizer sees, so without it a token granted `docs_fts` could not search it.
   * Must not touch the connection — it runs inside the authorizer. `shadowLookup` builds it.
   */
  shadowOf?: (name: string) => string | undefined
  /**
   * Let `shadowOf` grant writes, not only reads. Only safe on a connection with
   * `SQLITE_DBCONFIG_DEFENSIVE` on, where SQLite itself refuses a write to a shadow table from
   * anything but the module — so the grant covers the index maintaining itself (a trigger's insert
   * into `docs_fts`) and never a token writing `docs_fts_data` by hand. `applyPolicy` sets both.
   */
  shadowWrites?: boolean
}

/** Lower-cases the ACL keys once, so lookups can be case-insensitive like SQLite identifiers. */
function normalizeTables(
  tables: Readonly<Record<string, TableScope>> | undefined,
): Map<string, TableScope> | null {
  if (!tables) return null
  const map = new Map<string, TableScope>()
  for (const [name, scope] of Object.entries(tables)) map.set(name.toLowerCase(), scope)
  return map
}

function pragmaVerdict(name: string | null, argument: string | null): number {
  const pragma = name?.toLowerCase() ?? ""
  if (PRAGMA_SUBJECT.has(pragma)) return SQLITE_OK
  if (PRAGMA_READ.has(pragma) && argument === null) return SQLITE_OK
  return SQLITE_DENY
}

/**
 * The authorizer for one principal on one database. Deny-by-default for everything that could
 * leave the database (`ATTACH`, `load_extension`, most pragmas); allow-by-default for the plain
 * reads and writes the scope already permits, since `query_only` is the second line of defence.
 */
export function buildAuthorizer(rules: AuthorizerRules): Authorizer {
  const readOnly = rules.scope === "ro"
  const tables = normalizeTables(rules.tables)
  const ignoreDeletes = rules.reportEveryDelete === true
  const shadowOf = rules.shadowOf
  /** The ACL entry that governs `name`: its own, or its owning virtual table's. */
  const aclOf = (name: string, write: boolean): TableScope | undefined => {
    const own = tables?.get(name)
    if (own !== undefined || !shadowOf || (write && rules.shadowWrites !== true)) return own
    const owner = shadowOf(name)
    return owner === undefined ? undefined : tables?.get(owner)
  }

  return (action, arg1, arg2) => {
    switch (action) {
      case SQLITE_ATTACH:
      case SQLITE_DETACH:
      case SQLITE_COPY:
        return SQLITE_DENY
      case SQLITE_PRAGMA:
        return pragmaVerdict(arg1, arg2)
      case SQLITE_FUNCTION:
        return arg2 !== null && arg2.toLowerCase() === "load_extension" ? SQLITE_DENY : SQLITE_OK
      default:
        break
    }

    if (readOnly && WRITE_ACTIONS.has(action)) return SQLITE_DENY

    if (tables) {
      if (DDL_ACTIONS.has(action)) return SQLITE_DENY
      const name = arg1?.toLowerCase() ?? ""
      if (action === SQLITE_READ) {
        // The schema and SQLite's own bookkeeping tables stay readable: the query planner and
        // AUTOINCREMENT need them, and they expose nothing the token cannot already see.
        if (name.startsWith("sqlite_")) return SQLITE_OK
        return aclOf(name, false) !== undefined ? SQLITE_OK : SQLITE_DENY
      }
      if (action === SQLITE_INSERT || action === SQLITE_UPDATE || action === SQLITE_DELETE) {
        if (name.startsWith("sqlite_")) return name === "sqlite_sequence" ? SQLITE_OK : SQLITE_DENY
        if (aclOf(name, true) !== "rw") return SQLITE_DENY
      }
    }

    if (ignoreDeletes && action === SQLITE_DELETE) return SQLITE_IGNORE
    return SQLITE_OK
  }
}

export interface PolicyOptions {
  reportEveryDelete?: boolean
  /**
   * Force `PRAGMA query_only`. Readers are borrowed with it on whatever the token's scope is, so
   * a bug in statement classification still cannot write through the pool; the writer runs with
   * it off. Defaults to "on for a read-only token".
   */
  queryOnly?: boolean
}

export interface PolicyHandle {
  /** Scope the connection was set up for. */
  readonly scope: Scope
  /** Returns the connection to an unrestricted state for the next borrower. */
  release(): void
}

/**
 * The one authorizer slot on a connection, as `src/realtime/authorizer.ts` owns it. The policy is
 * the hub's *base* layer: change capture and read-set recording register their own layers on the
 * same connection, and the hub is what keeps them from overwriting each other.
 */
export interface PolicySlot {
  setBase(authorizer: Authorizer | null): void
  bypass<T>(fn: () => T): T
}

/**
 * `query_only` as this module last set it, per connection. The pragma is a prepare-and-step, and
 * the overwhelming case is a pooled reader borrowed again for the same kind of principal, so
 * remembering the flag is what keeps re-scoping down to one FFI call.
 */
const queryOnlyState = new WeakMap<Database, boolean>()

/** The policy identity a connection is currently scoped to, or absent when it is unscoped. */
const appliedPolicy = new WeakMap<Database, string>()

/**
 * Sets `query_only` once and remembers it, so later `applyPolicy` calls that want the same value
 * are free. The server pins its readers on and its writer off when a connection is opened, which
 * is what keeps the request path down to the authorizer alone.
 */
export function pinQueryOnly(db: Database, on: boolean): void {
  db.run(on ? "pragma query_only = 1" : "pragma query_only = 0")
  queryOnlyState.set(db, on)
}

/**
 * Everything about a policy that changes what SQLite will allow. Two requests with the same
 * identity on the same connection need no second `sqlite3_set_authorizer`, and — this is the
 * point — no expiry of the statements already prepared under it.
 */
function policyKey(principal: Principal, dbName: string, options: PolicyOptions): string {
  if (principal.kind === "admin") return "admin"
  const scope = principal.scopeFor(dbName)
  const tables = principal.tables
    ? Object.entries(principal.tables)
        .map(([name, access]) => `${name.toLowerCase()}:${access}`)
        .sort()
        .join(",")
    : "*"
  return `${scope}|${dbName}|${tables}|${options.reportEveryDelete ? 1 : 0}|${options.queryOnly ?? ""}`
}

/**
 * Sets a pooled connection up for one principal: `query_only` for a reader or a read-only token,
 * plus the authorizer above as the hub's base layer. The admin principal runs with neither, as
 * the lifecycle routes need `ATTACH` and arbitrary pragmas.
 *
 * The pragma is set through `hub.bypass`, because `query_only` is not on the pragma allow-list —
 * a token must not be able to turn its own read-only flag off, and the policy that says so must
 * not stop the server from setting it either.
 */
export function applyPolicy(
  db: Database,
  hub: PolicySlot,
  principal: Principal,
  dbName: string,
  options: PolicyOptions = {},
): PolicyHandle {
  const before = queryOnlyState.get(db) ?? false
  const restore = (): void => {
    appliedPolicy.delete(db)
    hub.setBase(null)
    if (queryOnlyState.get(db) !== before) hub.bypass(() => setQueryOnly(db, before))
    defend(db, false)
  }
  const key = policyKey(principal, dbName, options)
  const tableAcl = principal.kind !== "admin" && principal.tables !== undefined
  // Refreshed even when the policy itself is unchanged: the closure below reads the map by
  // connection, so a virtual table created since the last request is seen without re-scoping.
  const shadowOf = tableAcl ? shadowLookup(db, hub) : undefined
  // A table ACL runs defensive, so a grant on `docs_fts` reaches its storage only through the
  // module. Everyone else gets the connection's own setting back.
  const hardened = defend(db, tableAcl)
  if (appliedPolicy.get(db) === key) {
    return { scope: principal.kind === "admin" ? "rw" : (principal.scopeFor(dbName) as Scope), release: restore }
  }
  if (principal.kind === "admin") {
    hub.bypass(() => setQueryOnly(db, options.queryOnly === true))
    hub.setBase(null)
    appliedPolicy.set(db, key)
    return { scope: "rw", release: restore }
  }
  const scope = principal.scopeFor(dbName)
  if (scope === null) throw BqlError.notAuthorized(`token has no access to database ${dbName}`)
  hub.bypass(() => setQueryOnly(db, options.queryOnly ?? scope === "ro"))
  hub.setBase(
    buildAuthorizer({
      scope,
      ...(principal.tables ? { tables: principal.tables } : {}),
      ...(shadowOf ? { shadowOf, shadowWrites: hardened } : {}),
      ...(options.reportEveryDelete ? { reportEveryDelete: true } : {}),
    }),
  )
  appliedPolicy.set(db, key)
  return { scope, release: restore }
}

/** `SQLITE_DBCONFIG_DEFENSIVE` as the connection had it before any policy (null: no shim). */
const defensiveBase = new WeakMap<Database, number | null>()
/** …and as this module last set it, so an unchanged request costs no FFI call. */
const defensiveNow = new WeakMap<Database, number>()

/**
 * Turns `SQLITE_DBCONFIG_DEFENSIVE` on for a table-ACL request, or back to the connection's own
 * setting (`[sqlite] defensive`) for anyone else. Returns whether it is now on. On a system
 * libsqlite3 there is no shim to reach it with, and the answer is false: the ACL then grants
 * shadow tables for reads only, so writing through an index needs a database-wide token there.
 */
function defend(db: Database, want: boolean): boolean {
  let base = defensiveBase.get(db)
  if (base === undefined) {
    base = db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", -1)
    defensiveBase.set(db, base)
    if (base !== null) defensiveNow.set(db, base)
  }
  if (base === null) return false
  const target = want ? 1 : base
  if (defensiveNow.get(db) !== target) {
    db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", target)
    defensiveNow.set(db, target)
  }
  return target === 1
}

/** Shadow table → owning virtual table (both lower-cased), per connection, as of `cookie`. */
const shadowMaps = new WeakMap<Database, { cookie: number; map: Map<string, string> }>()

/**
 * Brings this connection's shadow map up to date with its schema and returns the lookup the
 * authorizer uses. The authorizer runs inside `sqlite3_prepare` and may not run SQL itself, so
 * the map is built here, before the policy goes on: one `pragma schema_version` per request for
 * a token with a table ACL (nobody else pays anything here), and a rebuild only when the cookie moved.
 *
 * Only a real virtual table in `sqlite_schema` can own a shadow table, and only one its module
 * created for that table's options (`src/sqlite/shadow.ts`): `todos_data` beside an ordinary
 * `todos`, or `docs_fts_content` beside an external-content `docs_fts`, is nobody's storage and
 * stays governed by its own ACL entry.
 */
export function shadowLookup(db: Database, hub: PolicySlot): (name: string) => string | undefined {
  hub.bypass(() => {
    const cookie = Number(db.prepare("pragma schema_version").get()?.schema_version ?? 0)
    const cached = shadowMaps.get(db)
    if (cached && cached.cookie === cookie) return
    const map = new Map<string, string>()
    const vtabs = virtualTables(db.prepare(VIRTUAL_TABLES_SQL).all() as { name: unknown; sql: unknown }[])
    if (vtabs.size > 0) {
      for (const row of db.prepare("select name from sqlite_schema where type = 'table'").all()) {
        const name = row.name
        if (typeof name !== "string") continue
        const owner = shadowOwner(name, vtabs)
        if (owner !== null) map.set(name.toLowerCase(), owner.toLowerCase())
      }
    }
    shadowMaps.set(db, { cookie, map })
  })
  return (name) => shadowMaps.get(db)?.map.get(name)
}

function setQueryOnly(db: Database, on: boolean): void {
  if (queryOnlyState.get(db) === on) return
  db.run(on ? "pragma query_only = 1" : "pragma query_only = 0")
  queryOnlyState.set(db, on)
}
