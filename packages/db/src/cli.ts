#!/usr/bin/env bun
// The command line of design §9.3. `serve` opens the data directory in this process; every other
// command is an HTTP client of a server that already has it open, because a second process writing
// the catalog would be a second writer for it.
//
// Invariant: no dependencies and no framework. The flag parser below is twenty lines and the
// output is either a line a human reads or, with `--json`, the server's own body.
//
// Second invariant: every remote command goes through the SDK — `client.admin.*` for the control
// plane of design §6.5, `client.db()` for `exec` and the socket for `shell`. The CLI carried its
// own fetch wrapper and its own copies of the response types until `docs/m9-client-admin.md`;
// there is now one implementation of these routes, and it is the one the tests exercise.

import { CONTEXT_HELP, contextOptions, runContextCommand } from "./cli/context.ts"
import { DEPLOY_HELP, runDeployCommand } from "./deploy/cli.ts"
import { resolveContext } from "./context/index.ts"
import { cliFetch, cliSocketFactory, endpointFetch } from "./cli/transport.ts"
import { createClient, type Client } from "./client/index.ts"
import { BqlClientError } from "./client/errors.ts"
import { decodeRows, type JsRow } from "./client/values.ts"
import { diffSchema, formatSchemaDiff } from "./client/diff.ts"
import type { CheckpointMode, QueryResult, Revision, TableScope } from "./client/protocol.ts"
import { SocketClient } from "./client/socket.ts"
import { startServer } from "./server/app.ts"
import { initializeObjectServer, serveObjectProcess } from "./cloud/startup.ts"
import { loadConfig, type ServerConfigInput } from "./server/config.ts"
import { walChecksumIsNative } from "./wal/native.ts"
import { VERSION } from "./server/surfaces.ts"

/** Set by `serve`, which is the one command that is still doing its job when `main` returns. */
let serving = false

const USAGE =
  CONTEXT_HELP +
  "\n" + DEPLOY_HELP + "\n" +
  `
bql — SQLite as a multi-tenant database server (design §9.3)

  bql serve [--dir ./data] [--port 4321] [--host 0.0.0.0] [--config bql.toml] [--admin-key K]
              [--workers N] [--storage-mode disk|object] [--deployment-id ID]
              [--replica-of wss://primary/v1/replication] [--cluster-secret S] [--follow a,b]
              [--cluster-peers a=ws://a:4321,b=ws://b:4321] [--advertise ws://me:4321] [--zone z]
              [--s3 s3://bucket/prefix] [--s3-endpoint URL] [--s3-region R]
  bql cloud init --deployment-id ID [--config bql.toml] [--s3 s3://bucket]
  bql db create <name> [--from <db>[@<txid|time>]] [--page-size N] [--quota-bytes N]
  bql db list
  bql db stat <name>
  bql db delete <name>
  bql db fork <name> --from <db>[@<txid|time>]
  bql db branch <name> --from <db>[@<txid|time>]   a fork that is meant to be thrown away
  bql db branches [<db>]      <db>'s branches, or every database that has a parent
  bql db diff <a> <b>         schema (tables, columns, indexes, triggers, views) and row counts
  bql db reset <branch>       back to its parent's head, same name
  bql snapshot <db>
  bql restore <db> --at <txid|time> [--into <name>]
  bql restore <db> --from s3://bucket/prefix --at <txid|time> [--into <name>]
  bql backup status <db>
  bql backup verify <db> [--at <txid|time>] [--from s3://bucket/prefix]
  bql backup generations <db>
  bql checkpoint <db> [--mode PASSIVE|FULL|RESTART|TRUNCATE]
  bql promote <db> [--force]
  bql cluster [--watch]
  bql token --db <name> [--scope ro|rw] [--ttl 30d] [--tables 'todos:r,users:rw']
  bql exec <db> --sql "select 1"
  bql shell <db>
  bql bus <command>   the message bus — \`bql bus help\` lists its commands

Remote commands talk to a running server:
  --url   base URL          (default $BQL_URL, else http://127.0.0.1:4321)
  --token bearer token      (default $BQL_TOKEN, else $BQL_ADMIN_KEY)
  --json  print the server's JSON instead of a summary line
`

// ── flags ──────────────────────────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  /** Positional arguments, in order. */
  positional: string[]
  flags: Record<string, string | boolean>
}

/** `--name value`, `--name=value`, `--flag`, and everything else positional. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf("=")
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    if (
      [
        "help",
        "version",
        "json",
        "recursive",
        "default",
        "prompt-token",
        "prompt-vercel-bypass",
        "prompt-bus-token",
        "prompt-bus-vercel-bypass",
        "clear-token",
        "clear-vercel-bypass",
        "clear-bus-token",
        "clear-bus-vercel-bypass",
        "clear-bus",
      ].includes(body)
    ) {
      flags[body] = true
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next
      i += 1
    } else {
      flags[body] = true
    }
  }
  return { positional, flags }
}

function str(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === "string" ? value : undefined
}

function num(args: ParsedArgs, name: string): number | undefined {
  const value = str(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value.replaceAll("_", ""))
  if (!Number.isFinite(parsed)) throw new CliError(`--${name} must be a number, got ${value}`)
  return parsed
}

class CliError extends Error {}

/** `30d`, `12h`, `90m`, `45s`, or a bare number of seconds — as milliseconds. */
export function parseTtlMs(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i.exec(text.trim())
  if (!match) throw new CliError(`--ttl must look like 30d, 12h, 90m or 3600, got ${text}`)
  const value = Number(match[1])
  switch ((match[2] ?? "s").toLowerCase()) {
    case "ms":
      return value
    case "m":
      return value * 60_000
    case "h":
      return value * 3_600_000
    case "d":
      return value * 86_400_000
    case "w":
      return value * 604_800_000
    default:
      return value * 1000
  }
}

/** `todos:r,users:rw` — the table ACL of design §6, in the two scopes a token can carry. */
export function parseTables(text: string): Record<string, TableScope> {
  const out: Record<string, TableScope> = {}
  for (const entry of text.split(",")) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const colon = trimmed.lastIndexOf(":")
    if (colon <= 0) throw new CliError(`--tables wants name:scope entries, got ${trimmed}`)
    const table = trimmed.slice(0, colon)
    const scope = trimmed.slice(colon + 1)
    if (scope !== "r" && scope !== "rw") {
      throw new CliError(`table scope must be r or rw, got ${scope}`)
    }
    out[table] = scope
  }
  if (Object.keys(out).length === 0) throw new CliError("--tables listed no tables")
  return out
}

/** `acme@4812` or `acme@2026-09-11T10:00:00Z`; the server resolves a time against its log. */
export function parseFrom(text: string): { db: string; at?: number | string } {
  const at = text.indexOf("@")
  if (at < 0) return { db: text }
  const db = text.slice(0, at)
  const rev = text.slice(at + 1)
  if (db.length === 0 || rev.length === 0) {
    throw new CliError(`--from wants <db> or <db>@<txid|time>, got ${text}`)
  }
  return /^\d+$/.test(rev) ? { db, at: Number(rev) } : { db, at: rev }
}

// ── the remote side: one client, and the flags that point it somewhere ─────────────────────────

interface Remote {
  headers: Record<string, string>
  url: string
  token: string | null
  json: boolean
  /** The SDK this command runs through. Nothing is opened until a call is made. */
  client: Client
}

/** An environment variable that is present but empty is not set, the way a shell means it. */
function set(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

async function remoteOf(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): Promise<Remote> {
  const context = await resolveContext({
    ...contextOptions(args, env),
    service: "database",
  })
  const { url, headers } = context,
    token = context.token ?? null
  const client = createClient({
    url,
    ...(token ? { token } : {}),
    headers,
    fetch: context.mode === "named" ? endpointFetch(url) : cliFetch,
    intMode: "string",
  })
  return { url, token, headers, json: args.flags.json === true, client }
}

function out(remote: Remote, payload: unknown, line: string): void {
  console.log(remote.json ? JSON.stringify(payload, null, 2) : line)
}

// ── commands ───────────────────────────────────────────────────────────────────────────────────

function startupConfig(args: ParsedArgs, initialize = false) {
  const file = str(args, "config") ?? process.env.BQL_CONFIG ?? "bql.toml"
  const overrides: ServerConfigInput = {}
  const dir = str(args, "dir")
  const port = num(args, "port")
  const host = str(args, "host")
  const node = str(args, "node")
  const adminKey = str(args, "admin-key")
  const workers = num(args, "workers")
  const replicaOf = str(args, "replica-of")
  const clusterSecret = str(args, "cluster-secret")
  const follow = str(args, "follow")
  const peers = str(args, "cluster-peers")
  const advertise = str(args, "advertise")
  const zone = str(args, "zone")
  const storageMode = initialize ? "object" : str(args, "storage-mode")
  const deploymentId = str(args, "deployment-id")
  if (storageMode !== undefined && storageMode !== "disk" && storageMode !== "object")
    throw new CliError("--storage-mode must be disk or object")
  overrides.data = {
    ...(dir !== undefined ? { dir } : {}),
    ...(storageMode !== undefined ? { storageMode } : {}),
    ...(deploymentId !== undefined ? { deploymentId } : {}),
  }
  if (port !== undefined || host !== undefined || node !== undefined || workers !== undefined) {
    overrides.server = {
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(node !== undefined ? { node } : {}),
      ...(workers !== undefined ? { workers } : {}),
    }
  }
  if (adminKey !== undefined) overrides.auth = { adminKey }
  const s3Url = str(args, "s3")
  const s3Endpoint = str(args, "s3-endpoint")
  const s3Region = str(args, "s3-region")
  if (s3Url !== undefined || s3Endpoint !== undefined || s3Region !== undefined) {
    // Credentials deliberately have no flag: they belong in the environment or the config file,
    // not in a shell history or a process listing.
    overrides.s3 = {
      ...(s3Url !== undefined ? parseS3Url(s3Url) : {}),
      ...(s3Endpoint !== undefined ? { endpoint: s3Endpoint } : {}),
      ...(s3Region !== undefined ? { region: s3Region } : {}),
    }
  }
  if (replicaOf !== undefined || clusterSecret !== undefined || follow !== undefined) {
    overrides.replication = {
      // `--replica-of` alone is the whole decision; `loadConfig` derives the role from it.
      ...(replicaOf !== undefined ? { primary: replicaOf } : {}),
      ...(clusterSecret !== undefined ? { secret: clusterSecret } : {}),
      ...(follow !== undefined
        ? {
            follow: follow
              .split(",")
              .map((one) => one.trim())
              .filter((one) => one.length > 0),
          }
        : {}),
    }
  }

  if (peers !== undefined || advertise !== undefined || zone !== undefined) {
    // `--cluster-peers` is the whole decision, as `--replica-of` is for replication: a node told
    // who its peers are is in a cluster.
    overrides.cluster = {
      ...(peers !== undefined
        ? {
            enabled: true,
            peers: peers
              .split(",")
              .map((one) => one.trim())
              .filter((one) => one.length > 0),
          }
        : {}),
      ...(advertise !== undefined ? { advertise } : {}),
      ...(zone !== undefined ? { zone } : {}),
    }
  }

  return loadConfig({
    file,
    required: Boolean(str(args, "config")),
    overrides,
    // A flag the operator typed beats a variable the shell happened to carry.
    env: { ...process.env, ...envSuppressions(overrides) },
  })
}

async function serve(args: ParsedArgs): Promise<void> {
  const config = startupConfig(args)
  if (config.data.storageMode === "object") {
    await serveObjectProcess(config)
    serving = true
    return
  }
  const handle = await startServer(config)
  serving = true
  const storage = config.s3.enabled
    ? `\nbql: shipping to s3://${config.s3.bucket}/${config.s3.prefix}, retention ` +
      `${config.s3.retention}`
    : ""
  const threads =
    handle.workers > 1
      ? `\nbql: ${handle.workers} worker threads; databases are sharded across them by name`
      : ""
  const cluster = config.cluster.enabled
    ? `\nbql: cluster ${config.cluster.id}, peers ${config.cluster.peers.join(", ") || "(none)"}` +
      `, lease ${config.cluster.leaseTtlMs}ms guard ${config.cluster.leaseGuardMs}ms`
    : ""
  const replication =
    config.replication.role === "replica"
      ? `\nbql: replica of ${config.replication.primary}, following ` +
        `${config.replication.follow.join(", ")}`
      : config.replication.secret
        ? "\nbql: /v1/replication is open to replicas holding the cluster secret"
        : ""
  console.log(
    `bql ${handle.url}  node=${config.server.node}  data=${config.data.dir}\n` +
      `bql: ${handle.registry.list().length} database(s), maxOpen ${config.data.maxOpen}, ` +
      `ack ${config.durability.defaultAck}${threads}${replication}${cluster}${storage}`,
  )
  if (!walChecksumIsNative()) {
    console.log(
      "bql: this libsqlite3 carries no bql_wal_* helper, so WAL frames are checksummed in " +
        "JavaScript — about 4.5 µs a frame, 16% of a write. `bun run sqlite:build` " +
        "fixes it. docs/p3-wal-checksum.md",
    )
  }
  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    console.log(`bql: ${signal}, shutting down`)
    void handle.close().then(() => process.exit(0))
  }
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("SIGTERM", () => stop("SIGTERM"))
}

/**
 * `loadConfig` applies the environment last, which is right for a server and wrong for a flag the
 * operator just typed. Clearing the variables a flag covers is what makes the flag win.
 */
function envSuppressions(overrides: ServerConfigInput): Record<string, string | undefined> {
  const cleared: Record<string, string | undefined> = {}
  if (overrides.data?.storageMode !== undefined) cleared.BQL_DATA_STORAGE_MODE = undefined
  if (overrides.data?.deploymentId !== undefined) cleared.BQL_DATA_DEPLOYMENT_ID = undefined
  if (overrides.data?.dir !== undefined) {
    cleared.BQL_DIR = undefined
    cleared.BQL_DATA_DIR = undefined
  }
  if (overrides.server?.port !== undefined) {
    cleared.BQL_PORT = undefined
    cleared.BQL_SERVER_PORT = undefined
  }
  if (overrides.server?.host !== undefined) {
    cleared.BQL_HOST = undefined
    cleared.BQL_SERVER_HOST = undefined
  }
  if (overrides.server?.node !== undefined) {
    cleared.BQL_NODE = undefined
    cleared.BQL_SERVER_NODE = undefined
  }
  if (overrides.auth?.adminKey !== undefined) {
    cleared.BQL_ADMIN_KEY = undefined
    cleared.BQL_AUTH_ADMIN_KEY = undefined
  }
  if (overrides.replication?.primary !== undefined) {
    cleared.BQL_REPLICA_OF = undefined
    cleared.BQL_REPLICATION_PRIMARY = undefined
  }
  if (overrides.replication?.secret !== undefined) {
    cleared.BQL_CLUSTER_SECRET = undefined
    cleared.BQL_REPLICATION_SECRET = undefined
  }
  if (overrides.replication?.follow !== undefined) {
    cleared.BQL_FOLLOW = undefined
    cleared.BQL_REPLICATION_FOLLOW = undefined
  }
  if (overrides.s3?.bucket !== undefined) {
    cleared.BQL_S3_URL = undefined
    cleared.BQL_S3_BUCKET = undefined
    cleared.BQL_S3_PREFIX = undefined
  }
  if (overrides.cluster?.peers !== undefined) {
    cleared.BQL_CLUSTER_PEERS = undefined
    cleared.BQL_CLUSTER_ENABLED = undefined
  }
  if (overrides.cluster?.advertise !== undefined) cleared.BQL_CLUSTER_ADVERTISE = undefined
  if (overrides.cluster?.zone !== undefined) cleared.BQL_CLUSTER_ZONE = undefined
  if (overrides.s3?.endpoint !== undefined) cleared.BQL_S3_ENDPOINT = undefined
  if (overrides.s3?.region !== undefined) cleared.BQL_S3_REGION = undefined
  return cleared
}

async function dbCommand(args: ParsedArgs, remote: Remote): Promise<void> {
  const [, action, name] = args.positional
  const admin = remote.client.admin
  switch (action) {
    case "create": {
      if (!name) throw new CliError("db create needs a name")
      const from = str(args, "from")
      const pageSize = num(args, "page-size")
      const quotaBytes = num(args, "quota-bytes")
      const stats = await admin.create(name, {
        ...(from ? { from: parseFrom(from) } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(quotaBytes !== undefined ? { quotaBytes } : {}),
      })
      out(remote, stats, `created ${stats.name} at txid ${stats.txid}`)
      return
    }
    // `branch` is `fork` under the name the workflow uses; both record lineage (X2).
    case "fork":
    case "branch": {
      if (!name) throw new CliError(`db ${action} needs a name`)
      const from = str(args, "from")
      if (!from) throw new CliError(`db ${action} needs --from <db>[@<txid|time>]`)
      const source = parseFrom(from)
      const stats = await admin.fork(name, source.db, source.at)
      const verb = action === "fork" ? "forked" : "branched"
      out(remote, stats, `${verb} ${from} into ${stats.name} at txid ${stats.txid}`)
      return
    }
    case "branches": {
      const all = await admin.list()
      const branches = all.filter((row) => (name ? row.parent === name : row.parent !== null))
      if (name && !all.some((row) => row.name === name)) {
        throw new CliError(`DB_NOT_FOUND: database ${name} does not exist`)
      }
      if (remote.json) {
        console.log(JSON.stringify({ databases: branches }, null, 2))
        return
      }
      if (branches.length === 0) {
        console.log(name ? `${name} has no branches` : "no branches")
        return
      }
      console.log(
        Bun.inspect.table(
          branches.map((row) => ({
            name: row.name,
            parent: row.parentDeleted ? `${row.parent} (deleted)` : row.parent,
            forkedAt: row.forkedAt,
            txid: row.txid,
          })),
        ),
      )
      return
    }
    case "diff": {
      const other = args.positional[3]
      if (!name || !other) throw new CliError("db diff needs two databases: db diff <a> <b>")
      // Both exist, or the answer would be "every table was added" rather than an error.
      await Promise.all([admin.stat(name), admin.stat(other)])
      const diff = await diffSchema(remote.client.db(name), remote.client.db(other))
      out(remote, diff, formatSchemaDiff(diff, { a: name, b: other }))
      return
    }
    case "reset": {
      if (!name) throw new CliError("db reset needs a branch")
      const stats = await admin.reset(name)
      out(
        remote,
        stats,
        `reset ${stats.name} to ${stats.parent} at txid ${stats.forkedAt}; ` +
          "its previous files are in the trash",
      )
      return
    }
    case "list": {
      const databases = await admin.list()
      // `--json` prints the route's own body, envelope and all, which is what a script parses.
      if (remote.json) {
        console.log(JSON.stringify({ databases }, null, 2))
        return
      }
      if (databases.length === 0) {
        console.log("no databases")
        return
      }
      console.log(Bun.inspect.table(databases))
      return
    }
    case "stat": {
      if (!name) throw new CliError("db stat needs a name")
      const stats = await admin.stat(name)
      out(
        remote,
        stats,
        `${stats.name}  txid ${stats.txid}  ${stats.sizeBytes} B  wal ${stats.walBytes} B  ` +
          `log ${stats.logBytes} B  ${stats.subscribers} subscriber(s), ` +
          `${stats.liveQueries} live quer(ies)`,
      )
      return
    }
    case "delete": {
      if (!name) throw new CliError("db delete needs a name")
      const body = await admin.delete(name)
      out(remote, body, `deleted ${body.name}; its files are in ${body.trash}`)
      return
    }
    default:
      throw new CliError(`unknown db command ${JSON.stringify(action ?? "")}`)
  }
}

async function snapshot(args: ParsedArgs, remote: Remote): Promise<void> {
  const name = args.positional[1]
  if (!name) throw new CliError("snapshot needs a database")
  const body = await remote.client.admin.snapshot(name)
  out(remote, body, `snapshot ${body.snapshotId} at txid ${body.txid} (${body.bytes} B)`)
}

/** `s3://bucket/prefix` — the spelling design §4.4 writes and the one an operator types. */
export function parseS3Url(text: string): { bucket: string; prefix?: string } {
  if (!text.startsWith("s3://")) {
    throw new CliError(`--from wants s3://bucket/prefix, got ${text}`)
  }
  const rest = text.slice("s3://".length)
  const slash = rest.indexOf("/")
  const bucket = slash < 0 ? rest : rest.slice(0, slash)
  if (bucket.length === 0) throw new CliError(`--from names no bucket: ${text}`)
  const prefix = slash < 0 ? "" : rest.slice(slash + 1)
  return { bucket, ...(prefix.length > 0 ? { prefix } : {}) }
}

/** A txid stays a number so the server can tell it from a timestamp; anything else is a string. */
function atValue(at: string): Revision {
  return /^\d+$/.test(at) ? Number(at) : at
}

async function restore(args: ParsedArgs, remote: Remote): Promise<void> {
  const name = args.positional[1]
  if (!name) throw new CliError("restore needs a database")
  const at = str(args, "at")
  const into = str(args, "into")
  const from = str(args, "from")
  const generation = str(args, "generation")

  if (from !== undefined) {
    const body = await remote.client.admin.restore(name, {
      from: "s3",
      ...parseS3Url(from),
      ...(at !== undefined ? { at: atValue(at) } : {}),
      ...(into ? { into } : {}),
      ...(generation ? { generation } : {}),
    })
    out(
      remote,
      body,
      `restored ${body.from} from s3://${body.bucket}/${body.prefix} into ${body.name} ` +
        `at txid ${body.txid} (${body.applied} record(s) from ${body.objects} object(s))`,
    )
    return
  }

  if (at === undefined) throw new CliError("restore needs --at <txid|time>, or --from s3://…")
  const body = await remote.client.admin.restore(name, {
    at: atValue(at),
    ...(into ? { into } : {}),
  })
  const at_ = "at" in body ? body.at : body.txid
  out(remote, body, `restored ${body.from}@${at_} into ${body.name} (txid ${body.txid})`)
}

async function backup(args: ParsedArgs, remote: Remote): Promise<void> {
  const [, action, name] = args.positional
  if (!name) throw new CliError(`backup ${action ?? ""} needs a database`)
  const from = str(args, "from")
  const target = from === undefined ? {} : parseS3Url(from)
  const admin = remote.client.admin

  switch (action) {
    case "status": {
      const body = await admin.backup(name)
      if (!body.enabled && !body.bucket) {
        out(remote, body, `${name}: no [s3] bucket configured on this node`)
        return
      }
      const ship = body.shipper
      const line = ship
        ? `${name} → s3://${body.bucket}/${body.prefix ?? ""}  shipped txid ${ship.shippedTxid}  ` +
          `${ship.pendingRecords} pending  ${ship.behind ? "BEHIND" : "caught up"}  ` +
          `${ship.snapshots} snapshot(s), ${ship.segments} segment(s), ${ship.errors} error(s)` +
          (ship.lastError ? `\nlast error: ${ship.lastError}` : "")
        : `${name} → s3://${body.bucket}/${body.prefix ?? ""}  not shipping` +
          (body.error ? ` (${body.error})` : "")
      out(remote, body, line)
      return
    }
    case "verify": {
      const at = str(args, "at")
      const body = await admin.verifyBackup(name, {
        ...target,
        ...(at !== undefined ? { at: atValue(at) } : {}),
      })
      out(
        remote,
        body,
        body.ok
          ? `${name} is restorable to txid ${body.at} (latest ${body.latest}) from ` +
              `${body.segments} segment(s), ${body.records} record(s), ${body.bytes} B`
          : `${name} is NOT restorable to txid ${body.at}: missing ${body.missing.join(", ")}`,
      )
      return
    }
    case "generations": {
      const body = await admin.generations(name)
      if (remote.json) {
        console.log(JSON.stringify(body, null, 2))
        return
      }
      if (body.generations.length === 0) console.log("no generations")
      else console.log(Bun.inspect.table(body.generations))
      return
    }
    default:
      throw new CliError(`unknown backup command ${JSON.stringify(action ?? "")}`)
  }
}

async function checkpoint(args: ParsedArgs, remote: Remote): Promise<void> {
  const name = args.positional[1]
  if (!name) throw new CliError("checkpoint needs a database")
  const mode = (str(args, "mode") ?? "PASSIVE").toUpperCase() as CheckpointMode
  const body = await remote.client.admin.checkpoint(name, mode)
  out(remote, body, `checkpoint ${body.mode} at txid ${body.txid}; wal is ${body.walBytes} B`)
}

async function token(args: ParsedArgs, remote: Remote): Promise<void> {
  const db = str(args, "db")
  if (!db) throw new CliError("token needs --db <name or glob>")
  const scope = str(args, "scope") ?? "ro"
  if (scope !== "ro" && scope !== "rw") throw new CliError("--scope must be ro or rw")
  const ttl = str(args, "ttl")
  const tables = str(args, "tables")
  const body = await remote.client.admin.mintToken({
    dbs: db
      .split(",")
      .map((one) => one.trim())
      .filter((one) => one.length > 0),
    scope,
    ...(ttl ? { ttlMs: parseTtlMs(ttl) } : {}),
    ...(tables ? { tables: parseTables(tables) } : {}),
  })
  // The bare token on stdout is what makes `TOKEN=$(bql token --db acme)` work.
  out(remote, body, body.token)
}

/**
 * The REPL of design §9.3, over the WebSocket protocol of §7. One statement per line; a line that
 * does not end in `;` is continued, so a statement can be typed across several.
 */
async function shell(args: ParsedArgs, remote: Remote): Promise<void> {
  const db = args.positional[1]
  if (!db) throw new CliError("shell needs a database")
  const factory = cliSocketFactory(remote.headers)
  if (!factory) throw new CliError("this runtime has no WebSocket")
  const socket = new SocketClient({
    url: `${remote.url.replace(/^http/, "ws")}/v1/ws`,
    token: remote.token,
    factory,
  })
  await socket.connect()
  console.log(`bql shell on ${db} — .exit to leave, .tables for the schema`)
  let buffer = ""
  process.stdout.write("bql> ")
  for await (const line of console) {
    const text = String(line)
    const trimmed = text.trim()
    if (trimmed === ".exit" || trimmed === ".quit") break
    if (trimmed.length === 0 && buffer.length === 0) {
      process.stdout.write("bql> ")
      continue
    }
    const statement =
      trimmed === ".tables"
        ? "select name, type from sqlite_schema where name not like 'sqlite_%' order by name"
        : trimmed
    buffer = buffer.length > 0 ? `${buffer}\n${statement}` : statement
    if (!buffer.trimEnd().endsWith(";") && trimmed !== ".tables") {
      process.stdout.write("   ...> ")
      continue
    }
    const sql = buffer.trimEnd().replace(/;$/, "")
    buffer = ""
    try {
      const reply = await socket.request<{ result: QueryResult }>({
        op: "query",
        db,
        sql,
        rows: "object",
      })
      const result = reply.result
      const rows = decodeRows(result.rows, "string") as JsRow[]
      if (rows.length > 0) console.log(Bun.inspect.table(rows))
      else {
        console.log(
          `ok — ${result.rowsAffected} row(s) affected, txid ${result.txid}, ` +
            `${result.durationUs} µs`,
        )
      }
    } catch (err) {
      const message = err instanceof BqlClientError ? `${err.code}: ${err.message}` : String(err)
      console.error(message)
    }
    process.stdout.write("bql> ")
  }
  socket.close()
}

/** A one-shot statement, which is what `--sql` on the shell command is for. */
async function exec(args: ParsedArgs, remote: Remote): Promise<void> {
  const db = args.positional[1]
  const sql = str(args, "sql")
  if (!db || !sql) throw new CliError("exec needs a database and --sql")
  const rows = await remote.client.db(db).unsafe(sql)
  if (remote.json) console.log(JSON.stringify(rows, null, 2))
  else if (rows.length > 0) console.log(Bun.inspect.table(rows))
  else console.log(`ok — ${rows.affectedRows} row(s) affected, txid ${rows.txid}`)
}

/**
 * `bql promote <db>` — design §9.3 and `docs/c2-promotion.md`. It addresses the node that should
 * become the primary, because the promotion is that node's local copy being accepted: `--url` is
 * the candidate, not the cluster.
 */
async function promote(args: ParsedArgs, remote: Remote): Promise<void> {
  const name = args.positional[1]
  if (!name) throw new CliError("promote needs a database")
  const body = await remote.client.admin.promote(name, {
    force: args.flags.force === true,
  })
  out(
    remote,
    body,
    `${body.db} promoted on ${remote.url}: epoch ${body.epoch}, txid ${body.txid}\n${body.why}`,
  )
}

/** `bql cluster` — the observable surface of the control plane (`docs/plan-phase2.md` C1). */
async function cluster(args: ParsedArgs, remote: Remote): Promise<void> {
  const body = await remote.client.admin.cluster()
  if (remote.json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  console.log(
    `${body.id}  ${body.role}  term ${body.term}  leader ${body.leader ?? "(none)"}  ` +
      `commit ${body.commitIndex}/${body.appliedIndex}`,
  )
  console.log(
    Bun.inspect.table(
      body.nodes.map((node) => ({
        node: node.id,
        advertise: node.advertise,
        zone: node.zone,
        status: node.status,
        reachable: node.reachable,
        voter: body.voters.includes(node.id),
      })),
    ),
  )
  if (body.dbs.length === 0) {
    console.log("no databases placed")
    return
  }
  console.log(
    Bun.inspect.table(
      body.dbs.map((db) => ({
        db: db.db,
        primary: db.primary ?? "(none)",
        replicas: db.replicas.join(",") || "-",
        epoch: db.epoch,
        // The lease's `until` is the leader's wall clock, so it is only meaningful against the
        // node's own `nowMs`, which the route sends beside it.
        leaseMs: db.lease ? db.lease.until - body.nowMs : null,
        holder: db.lease?.node ?? "(none)",
        here: db.leaseHeldHere,
        generation: db.generation ?? "-",
      })),
    ),
  )
}

export async function main(argv: readonly string[]): Promise<number> {
  // The bus has its own command set and flag parser, and reads \`process.argv\` when it loads; \`bql\`
  // is the one entry point, so \`bql bus …\` hands it the rest of the line and keeps the process alive
  // for as long as the bus wants it (\`serve\`, \`consume\`, \`tail\` exit on their own).
  if (argv[0] === "bus") {
    process.argv = [process.argv[0] as string, process.argv[1] as string, ...argv.slice(1)]
    serving = true
    try {
      await import("../../bus/src/cli/index.ts")
      return 0
    } catch (err) {
      serving = false
      console.error(`bql: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }
  const args = parseArgs(argv)
  const command = args.positional[0]
  if (args.flags.version === true) {
    console.log(VERSION)
    return 0
  }
  if (!command || args.flags.help === true || command === "help") {
    if (command === "deploy") { console.log(DEPLOY_HELP); return 0 }
    console.log(USAGE)
    return command || args.flags.help === true ? 0 : 1
  }
  let remote: Remote | undefined
  try {
    if (await runDeployCommand(args, { cwd: process.cwd(), env: process.env })) return 0
    if (await runContextCommand(args, { cwd: process.cwd(), env: process.env })) return 0
    if (command === "cloud") {
      if (args.positional[1] !== "init")
        throw new CliError("Usage: bql cloud init --deployment-id ID")
      const config = startupConfig(args, true)
      await initializeObjectServer(config)
      console.log(`bql: initialized object storage for ${config.data.deploymentId}`)
      return 0
    }
    if (command === "serve") {
      await serve(args)
      return 0
    }
    remote = await remoteOf(args, process.env)
    switch (command) {
      case "db":
        await dbCommand(args, remote)
        return 0
      case "snapshot":
        await snapshot(args, remote)
        return 0
      case "restore":
        await restore(args, remote)
        return 0
      case "backup":
        await backup(args, remote)
        return 0
      case "checkpoint":
        await checkpoint(args, remote)
        return 0
      case "promote":
        await promote(args, remote)
        return 0
      case "cluster":
        await cluster(args, remote)
        return 0
      case "token":
        await token(args, remote)
        return 0
      case "shell":
        await shell(args, remote)
        return 0
      case "exec":
        await exec(args, remote)
        return 0
      default:
        console.error(`bql: unknown command ${JSON.stringify(command)}`)
        console.error(USAGE)
        return 1
    }
  } catch (err) {
    const message =
      err instanceof CliError
        ? err.message
        : err instanceof BqlClientError
          ? // A request that never reached the server is an operator's typo or a server that is
            // not running, so it names the URL rather than the route.
            err.code === "NETWORK"
            ? `cannot reach ${remote?.url ?? "endpoint"}: ${err.message}`
            : `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
    console.error(`bql: ${message}`)
    return 1
  } finally {
    // `serve` is the one command still doing its job after `main` returns, and it never used the
    // client; everything else is finished with it here.
    if (!serving) remote?.client.close()
  }
}

// `serve` resolves as soon as it is listening, and the listener is the point, so it is the one
// command that does not exit when `main` returns.
if (import.meta.main) {
  const code = await main(Bun.argv.slice(2))
  if (!serving) process.exit(code)
}
