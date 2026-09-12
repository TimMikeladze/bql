// Invariant: every knob has exactly three sources, in this order — a default in this file, a key
// in `bunql.toml`, an environment override named `BUNQL_*` — and the resolved config is frozen
// before anything reads it. Nothing downstream consults `process.env` or re-parses the file.
//
// Secrets are the one place with state: a node with no configured admin key or signing key
// generates them once, persists them to `<dataDir>/keys.json` with owner-only permissions, and
// prints the admin key exactly once, on the run that generated it. A JWT private key is never
// printed at all.

import fs from "node:fs"
import path from "node:path"
import { AuthKeys, type Ed25519Jwk, KeyRing } from "./auth.ts"
import { BunQLError } from "./errors.ts"

/** Durability a write is answered at when the request does not say (design §5.4). */
export type DefaultAck = "local" | "fsync"

export interface ServerSection {
  port: number
  host: string
  /** Name this node reports in `BunQL-Node`. Defaults to the hostname. */
  node: string
  /** Also accept `{db}.host` addressing, libsql-style (design §6). */
  tenantFromHost: boolean
  /** Answer CORS preflights and echo the origin, so browser tokens work from anywhere. */
  cors: boolean
}

export interface DataSection {
  dir: string
  maxOpen: number
  readers: number
  pageSize: number
  /** Default storage quota for new databases, in bytes. 0 is unlimited. */
  quotaBytes: number
}

export interface DurabilitySection {
  defaultAck: DefaultAck
  checkpointWalBytes: number
  retention: string
}

export interface RealtimeSection {
  ringBytes: number
  ringMaxAgeMs: number
  maxLiveQueries: number
  maxRowsPerLive: number
  /**
   * How long a database's realtime engine is kept after its last subscriber leaves, so a client
   * that reconnects with `Last-Event-ID` can still be served from the ring. 0 closes it at once,
   * which makes every reconnect a `reset`.
   */
  idleRetainMs: number
}

export interface LimitsSection {
  queryTimeoutMs: number
  writeTimeoutMs: number
  txIdleTimeoutMs: number
  maxRows: number
  /** Interactive transactions open at once, per database. The tenant has one writer, so: 1. */
  maxOpenTx: number
  /** Largest request body accepted, in bytes. `import` gets its own, larger, cap. */
  maxBodyBytes: number
  /** Largest SQLite file `POST /v1/db/{db}/import` accepts, in bytes. */
  maxImportBytes: number
}

export interface AuthSection {
  /** Bearer token for the lifecycle routes. Generated and persisted when absent. */
  adminKey: string | null
  /** Ed25519 signing key as base64 PKCS#8. Generated and persisted when absent. */
  jwtKey: string | null
  /** Extra verify-only public keys, base64 raw (32 bytes), for rotation. */
  jwtPublicKeys: string[]
  /** Where generated secrets live. Defaults to `<data.dir>/keys.json`. */
  keysFile: string | null
  clockToleranceSec: number
  /** Default lifetime of a minted token when the request does not say, in ms. */
  defaultTokenTtlMs: number
}

export interface ServerConfig {
  server: ServerSection
  data: DataSection
  durability: DurabilitySection
  realtime: RealtimeSection
  limits: LimitsSection
  auth: AuthSection
}

/** The same shape with every field optional, which is what a TOML file or a caller supplies. */
export type ServerConfigInput = {
  [K in keyof ServerConfig]?: Partial<ServerConfig[K]>
}

export const DEFAULT_CONFIG: ServerConfig = {
  server: {
    port: 4321,
    host: "0.0.0.0",
    node: "bunql",
    tenantFromHost: false,
    cors: true,
  },
  data: { dir: "./data", maxOpen: 1024, readers: 2, pageSize: 4096, quotaBytes: 0 },
  durability: { defaultAck: "local", checkpointWalBytes: 4_000_000, retention: "7d" },
  realtime: {
    ringBytes: 10_000_000,
    ringMaxAgeMs: 60_000,
    maxLiveQueries: 1000,
    maxRowsPerLive: 1000,
    idleRetainMs: 15_000,
  },
  limits: {
    queryTimeoutMs: 10_000,
    writeTimeoutMs: 30_000,
    txIdleTimeoutMs: 5_000,
    maxRows: 10_000,
    maxOpenTx: 1,
    maxBodyBytes: 8 * 1024 * 1024,
    maxImportBytes: 1024 * 1024 * 1024,
  },
  auth: {
    adminKey: null,
    jwtKey: null,
    jwtPublicKeys: [],
    keysFile: null,
    clockToleranceSec: 30,
    defaultTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  },
}

/** `BUNQL_*` name → the config path it sets. Design §9.4: "every key has an env override". */
const ENV_KEYS: Readonly<Record<string, string>> = {
  BUNQL_PORT: "server.port",
  BUNQL_HOST: "server.host",
  BUNQL_NODE: "server.node",
  BUNQL_TENANT_FROM_HOST: "server.tenantFromHost",
  BUNQL_CORS: "server.cors",
  BUNQL_DIR: "data.dir",
  BUNQL_MAX_OPEN: "data.maxOpen",
  BUNQL_READERS: "data.readers",
  BUNQL_PAGE_SIZE: "data.pageSize",
  BUNQL_QUOTA_BYTES: "data.quotaBytes",
  BUNQL_DEFAULT_ACK: "durability.defaultAck",
  BUNQL_CHECKPOINT_WAL_BYTES: "durability.checkpointWalBytes",
  BUNQL_RETENTION: "durability.retention",
  BUNQL_RING_BYTES: "realtime.ringBytes",
  BUNQL_RING_MAX_AGE_MS: "realtime.ringMaxAgeMs",
  BUNQL_MAX_LIVE_QUERIES: "realtime.maxLiveQueries",
  BUNQL_MAX_ROWS_PER_LIVE: "realtime.maxRowsPerLive",
  BUNQL_IDLE_RETAIN_MS: "realtime.idleRetainMs",
  BUNQL_QUERY_TIMEOUT_MS: "limits.queryTimeoutMs",
  BUNQL_WRITE_TIMEOUT_MS: "limits.writeTimeoutMs",
  BUNQL_TX_IDLE_TIMEOUT_MS: "limits.txIdleTimeoutMs",
  BUNQL_MAX_ROWS: "limits.maxRows",
  BUNQL_MAX_OPEN_TX: "limits.maxOpenTx",
  BUNQL_MAX_BODY_BYTES: "limits.maxBodyBytes",
  BUNQL_MAX_IMPORT_BYTES: "limits.maxImportBytes",
  BUNQL_ADMIN_KEY: "auth.adminKey",
  BUNQL_JWT_ED25519: "auth.jwtKey",
  BUNQL_KEYS_FILE: "auth.keysFile",
  BUNQL_CLOCK_TOLERANCE_SEC: "auth.clockToleranceSec",
  BUNQL_TOKEN_TTL_MS: "auth.defaultTokenTtlMs",
}

type Env = Record<string, string | undefined>

/** Expands `${NAME}` against the environment, which is how design §9.4 writes secrets in TOML. */
function expand(value: string, env: Env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "")
}

function coerce(target: unknown, raw: string): unknown {
  if (typeof target === "number") {
    const n = Number(raw.replaceAll("_", ""))
    if (!Number.isFinite(n)) throw BunQLError.badRequest(`${JSON.stringify(raw)} is not a number`)
    return n
  }
  if (typeof target === "boolean") return raw === "1" || raw.toLowerCase() === "true"
  return raw
}

function setPath(config: ServerConfig, dotted: string, raw: string): void {
  const [section, key] = dotted.split(".") as [keyof ServerConfig, string]
  const target = config[section] as unknown as Record<string, unknown>
  target[key] = coerce(target[key], raw)
}

function mergeSection<T extends object>(base: T, patch: Partial<T> | undefined, env: Env): T {
  if (!patch) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    // Every string from a file goes through `${…}` expansion, whatever the default's type is:
    // `adminKey` defaults to null and is exactly the key design §9.4 writes as `${BUNQL_ADMIN_KEY}`.
    ;(out as Record<string, unknown>)[key] = typeof value === "string" ? expand(value, env) : value
  }
  return out
}

export interface LoadConfigOptions {
  /** TOML file to read. Missing files are not an error unless `required`. */
  file?: string | null
  required?: boolean
  /** Applied after the file and before the environment. */
  overrides?: ServerConfigInput
  env?: Env
}

/**
 * Resolves the configuration: defaults, then the TOML file, then `overrides`, then `BUNQL_*`.
 * An empty string in the environment or after `${…}` expansion counts as "not set", so an unset
 * `${BUNQL_ADMIN_KEY}` in the file leaves the key to be generated rather than making it "".
 */
export function loadConfig(options: LoadConfigOptions = {}): ServerConfig {
  const env = options.env ?? (process.env as Env)
  let fromFile: ServerConfigInput = {}
  const file = options.file
  if (file) {
    if (fs.existsSync(file)) {
      fromFile = Bun.TOML.parse(fs.readFileSync(file, "utf8")) as ServerConfigInput
    } else if (options.required) {
      throw BunQLError.badRequest(`no config file at ${file}`)
    }
  }

  let config: ServerConfig = {
    server: { ...DEFAULT_CONFIG.server },
    data: { ...DEFAULT_CONFIG.data },
    durability: { ...DEFAULT_CONFIG.durability },
    realtime: { ...DEFAULT_CONFIG.realtime },
    limits: { ...DEFAULT_CONFIG.limits },
    auth: { ...DEFAULT_CONFIG.auth, jwtPublicKeys: [...DEFAULT_CONFIG.auth.jwtPublicKeys] },
  }

  for (const patch of [fromFile, options.overrides]) {
    if (!patch) continue
    config = {
      server: mergeSection(config.server, patch.server, env),
      data: mergeSection(config.data, patch.data, env),
      durability: mergeSection(config.durability, patch.durability, env),
      realtime: mergeSection(config.realtime, patch.realtime, env),
      limits: mergeSection(config.limits, patch.limits, env),
      auth: mergeSection(config.auth, patch.auth, env),
    }
  }

  for (const [name, dotted] of Object.entries(ENV_KEYS)) {
    const raw = env[name]
    if (raw === undefined || raw === "") continue
    setPath(config, dotted, raw)
  }

  // An expansion that found nothing leaves "", which must not be mistaken for a configured secret.
  if (config.auth.adminKey === "") config.auth.adminKey = null
  if (config.auth.jwtKey === "") config.auth.jwtKey = null
  if (config.server.node === DEFAULT_CONFIG.server.node) {
    config.server.node = env.BUNQL_NODE || defaultNodeId()
  }
  config.data.dir = path.resolve(config.data.dir)
  if (config.auth.keysFile === null) config.auth.keysFile = path.join(config.data.dir, "keys.json")
  return config
}

/**
 * A node id that is stable for a machine without naming it. `BunQL-Node` travels on every
 * response and into whatever a client logs, so the default is a hash of the hostname rather than
 * the hostname itself; an operator who wants a readable name sets `[server] node` or `BUNQL_NODE`.
 */
function defaultNodeId(): string {
  try {
    const host = Bun.spawnSync(["hostname"]).stdout.toString().trim()
    if (!host) return "bunql"
    return `bunql-${Bun.hash.xxHash3(host).toString(16).padStart(16, "0").slice(0, 8)}`
  } catch {
    return "bunql"
  }
}

// ── Key material ───────────────────────────────────────────────────────────────────────────────

interface KeyFile {
  version: 1
  adminKey?: string
  /** The signing key, private half included. */
  signing?: Ed25519Jwk
  /** Public halves of retired keys, still trusted for verification. */
  verify?: Ed25519Jwk[]
}

export interface ResolvedAuth {
  keys: KeyRing
  adminKey: string | null
  /** True when this run had to generate the admin key, which is the only time it is printed. */
  adminKeyGenerated: boolean
  jwtKeyGenerated: boolean
  /** Where generated material was written, or null when nothing was written. */
  keysFile: string | null
}

function readKeyFile(file: string): KeyFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as KeyFile
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function writeKeyFile(file: string, contents: KeyFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // A filesystem without POSIX modes is not a reason to refuse to start.
  }
}

/** 32 bytes of randomness as base64url: what an admin key is when nobody configured one. */
export function generateAdminKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

/**
 * Builds the key ring for a node: the configured signing key if there is one, otherwise the one
 * in `keys.json`, otherwise a freshly generated pair that is written there. Extra public keys
 * from the config join the ring as verify-only, which is how a rotation keeps old tokens working.
 */
export async function resolveAuth(config: ServerConfig): Promise<ResolvedAuth> {
  const file = config.auth.keysFile
  const stored = file ? readKeyFile(file) : null
  let adminKey = config.auth.adminKey
  let adminKeyGenerated = false
  let jwtKeyGenerated = false
  let signing: AuthKeys
  let storedSigning: Ed25519Jwk | undefined

  if (config.auth.jwtKey) {
    signing = await AuthKeys.fromPkcs8(config.auth.jwtKey)
  } else if (stored?.signing) {
    signing = await AuthKeys.fromJwk(stored.signing)
  } else {
    signing = await AuthKeys.generate()
    jwtKeyGenerated = true
    storedSigning = await signing.exportJwk("private")
  }

  if (adminKey === null) {
    if (stored?.adminKey) {
      adminKey = stored.adminKey
    } else {
      adminKey = generateAdminKey()
      adminKeyGenerated = true
    }
  }

  const ring = new KeyRing([signing])
  for (const jwk of stored?.verify ?? []) {
    try {
      ring.add(await AuthKeys.fromJwk(jwk))
    } catch {
      // A key the ring cannot load is one nobody can present a token for; it is not fatal.
    }
  }
  for (const raw of config.auth.jwtPublicKeys) {
    if (!raw) continue
    ring.add(await AuthKeys.fromRawPublic(raw))
  }
  ring.setSigning(signing.kid)

  if (file && (adminKeyGenerated || jwtKeyGenerated)) {
    const next: KeyFile = { version: 1 }
    next.adminKey = adminKey
    next.signing = storedSigning ?? stored?.signing ?? (await signing.exportJwk("private"))
    if (stored?.verify?.length) next.verify = stored.verify
    writeKeyFile(file, next)
  }

  return {
    keys: ring,
    adminKey,
    adminKeyGenerated,
    jwtKeyGenerated,
    keysFile: adminKeyGenerated || jwtKeyGenerated ? file : null,
  }
}
