// A primary and one or more replicas, in this process, on ephemeral ports, each with its own data
// directory and all sharing one cluster secret.
//
// The order matters: a replica needs the primary's `wss://` URL, and the port is only known once
// the primary is listening, so `startCluster` starts the primary first and builds each replica's
// configuration from the URL it got.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, type ServerHandle } from "../../src/server/app.ts"
import { loadConfig, type ServerConfigInput } from "../../src/server/config.ts"
import { removeTempDir } from "../tmpdir.ts"

const dirs: string[] = []
const running: ServerHandle[] = []

export const CLUSTER_SECRET = "test-cluster-secret-0123456789"

export function tempDir(prefix = "bql-repl-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export interface Node {
  handle: ServerHandle
  url: string
  /** The `ws://…/v1/replication` a replica of this node connects to. */
  replicationUrl: string
  dir: string
  adminKey: string
  fetch(route: string, init?: RequestInit & { token?: string | null }): Promise<Response>
  json<T = unknown>(route: string, init?: RequestInit & { token?: string | null }): Promise<T>
  close(): Promise<void>
}

function client(handle: ServerHandle, adminKey: string): Pick<Node, "fetch" | "json"> {
  const base = `http://127.0.0.1:${handle.server.port}`
  const call = (
    route: string,
    init: RequestInit & { token?: string | null } = {},
  ): Promise<Response> => {
    const { token, ...rest } = init
    const headers = new Headers(rest.headers)
    const bearer = token === undefined ? adminKey : token
    if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`)
    if (rest.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }
    return fetch(`${base}${route}`, { ...rest, headers })
  }
  return {
    fetch: call,
    async json<T>(route: string, init?: RequestInit & { token?: string | null }): Promise<T> {
      const response = await call(route, init)
      return (await response.json()) as T
    },
  }
}

async function start(dir: string, overrides: ServerConfigInput): Promise<Node> {
  const config = loadConfig({
    env: {},
    overrides: {
      ...overrides,
      server: { port: 0, host: "127.0.0.1", ...overrides.server },
      data: { dir, ...overrides.data },
      limits: { txIdleTimeoutMs: 1000, ...overrides.limits },
      // A short heartbeat keeps the lag numbers and the `follow: ["*"]` refresh inside a test's
      // patience without making the tests sleep for them.
      replication: { heartbeatMs: 100, reconnectMs: 20, ...overrides.replication },
    },
  })
  const handle = await startServer(config, {
    log: () => {},
    // `BQL_TEST_REPLICATION_LOG=1` turns the nodes' internal failures back on, which is the
    // first thing to reach for when a replication test goes quiet instead of red.
    onError: process.env.BQL_TEST_REPLICATION_LOG
      ? (err) => console.error(`[${config.server.node}]`, err)
      : () => {},
  })
  running.push(handle)
  const adminKey = handle.adminKey as string
  return {
    handle,
    url: `http://127.0.0.1:${handle.server.port}`,
    replicationUrl: `ws://127.0.0.1:${handle.server.port}/v1/replication`,
    dir,
    adminKey,
    ...client(handle, adminKey),
    async close(): Promise<void> {
      const at = running.indexOf(handle)
      if (at >= 0) running.splice(at, 1)
      await handle.close()
    },
  }
}

/**
 * A primary on its own. `secret` defaults to the shared cluster secret; pass "" to disable.
 * `dir` reuses a data directory, which is how a test restarts a node that has state.
 */
export function startPrimary(
  overrides: ServerConfigInput = {},
  options: { dir?: string; node?: string } = {},
): Promise<Node> {
  return start(options.dir ?? tempDir("bql-primary-"), {
    ...overrides,
    server: { node: options.node ?? "primary", ...overrides.server },
    replication: { secret: CLUSTER_SECRET, ...overrides.replication },
  })
}

/** A replica following `primary`. Its data directory is reused when one is passed, for restarts. */
export function startReplica(
  primary: Node,
  options: { node?: string; dir?: string; follow?: string[]; overrides?: ServerConfigInput } = {},
): Promise<Node> {
  const dir = options.dir ?? tempDir("bql-replica-")
  const overrides = options.overrides ?? {}
  return start(dir, {
    ...overrides,
    server: { node: options.node ?? "replica", ...overrides.server },
    replication: {
      secret: CLUSTER_SECRET,
      primary: primary.replicationUrl,
      ...(options.follow ? { follow: options.follow } : {}),
      ...overrides.replication,
    },
  })
}

export interface Cluster {
  primary: Node
  replicas: Node[]
  close(): Promise<void>
}

/** A primary and `replicas` replicas of it, all connected. */
export async function startCluster(
  replicas = 1,
  options: { follow?: string[] } = {},
): Promise<Cluster> {
  const primary = await startPrimary()
  const nodes: Node[] = []
  for (let i = 0; i < replicas; i++) {
    nodes.push(
      await startReplica(primary, {
        node: `replica-${i + 1}`,
        ...(options.follow ? { follow: options.follow } : {}),
      }),
    )
  }
  return {
    primary,
    replicas: nodes,
    async close(): Promise<void> {
      for (const node of nodes) await node.close()
      await primary.close()
    },
  }
}

export async function stopAll(): Promise<void> {
  while (running.length > 0) {
    const handle = running.pop()
    if (handle) await handle.close()
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) removeTempDir(dir)
  }
}

// ── small helpers the tests share ──────────────────────────────────────────────────────────────

/** Creates a database on `node` and optionally runs a schema as one batch. */
export async function createDb(node: Node, name: string, schema?: string): Promise<void> {
  const created = await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
  if (created.status !== 201) throw new Error(`create ${name}: ${await created.text()}`)
  if (!schema) return
  const statements = schema
    .split(";")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0)
    .map((sql) => ({ sql }))
  // Through `query`'s retry, because a replica bootstrapping this database holds the writer for
  // the length of one snapshot and a schema that lands inside that window is told to come back.
  for (const statement of statements) await query(node, name, statement.sql)
}

export interface QueryBody {
  rows: unknown[][]
  columns: string[]
  txid: number
  rowsAffected: number
}

/**
 * One statement, failing loudly. A `503 BUSY` is retried rather than raised: bootstrapping a
 * replica takes a snapshot, and a snapshot holds the writer for the length of one reflink, so a
 * write that lands inside that window is told to come back — which is what this does.
 */
export async function query(
  node: Node,
  db: string,
  sql: string,
  args?: unknown[],
): Promise<QueryBody> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const response = await node.fetch(`/v1/db/${db}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, ...(args ? { args } : {}) }),
    })
    if (response.ok) return (await response.json()) as QueryBody
    const text = await response.text()
    if (response.status === 503 && text.includes('"BUSY"') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      continue
    }
    throw new Error(`${sql}: ${response.status} ${text}`)
  }
}

/**
 * A replica that attaches and then says nothing: it completes the handshake, subscribes to `db`
 * from the primary's current txid, and never sends an `ACK`. It is how a test gets an
 * `ack: "replica"` *timeout* rather than a `NO_REPLICAS` — a replica that has gone away is not
 * attached at all, and the two failures are deliberately different answers.
 */
export async function silentReplica(
  primary: Node,
  db: string,
  node = "silent",
): Promise<{ close(): Promise<void> }> {
  const { FRAME, FrameReader, encodeJson, makeProof, PROTO_VERSION } = await import(
    "../../src/replication/protocol.ts"
  )
  const tenant = primary.handle.registry.open(db)
  const socket = new WebSocket(primary.replicationUrl)
  socket.binaryType = "arraybuffer"
  const reader = new FrameReader()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${node} never subscribed to ${db}`)), 5000)
    socket.addEventListener("message", (event) => {
      for (const frame of reader.push(event.data as ArrayBuffer)) {
        if (frame.type !== FRAME.HELLO) continue
        const body = JSON.parse(new TextDecoder().decode(frame.body)) as Record<string, string>
        if (body.nonce) {
          socket.send(
            encodeJson(FRAME.HELLO, {
              proto: PROTO_VERSION,
              node,
              proof: makeProof(primary.handle.config.replication.secret, body.nonce),
            }),
          )
          continue
        }
        if (body.ok) {
          socket.send(
            encodeJson(FRAME.SUBSCRIBE, {
              stream: 1,
              db,
              fromTxid: tenant.txid.toString(),
              epoch: tenant.epoch,
              checksum: tenant.checksum.toString(),
            }),
          )
          clearTimeout(timer)
          resolve()
        }
      }
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`${node} could not open the replication socket`))
    })
  })
  await until(
    () => (primary.handle.runtime.replication?.replicasOf(db).length ?? 0) > 0,
    `${node} to appear as a replica of ${db}`,
  )
  return {
    close(): Promise<void> {
      socket.close()
      return Promise.resolve()
    },
  }
}

/** Polls `check` until it is true or the deadline passes. No sleeps longer than one poll. */
export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Waits until `node`'s replication client has noticed that its primary is gone.
 *
 * `await primary.close()` resolves once the *primary* has stopped listening, which says nothing
 * about when the *replica's* socket sees the close: that event is delivered to the client
 * asynchronously, and measured on Linux the replica still reports `connected` in every single
 * round at the instant `close()` returns. Normally one HTTP round trip is enough of a yield for it
 * to land; on a loaded machine it is not.
 *
 * A promotion asked for inside that window is correctly refused `STREAM_LIVE` — the replica can
 * still see its primary, and promoting against a live primary is the two-writers case. So a test
 * that promotes has to establish the precondition rather than assume it.
 */
export async function untilPrimaryLost(node: Node, timeoutMs = 10_000): Promise<void> {
  await until(
    () => !(node.handle.runtime.replica?.connected ?? false),
    `${node.handle.config.server.node} to notice its primary is gone`,
    timeoutMs,
  )
}

/** Waits until `node` reports `db` at or past `txid`. */
export async function untilTxid(
  node: Node,
  db: string,
  txid: number,
  timeoutMs = 10_000,
): Promise<void> {
  await until(
    () => {
      const tenant = node.handle.registry.openNames.includes(db)
        ? node.handle.registry.open(db)
        : null
      return tenant !== null && Number(tenant.txid) >= txid
    },
    `${node.handle.config.server.node} to reach ${db}@${txid}`,
    timeoutMs,
  )
}

/**
 * Waits until the replica is connected, has a stream for `db`, and has finished any bootstrap —
 * the point from which every later record is streamed rather than snapshotted.
 */
export async function untilFollowing(node: Node, db: string, timeoutMs = 10_000): Promise<void> {
  await until(
    () => {
      const replica = node.handle.runtime.replica
      if (!replica?.connected) return false
      const stream = replica.status().streams.find((one) => one.db === db)
      return Boolean(stream && !stream.bootstrapping && node.handle.registry.has(db))
    },
    `${node.handle.config.server.node} to follow ${db}`,
    timeoutMs,
  )
}

/** Waits until `replica` has applied everything `primary` has recorded for `db`. */
export async function untilSynced(
  primary: Node,
  replica: Node,
  db: string,
  timeoutMs = 10_000,
): Promise<void> {
  await untilFollowing(replica, db, timeoutMs)
  const at = Number(primary.handle.registry.open(db).txid)
  await untilTxid(replica, db, at, timeoutMs)
}
