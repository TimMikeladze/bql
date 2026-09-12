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
import { BunQLError } from "./errors.ts"
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
    throw BunQLError.unauthenticated("token is not valid JWT")
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
      throw BunQLError.badRequest("private key does not carry its public half")
    }
    const raw = fromBase64(jwk.x)
    const publicKey = await importOrFail("raw", raw, ["verify"])
    return new AuthKeys(await deriveKid(raw), publicKey, privateKey, raw)
  }

  /** Loads a verify-only key from its 32 raw public bytes, or their base64 text. */
  static async fromRawPublic(raw: Uint8Array | string): Promise<AuthKeys> {
    const bytes = typeof raw === "string" ? fromBase64(raw) : raw
    if (bytes.byteLength !== 32) {
      throw BunQLError.badRequest(`an Ed25519 public key is 32 bytes, got ${bytes.byteLength}`)
    }
    const publicKey = await importOrFail("raw", bytes, ["verify"])
    return new AuthKeys(await deriveKid(bytes), publicKey, null, bytes)
  }

  /** Loads either half from a JWK (`kty: "OKP"`, `crv: "Ed25519"`). */
  static async fromJwk(jwk: Ed25519Jwk): Promise<AuthKeys> {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      throw BunQLError.badRequest("expected an OKP/Ed25519 JWK")
    }
    if (typeof jwk.x !== "string") throw BunQLError.badRequest("JWK has no public component")
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
    if (!this.privateKey) throw BunQLError.badRequest("this key has no private half")
    return new Uint8Array(await crypto.subtle.exportKey("pkcs8", this.privateKey))
  }

  async exportJwk(which: "public" | "private" = "public"): Promise<Ed25519Jwk> {
    if (which === "private") {
      if (!this.privateKey) throw BunQLError.badRequest("this key has no private half")
      return (await crypto.subtle.exportKey("jwk", this.privateKey)) as Ed25519Jwk
    }
    return (await crypto.subtle.exportKey("jwk", this.publicKey)) as Ed25519Jwk
  }

  async sign(data: Uint8Array): Promise<Bytes> {
    if (!this.privateKey) throw BunQLError.badRequest("this key has no private half")
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
    throw BunQLError.badRequest(`not a usable Ed25519 ${format} key`)
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

  constructor(keys: readonly AuthKeys[] = []) {
    for (const key of keys) this.add(key)
  }

  /** Adds a key; the first signing-capable key added becomes the active one. */
  add(key: AuthKeys): this {
    this.#keys.set(key.kid, key)
    if (key.canSign && this.#signingKid === null) this.#signingKid = key.kid
    return this
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
    if (!key) throw new BunQLError("INTERNAL", "no signing key is configured", 500)
    return key
  }

  setSigning(kid: string): this {
    const key = this.#keys.get(kid)
    if (!key?.canSign) throw BunQLError.badRequest(`no signing key with kid ${kid}`)
    this.#signingKid = kid
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
  const parts = token.split(".")
  if (parts.length !== 3) throw BunQLError.unauthenticated("token is not a JWT")
  const [headerText, claimsText, signatureText] = parts as [string, string, string]

  const header = decodeSegment(headerText) as JwtHeader
  if (!header || typeof header !== "object") throw BunQLError.unauthenticated("malformed JWT header")
  if (header.alg !== "EdDSA") {
    throw BunQLError.unauthenticated(`unsupported JWT algorithm ${String(header.alg)}`)
  }
  if (header.typ !== undefined && header.typ.toUpperCase() !== "JWT") {
    throw BunQLError.unauthenticated(`unsupported JWT type ${String(header.typ)}`)
  }

  const key = header.kid ? ring.get(header.kid) : ring.soleKey()
  if (!key) throw BunQLError.unauthenticated("token was signed by an unknown key")

  let signature: Uint8Array
  try {
    signature = fromBase64(signatureText)
  } catch {
    throw BunQLError.unauthenticated("malformed JWT signature")
  }
  const ok = await key.verify(encoder.encode(`${headerText}.${claimsText}`), signature)
  if (!ok) throw BunQLError.unauthenticated("token signature does not check out")

  const claims = decodeSegment(claimsText) as TokenClaims
  if (!claims || typeof claims !== "object") throw BunQLError.unauthenticated("malformed JWT claims")
  if (typeof claims.jti !== "string" || claims.jti.length === 0) {
    throw BunQLError.unauthenticated("token has no jti")
  }
  if (claims.kid !== undefined && header.kid !== undefined && claims.kid !== header.kid) {
    throw BunQLError.unauthenticated("token header and claims disagree about the key")
  }

  const nowSec = Math.floor((options.now ?? Date.now()) / 1000)
  const slack = options.clockToleranceSec ?? 30
  if (typeof claims.exp === "number" && claims.exp + slack < nowSec) {
    throw BunQLError.unauthenticated("token has expired")
  }
  if (typeof claims.nbf === "number" && claims.nbf - slack > nowSec) {
    throw BunQLError.unauthenticated("token is not valid yet")
  }
  if (options.revocations && (await options.revocations.isRevoked(claims.jti))) {
    throw BunQLError.unauthenticated("token has been revoked")
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

/** Raises 403 unless the principal has at least `need` on `db`; returns its actual scope. */
export function requireScope(principal: Principal, db: string, need: Scope): Scope {
  if (principal.kind === "admin") return "rw"
  const scope = principal.scopeFor(db)
  if (scope === null) throw BunQLError.notAuthorized(`token has no access to database ${db}`)
  if (need === "rw" && scope !== "rw") {
    throw BunQLError.notAuthorized(`token is read-only on database ${db}`)
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
  /** Clock override, milliseconds since the epoch. */
  now?: () => number
}

export class Authenticator {
  readonly keys: KeyRing
  readonly revocations: RevocationList | undefined
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
    if (!token) throw BunQLError.unauthenticated("no bearer token")
    return this.authenticateToken(token)
  }

  async authenticateToken(token: string): Promise<Principal> {
    if (this.#adminKey && constantTimeEqual(encoder.encode(token), this.#adminKey)) return ADMIN
    if (this.keys.size === 0) throw BunQLError.unauthenticated("this node accepts no tokens")
    const claims = await verifyToken(this.keys, token, {
      now: this.#now(),
      clockToleranceSec: this.#clockToleranceSec,
      revocations: this.revocations,
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
        return tables.has(name) ? SQLITE_OK : SQLITE_DENY
      }
      if (action === SQLITE_INSERT || action === SQLITE_UPDATE || action === SQLITE_DELETE) {
        if (name.startsWith("sqlite_")) return name === "sqlite_sequence" ? SQLITE_OK : SQLITE_DENY
        if (tables.get(name) !== "rw") return SQLITE_DENY
      }
    }

    if (ignoreDeletes && action === SQLITE_DELETE) return SQLITE_IGNORE
    return SQLITE_OK
  }
}

export interface PolicyOptions {
  reportEveryDelete?: boolean
}

export interface PolicyHandle {
  /** Scope the connection was set up for. */
  readonly scope: Scope
  /** Returns the connection to an unrestricted state for the next borrower. */
  release(): void
}

/**
 * Sets a pooled connection up for one principal: `query_only` for a read-only token, plus the
 * authorizer above. The admin principal runs with neither, as the lifecycle routes need `ATTACH`
 * and arbitrary pragmas.
 *
 * The authorizer is removed before the pragma is touched, because `query_only` is not on the
 * pragma allow-list — a token must not be able to turn its own read-only flag off.
 */
export function applyPolicy(
  db: Database,
  principal: Principal,
  dbName: string,
  options: PolicyOptions = {},
): PolicyHandle {
  db.authorizer(null)
  if (principal.kind === "admin") {
    setQueryOnly(db, false)
    return { scope: "rw", release: () => db.authorizer(null) }
  }
  const scope = principal.scopeFor(dbName)
  if (scope === null) throw BunQLError.notAuthorized(`token has no access to database ${dbName}`)
  setQueryOnly(db, scope === "ro")
  db.authorizer(
    buildAuthorizer({
      scope,
      ...(principal.tables ? { tables: principal.tables } : {}),
      ...(options.reportEveryDelete ? { reportEveryDelete: true } : {}),
    }),
  )
  return {
    scope,
    release(): void {
      db.authorizer(null)
      setQueryOnly(db, false)
    },
  }
}

function setQueryOnly(db: Database, on: boolean): void {
  db.run(on ? "pragma query_only = 1" : "pragma query_only = 0")
}
