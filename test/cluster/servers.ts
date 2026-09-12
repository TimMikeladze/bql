// A real BunQL cluster in this process: N whole servers, each with `[cluster] enabled`, each on a
// free port, all sharing one secret.
//
// A cluster node has to know its own `advertise` address before it starts — the Raft socket is
// mounted on the same listener the HTTP API is — so a port is reserved first and handed to
// `startServer` rather than letting it pick one. Reserving means binding a throwaway listener on
// port 0, reading the port and stopping it: the window in which the port is free is the same
// window every "find a free port" helper has, and nothing else in the test process is binding.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, type ServerHandle } from "../../src/server/app.ts"
import { loadConfig, type ServerConfigInput } from "../../src/server/config.ts"

const dirs: string[] = []
const running: ServerHandle[] = []

export const CLUSTER_SECRET = "test-cluster-secret-0123456789"

/**
 * One admin key for the whole cluster. Nodes in a real cluster share their key material through
 * configuration; letting each node generate its own would make a client redirected from one to
 * another answer `401`, which is a property of the test setup and not of the redirect.
 */
export const ADMIN_KEY = "test-cluster-admin-key-0123456789"

export interface ClusterServer {
  id: string
  handle: ServerHandle
  url: string
  port: number
  dir: string
  adminKey: string
  advertise: string
  replicationUrl: string
  fetch(route: string, init?: RequestInit & { token?: string | null }): Promise<Response>
  json<T = unknown>(route: string, init?: RequestInit & { token?: string | null }): Promise<T>
  close(): Promise<void>
}

/** A port nothing is listening on, by binding one and letting it go. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = server.port as number
  await server.stop(true)
  return port
}

export function tempDir(prefix = "bunql-c2-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export interface StartClusterOptions {
  ids?: string[]
  /** Extra overrides merged into every node's configuration. */
  overrides?: ServerConfigInput
  /**
   * Every node but the first follows the first over `/v1/replication`. C2 has no placement — that
   * is C3 — so this is how a database gets a copy on more than one node, and therefore how a
   * failover has a candidate to pick.
   */
  followFirst?: boolean
}

/**
 * `count` servers that form one Raft group. Every node lists every other as a peer and bootstraps,
 * which is what `[cluster] bootstrap` means: form a group from `peers` rather than wait to join.
 */
export async function startCluster(
  count: number,
  options: StartClusterOptions = {},
): Promise<ClusterServer[]> {
  const ids = options.ids ?? Array.from({ length: count }, (_, n) => `n${n + 1}`)
  const ports: Record<string, number> = {}
  for (const id of ids) ports[id] = await freePort()
  const advertise = Object.fromEntries(
    ids.map((id) => [id, `ws://127.0.0.1:${ports[id] as number}`]),
  )

  const first = ids[0] as string
  const servers: ClusterServer[] = []
  for (const id of ids) {
    const dir = tempDir(`bunql-${id}-`)
    const peers = ids.filter((peer) => peer !== id).map((peer) => `${peer}=${advertise[peer]}`)
    const replicaOf =
      options.followFirst && id !== first
        ? `ws://127.0.0.1:${ports[first] as number}/v1/replication`
        : undefined
    const config = loadConfig({
      env: {},
      overrides: {
        ...options.overrides,
        server: {
          port: ports[id] as number,
          host: "127.0.0.1",
          node: id,
          ...options.overrides?.server,
        },
        data: { dir, ...options.overrides?.data },
        auth: { adminKey: ADMIN_KEY, ...options.overrides?.auth },
        limits: { txIdleTimeoutMs: 1000, txWaitMs: 500, ...options.overrides?.limits },
        replication: {
          secret: CLUSTER_SECRET,
          heartbeatMs: 100,
          reconnectMs: 20,
          ...(replicaOf ? { primary: replicaOf } : {}),
          ...options.overrides?.replication,
        },
        cluster: {
          enabled: true,
          id,
          advertise: advertise[id] as string,
          peers,
          bootstrap: true,
          // Short enough that a failover happens inside a test's patience, long enough that the
          // guard is still a real fraction of the lease and an election is not triggered by this
          // process serving three HTTP servers on one event loop.
          leaseTtlMs: 1200,
          leaseRenewMs: 300,
          leaseGuardMs: 400,
          electionTimeoutMs: 700,
          heartbeatMs: 120,
          ...options.overrides?.cluster,
        },
      },
    })
    const handle = await startServer(config, {
      log: () => {},
      onError: process.env.BUNQL_TEST_CLUSTER_LOG
        ? (err) => console.error(`[${id}]`, err)
        : () => {},
    })
    running.push(handle)
    const adminKey = handle.adminKey as string
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
    servers.push({
      id,
      handle,
      url: base,
      port: handle.server.port as number,
      dir,
      adminKey,
      advertise: advertise[id] as string,
      replicationUrl: `ws://127.0.0.1:${handle.server.port}/v1/replication`,
      fetch: call,
      async json<T>(route: string, init?: RequestInit & { token?: string | null }): Promise<T> {
        const response = await call(route, init)
        return (await response.json()) as T
      },
      async close(): Promise<void> {
        const at = running.indexOf(handle)
        if (at >= 0) running.splice(at, 1)
        await handle.close()
      },
    })
  }
  return servers
}

export async function stopAll(): Promise<void> {
  while (running.length > 0) {
    const handle = running.pop()
    if (handle) await handle.close()
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Polls until `check` is true, or throws naming what it was waiting for. */
export async function waitFor(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The node that currently leads the Raft group, or undefined. */
export function leaderOf(servers: ClusterServer[]): ClusterServer | undefined {
  return servers.find((server) => server.handle.runtime.cluster?.isLeader())
}
