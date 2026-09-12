#!/usr/bin/env bun
// The command line of design §9.3. `serve` opens the data directory in this process; every other
// command is an HTTP client of a server that already has it open, because a second process writing
// the catalog would be a second writer for it.
//
// Invariant: no dependencies and no framework. The flag parser below is twenty lines and the
// output is either a line a human reads or, with `--json`, the server's own body.

import { createClient } from "./client/index.ts"
import { BunQLClientError } from "./client/errors.ts"
import { decodeRows, type JsRow } from "./client/values.ts"
import type { QueryResult } from "./client/protocol.ts"
import { SocketClient, defaultWebSocketFactory } from "./client/socket.ts"
import { startServer } from "./server/app.ts"
import { loadConfig, type ServerConfigInput } from "./server/config.ts"

const VERSION = "0.0.0"

/** Set by `serve`, which is the one command that is still doing its job when `main` returns. */
let serving = false

const USAGE = `bunql — SQLite as a multi-tenant database server (design §9.3)

  bunql serve [--dir ./data] [--port 4321] [--host 0.0.0.0] [--config bunql.toml] [--admin-key K]
              [--replica-of wss://primary/v1/replication] [--cluster-secret S] [--follow a,b]
  bunql db create <name> [--from <db>[@<txid|time>]] [--page-size N] [--quota-bytes N]
  bunql db list
  bunql db stat <name>
  bunql db delete <name>
  bunql db fork <name> --from <db>[@<txid|time>]
  bunql snapshot <db>
  bunql restore <db> --at <txid|time> [--into <name>]
  bunql checkpoint <db> [--mode PASSIVE|FULL|RESTART|TRUNCATE]
  bunql token --db <name> [--scope ro|rw] [--ttl 30d] [--tables 'todos:r,users:rw']
  bunql exec <db> --sql "select 1"
  bunql shell <db>

Remote commands talk to a running server:
  --url   base URL          (default $BUNQL_URL, else http://127.0.0.1:4321)
  --token bearer token      (default $BUNQL_TOKEN, else $BUNQL_ADMIN_KEY)
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

/** `todos:r,users:rw` — the table ACL of design §6. */
export function parseTables(text: string): Record<string, "r" | "w" | "rw"> {
  const out: Record<string, "r" | "w" | "rw"> = {}
  for (const entry of text.split(",")) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const colon = trimmed.lastIndexOf(":")
    if (colon <= 0) throw new CliError(`--tables wants name:scope entries, got ${trimmed}`)
    const table = trimmed.slice(0, colon)
    const scope = trimmed.slice(colon + 1)
    if (scope !== "r" && scope !== "w" && scope !== "rw") {
      throw new CliError(`table scope must be r, w or rw, got ${scope}`)
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

// ── the HTTP side ──────────────────────────────────────────────────────────────────────────────

interface Remote {
  url: string
  token: string | null
  json: boolean
}

/** An environment variable that is present but empty is not set, the way a shell means it. */
function set(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

function remoteOf(args: ParsedArgs, env: Record<string, string | undefined>): Remote {
  const url = (str(args, "url") ?? set(env.BUNQL_URL) ?? "http://127.0.0.1:4321").replace(
    /\/+$/,
    "",
  )
  const token = str(args, "token") ?? set(env.BUNQL_TOKEN) ?? set(env.BUNQL_ADMIN_KEY) ?? null
  return { url, token, json: args.flags.json === true }
}

async function api<T>(
  remote: Remote,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {}
  if (remote.token) headers.authorization = `Bearer ${remote.token}`
  if (body !== undefined) headers["content-type"] = "application/json"
  let response: Response
  try {
    response = await fetch(`${remote.url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (err) {
    throw new CliError(
      `cannot reach ${remote.url}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code: string; message: string } } | null)?.error
    throw new CliError(
      error ? `${error.code}: ${error.message}` : `${method} ${path} failed (${response.status})`,
    )
  }
  return parsed as T
}

function out(remote: Remote, payload: unknown, line: string): void {
  console.log(remote.json ? JSON.stringify(payload, null, 2) : line)
}

// ── commands ───────────────────────────────────────────────────────────────────────────────────

async function serve(args: ParsedArgs): Promise<void> {
  const file = str(args, "config") ?? process.env.BUNQL_CONFIG ?? "bunql.toml"
  const overrides: ServerConfigInput = {}
  const dir = str(args, "dir")
  const port = num(args, "port")
  const host = str(args, "host")
  const node = str(args, "node")
  const adminKey = str(args, "admin-key")
  const replicaOf = str(args, "replica-of")
  const clusterSecret = str(args, "cluster-secret")
  const follow = str(args, "follow")
  if (dir !== undefined) overrides.data = { dir }
  if (port !== undefined || host !== undefined || node !== undefined) {
    overrides.server = {
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(node !== undefined ? { node } : {}),
    }
  }
  if (adminKey !== undefined) overrides.auth = { adminKey }
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

  const config = loadConfig({
    file,
    required: Boolean(str(args, "config")),
    overrides,
    // A flag the operator typed beats a variable the shell happened to carry.
    env: { ...process.env, ...envSuppressions(overrides) },
  })
  const handle = await startServer(config)
  serving = true
  const replication =
    config.replication.role === "replica"
      ? `\nbunql: replica of ${config.replication.primary}, following ` +
        `${config.replication.follow.join(", ")}`
      : config.replication.secret
        ? "\nbunql: /v1/replication is open to replicas holding the cluster secret"
        : ""
  console.log(
    `bunql ${handle.url}  node=${config.server.node}  data=${config.data.dir}\n` +
      `bunql: ${handle.registry.list().length} database(s), maxOpen ${config.data.maxOpen}, ` +
      `ack ${config.durability.defaultAck}${replication}`,
  )
  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    console.log(`bunql: ${signal}, shutting down`)
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
  if (overrides.data?.dir !== undefined) {
    cleared.BUNQL_DIR = undefined
    cleared.BUNQL_DATA_DIR = undefined
  }
  if (overrides.server?.port !== undefined) {
    cleared.BUNQL_PORT = undefined
    cleared.BUNQL_SERVER_PORT = undefined
  }
  if (overrides.server?.host !== undefined) {
    cleared.BUNQL_HOST = undefined
    cleared.BUNQL_SERVER_HOST = undefined
  }
  if (overrides.server?.node !== undefined) {
    cleared.BUNQL_NODE = undefined
    cleared.BUNQL_SERVER_NODE = undefined
  }
  if (overrides.auth?.adminKey !== undefined) {
    cleared.BUNQL_ADMIN_KEY = undefined
    cleared.BUNQL_AUTH_ADMIN_KEY = undefined
  }
  if (overrides.replication?.primary !== undefined) {
    cleared.BUNQL_REPLICA_OF = undefined
    cleared.BUNQL_REPLICATION_PRIMARY = undefined
  }
  if (overrides.replication?.secret !== undefined) {
    cleared.BUNQL_CLUSTER_SECRET = undefined
    cleared.BUNQL_REPLICATION_SECRET = undefined
  }
  if (overrides.replication?.follow !== undefined) {
    cleared.BUNQL_FOLLOW = undefined
    cleared.BUNQL_REPLICATION_FOLLOW = undefined
  }
  return cleared
}

interface DbStats {
  name: string
  txid: number
  sizeBytes: number
  walBytes: number
  logBytes: number
  liveQueries: number
  subscribers: number
}

async function dbCommand(args: ParsedArgs, remote: Remote): Promise<void> {
  const [, action, name] = args.positional
  switch (action) {
    case "create": {
      if (!name) throw new CliError("db create needs a name")
      const from = str(args, "from")
      const body = {
        name,
        ...(from ? { from: parseFrom(from) } : {}),
        ...(num(args, "page-size") !== undefined ? { pageSize: num(args, "page-size") } : {}),
        ...(num(args, "quota-bytes") !== undefined
          ? { quotaBytes: num(args, "quota-bytes") }
          : {}),
      }
      const stats = await api<DbStats>(remote, "POST", "/v1/db", body)
      out(remote, stats, `created ${stats.name} at txid ${stats.txid}`)
      return
    }
    case "fork": {
      if (!name) throw new CliError("db fork needs a name")
      const from = str(args, "from")
      if (!from) throw new CliError("db fork needs --from <db>[@<txid|time>]")
      const stats = await api<DbStats>(remote, "POST", "/v1/db", {
        name,
        from: parseFrom(from),
      })
      out(remote, stats, `forked ${from} into ${stats.name} at txid ${stats.txid}`)
      return
    }
    case "list": {
      const body = await api<{ databases: Record<string, unknown>[] }>(remote, "GET", "/v1/db")
      if (remote.json) {
        console.log(JSON.stringify(body, null, 2))
        return
      }
      if (body.databases.length === 0) {
        console.log("no databases")
        return
      }
      console.log(Bun.inspect.table(body.databases))
      return
    }
    case "stat": {
      if (!name) throw new CliError("db stat needs a name")
      const stats = await api<DbStats>(remote, "GET", `/v1/db/${name}`)
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
      const body = await api<{ name: string; trash: string }>(
        remote,
        "DELETE",
        `/v1/db/${name}`,
      )
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
  const body = await api<{ snapshotId: string; txid: number; bytes: number }>(
    remote,
    "POST",
    `/v1/db/${name}/snapshot`,
  )
  out(remote, body, `snapshot ${body.snapshotId} at txid ${body.txid} (${body.bytes} B)`)
}

async function restore(args: ParsedArgs, remote: Remote): Promise<void> {
  const name = args.positional[1]
  if (!name) throw new CliError("restore needs a database")
  const at = str(args, "at")
  if (at === undefined) throw new CliError("restore needs --at <txid|time>")
  const into = str(args, "into")
  const body = await api<{ name: string; txid: number; from: string; at: number }>(
    remote,
    "POST",
    `/v1/db/${name}/restore`,
    { at: /^\d+$/.test(at) ? Number(at) : at, ...(into ? { into } : {}) },
  )
  out(remote, body, `restored ${body.from}@${body.at} into ${body.name} (txid ${body.txid})`)
}

async function checkpoint(args: ParsedArgs, remote: Remote): Promise<void> {
  const name = args.positional[1]
  if (!name) throw new CliError("checkpoint needs a database")
  const mode = (str(args, "mode") ?? "PASSIVE").toUpperCase()
  const body = await api<{ mode: string; walBytes: number; txid: number }>(
    remote,
    "POST",
    `/v1/db/${name}/checkpoint`,
    { mode },
  )
  out(remote, body, `checkpoint ${body.mode} at txid ${body.txid}; wal is ${body.walBytes} B`)
}

async function token(args: ParsedArgs, remote: Remote): Promise<void> {
  const db = str(args, "db")
  if (!db) throw new CliError("token needs --db <name or glob>")
  const scope = str(args, "scope") ?? "ro"
  if (scope !== "ro" && scope !== "rw") throw new CliError("--scope must be ro or rw")
  const ttl = str(args, "ttl")
  const tables = str(args, "tables")
  const body = await api<{ token: string; jti: string; exp: number | null }>(
    remote,
    "POST",
    "/v1/tokens",
    {
      dbs: db.split(",").map((one) => one.trim()).filter((one) => one.length > 0),
      scope,
      ...(ttl ? { ttlMs: parseTtlMs(ttl) } : {}),
      ...(tables ? { tables: parseTables(tables) } : {}),
    },
  )
  // The bare token on stdout is what makes `TOKEN=$(bunql token --db acme)` work.
  out(remote, body, body.token)
}

/**
 * The REPL of design §9.3, over the WebSocket protocol of §7. One statement per line; a line that
 * does not end in `;` is continued, so a statement can be typed across several.
 */
async function shell(args: ParsedArgs, remote: Remote): Promise<void> {
  const db = args.positional[1]
  if (!db) throw new CliError("shell needs a database")
  const factory = defaultWebSocketFactory()
  if (!factory) throw new CliError("this runtime has no WebSocket")
  const socket = new SocketClient({
    url: `${remote.url.replace(/^http/, "ws")}/v1/ws`,
    token: remote.token,
    factory,
  })
  await socket.connect()
  console.log(`bunql shell on ${db} — .exit to leave, .tables for the schema`)
  let buffer = ""
  process.stdout.write("bunql> ")
  for await (const line of console) {
    const text = String(line)
    const trimmed = text.trim()
    if (trimmed === ".exit" || trimmed === ".quit") break
    if (trimmed.length === 0 && buffer.length === 0) {
      process.stdout.write("bunql> ")
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
      const message = err instanceof BunQLClientError ? `${err.code}: ${err.message}` : String(err)
      console.error(message)
    }
    process.stdout.write("bunql> ")
  }
  socket.close()
}

/** A one-shot statement, which is what `--sql` on the shell command is for. */
async function exec(args: ParsedArgs, remote: Remote): Promise<void> {
  const db = args.positional[1]
  const sql = str(args, "sql")
  if (!db || !sql) throw new CliError("exec needs a database and --sql")
  const client = createClient({
    url: remote.url,
    ...(remote.token ? { token: remote.token } : {}),
    intMode: "string",
  })
  try {
    const rows = await client.db(db).unsafe(sql)
    if (remote.json) console.log(JSON.stringify(rows, null, 2))
    else if (rows.length > 0) console.log(Bun.inspect.table(rows))
    else console.log(`ok — ${rows.affectedRows} row(s) affected, txid ${rows.txid}`)
  } finally {
    client.close()
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  const command = args.positional[0]
  if (args.flags.version === true) {
    console.log(VERSION)
    return 0
  }
  if (!command || args.flags.help === true || command === "help") {
    console.log(USAGE)
    return command || args.flags.help === true ? 0 : 1
  }
  const remote = remoteOf(args, process.env as Record<string, string | undefined>)
  try {
    switch (command) {
      case "serve":
        await serve(args)
        return 0
      case "db":
        await dbCommand(args, remote)
        return 0
      case "snapshot":
        await snapshot(args, remote)
        return 0
      case "restore":
        await restore(args, remote)
        return 0
      case "checkpoint":
        await checkpoint(args, remote)
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
        console.error(`bunql: unknown command ${JSON.stringify(command)}`)
        console.error(USAGE)
        return 1
    }
  } catch (err) {
    const message =
      err instanceof CliError
        ? err.message
        : err instanceof BunQLClientError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
    console.error(`bunql: ${message}`)
    return 1
  }
}

// `serve` resolves as soon as it is listening, and the listener is the point, so it is the one
// command that does not exit when `main` returns.
if (import.meta.main) {
  const code = await main(Bun.argv.slice(2))
  if (!serving) process.exit(code)
}
