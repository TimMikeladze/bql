// One integration test, over real WebSockets on free ports. The simulator is where the coverage
// is; this is here to prove that the pure machine, the log, the transport and the timers actually
// fit together — that a leader is elected over a socket, that a lease commits, and that losing the
// leader elects another.
//
// Ports come from `port: 0`, so this never contends with anything already running.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClusterNode, RAFT_PATH, type RaftUpgradeHost } from "../../src/cluster/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const SECRET = "cluster-secret-for-the-raft-tests"

const dirs: string[] = []
const running: Node[] = []

interface Node {
  id: string
  node: ClusterNode
  url: string
  stop(): Promise<void>
}

/**
 * A listener first, then the `ClusterNode` behind it: the peers table needs URLs and a URL needs a
 * port, so the port has to exist before any node is built.
 */
function listen(id: string): { port: number; attach(node: ClusterNode): void; stop(): void } {
  let attached: ClusterNode | null = null
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, host) {
      if (!attached) return new Response("not started", { status: 503 })
      if (new URL(request.url).pathname !== RAFT_PATH) {
        return new Response("no route", { status: 404 })
      }
      const upgrade = attached.socket?.onUpgrade(request)
      if (!upgrade) return new Response("not started", { status: 503 })
      if (upgrade instanceof Response) return upgrade
      if ((host as unknown as RaftUpgradeHost).upgrade(request, { data: upgrade.data })) {
        return undefined
      }
      return new Response("expected a WebSocket upgrade", { status: 426 })
    },
    websocket: {
      open: (ws) => attached?.socket?.onOpen(ws as never),
      message: (ws, message) => attached?.socket?.onMessage(ws as never, message as never),
      close: (ws) => attached?.socket?.onClose(ws as never),
    },
  })
  return {
    port: server.port as number,
    attach: (node) => {
      attached = node
    },
    stop: () => {
      void server.stop(true)
    },
  }
}

async function startCluster(
  ids: string[],
  options: { bootstrap?: boolean } = {},
): Promise<Node[]> {
  const listeners = ids.map((id) => ({ id, listener: listen(id) }))
  const urls: Record<string, string> = {}
  for (const { id, listener } of listeners) {
    urls[id] = `ws://127.0.0.1:${listener.port}${RAFT_PATH}`
  }

  const nodes: Node[] = []
  for (const { id, listener } of listeners) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bunql-cluster-${id}-`))
    dirs.push(dir)
    const peers = Object.fromEntries(Object.entries(urls).filter(([peer]) => peer !== id))
    const node = new ClusterNode({
      id,
      dir,
      advertise: urls[id] as string,
      peers,
      secret: SECRET,
      electionTimeoutMs: 300,
      heartbeatMs: 60,
      leaseTtlMs: 1000,
      leaseRenewMs: 250,
      leaseGuardMs: 200,
      proposeTimeoutMs: 5000,
      ...(options.bootstrap === false ? { bootstrap: false } : {}),
      onError: process.env.BUNQL_TEST_CLUSTER_LOG ? (err) => console.error(id, err) : () => {},
    })
    await node.start()
    listener.attach(node)
    const entry: Node = {
      id,
      node,
      url: urls[id] as string,
      stop: async () => {
        await node.close()
        listener.stop()
      },
    }
    nodes.push(entry)
    running.push(entry)
  }
  return nodes
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms`)
}

afterAll(async () => {
  for (const node of running) await node.stop().catch(() => {})
  for (const dir of dirs) removeTempDir(dir)
})

describe("three nodes over real sockets", () => {
  test("elect a leader, commit a lease, lose the leader, elect another", async () => {
    const nodes = await startCluster(["n1", "n2", "n3"])

    await waitFor("a leader", () => nodes.some((node) => node.node.isLeader()))
    const first = nodes.find((node) => node.node.isLeader()) as Node
    const term = first.node.term

    // Every node agrees who leads, and the peers are visibly reachable.
    await waitFor(
      "the followers to agree on the leader",
      () => nodes.every((node) => node.node.leaderId === first.id),
    )
    await waitFor(
      "the membership table to fill in",
      () => Object.keys(first.node.state.nodes).length === 3,
    )
    const view = first.node.observe()
    expect(view.role).toBe("leader")
    expect(view.voters.sort()).toEqual(["n1", "n2", "n3"])
    expect(view.nodes.filter((entry) => entry.reachable)).toHaveLength(3)

    // A placement and a lease, both through Raft.
    expect(await first.node.propose({ type: "placeDb", db: "acme", primary: first.id, replicas: [] }))
      .toEqual({ ok: true })
    const granted = await first.node.propose({
      type: "grantLease",
      db: "acme",
      node: first.id,
      until: Date.now() + 1000,
    })
    expect(granted).toEqual({ ok: true })

    // The holder's own view of the lease is a local deadline on a local clock.
    const held = first.node.leaseFor("acme")
    expect(held?.node).toBe(first.id)
    // No bump: `placeDb` already named this node the primary, so the grant fenced nobody (C2).
    expect(held?.epoch).toBe(0)
    expect(held?.validUntilLocalMs).toBeGreaterThan(performance.now())
    // And it is the same object every time: the data path allocates nothing to read it.
    expect(first.node.leaseFor("acme")).toBe(held)

    await waitFor(
      "the lease to reach the followers",
      () => nodes.every((node) => node.node.leaseFor("acme")?.node === first.id),
    )
    for (const node of nodes) {
      if (node.id === first.id) continue
      // A lease held elsewhere is never valid here, whatever the clocks say.
      expect(node.node.leaseFor("acme")?.validUntilLocalMs).toBe(0)
    }

    // A follower's proposal reaches the leader over the raft socket it already holds (C2). Only
    // the leader may append, so this is a forward and not a local append — the C1 behaviour it
    // replaces was to refuse with "not the leader", which made every caller in the server learn to
    // find the leader for itself.
    const follower = nodes.find((node) => node.id !== first.id) as Node
    expect(await follower.node.propose({ type: "releaseLease", db: "acme" })).toEqual({ ok: true })
    await waitFor(
      "the release to reach every node",
      () => nodes.every((node) => node.node.leaseFor("acme") === null),
    )
    // And it is still refused when there is no leader to forward to.
    const orphan = await startCluster(["solo"], { bootstrap: false })
    expect((await orphan[0]?.node.propose({ type: "releaseLease", db: "acme" }))?.ok).toBe(false)
    for (const node of orphan) await node.stop()

    // Put the lease back, so the rest of the test still has one to watch move.
    expect(
      await first.node.propose({
        type: "grantLease",
        db: "acme",
        node: first.id,
        until: Date.now() + 1000,
      }),
    ).toEqual({ ok: true })
    await waitFor(
      "the lease to reach the followers again",
      () => nodes.every((node) => node.node.leaseFor("acme")?.node === first.id),
    )

    // Kill the leader.
    await first.stop()
    const survivors = nodes.filter((node) => node.id !== first.id)
    await waitFor("a new leader", () => survivors.some((node) => node.node.isLeader()))
    const second = survivors.find((node) => node.node.isLeader()) as Node
    expect(second.node.term).toBeGreaterThan(term)

    // The committed lease survived the failover: same holder, same epoch. Handing it to someone
    // else is C2's job, and it may not happen before the old lease has lapsed.
    const survived = second.node.observe().dbs.find((entry) => entry.db === "acme")
    expect(survived?.primary).toBe(first.id)
    expect(survived?.epoch).toBe(0)

    // And the new leader can commit.
    const released = await second.node.propose({ type: "releaseLease", db: "acme" })
    expect(released).toEqual({ ok: true })
    expect(second.node.leaseFor("acme")).toBeNull()
  }, 40_000)
})
