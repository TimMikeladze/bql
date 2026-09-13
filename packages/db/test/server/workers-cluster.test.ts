// A real clustered node that shards its databases across worker threads
// (`docs/c4d-cluster-workers.md`), and the two decisions that seam owns, tested directly.
//
// The integration cases prove the thing that used to be refused: `[cluster] enabled` beside
// `[server] workers > 1`. The unit cases exist because the two decisions underneath — that a lease
// deadline is converted rather than re-stamped, and that `setOwned` is a union rather than a
// replace — fail *intermittently* through an HTTP surface. A three-second integration test happens
// to pass with a replacing `setOwned`, because each shard takes its turn inside a renewal window
// wide enough to forgive it; a test that can be passed by a broken implementation is not a test of
// it. So those two are asserted where they are decided.

import { afterEach, describe, expect, test } from "bun:test"
import type { ClusterLink, ClusterState, ClusterViewDb, LeaseHandle } from "../../src/cluster/index.ts"
import { ClusterShards, HostedCluster } from "../../src/server/workers/cluster.ts"
import type { ClusterViewPush, FromWorker } from "../../src/server/workers/protocol.ts"
import type { WorkerPool } from "../../src/server/workers/pool.ts"
import { shardOf } from "../../src/server/workers/shard.ts"
import { startCluster, stopAll, waitFor, type ClusterServer } from "../cluster/servers.ts"

const WORKERS = 3

/** Three names on three different workers, so every case below crosses a shard boundary. */
const NAMES: string[] = []
for (let i = 0; NAMES.length < WORKERS && i < 500; i++) {
  const name = `acme${i}`
  if (!NAMES.some((one) => shardOf(one, WORKERS) === shardOf(name, WORKERS))) NAMES.push(name)
}

afterEach(stopAll)

describe("[cluster] with workers > 1", () => {
  test("starts, and writes to databases on every shard", async () => {
    const [node] = await startCluster(1, { overrides: { server: { workers: WORKERS } } })
    if (!node) throw new Error("no node")
    expect(node.handle.workers).toBe(WORKERS)
    await waitFor("a raft leader", () => node.handle.runtime.cluster?.isLeader() === true)

    for (const name of NAMES) {
      // `POST /v1/db` awaits `ensureLease`, which on a sharded node is a claim and a promotion
      // that both cross the channel. A 201 that returned before the lease was held would be
      // followed by a 503 on the very next statement, which is what the write below checks.
      const created = await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
      expect(created.status).toBe(201)
      const schema = await node.fetch(`/v1/db/${name}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: "create table t (a integer)" }),
      })
      expect(schema.status).toBe(200)
      const wrote = await node.fetch(`/v1/db/${name}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: "insert into t values (1)" }),
      })
      expect(wrote.status).toBe(200)
    }

    // Every shard's databases are in one view, answered by the router — the thread that holds the
    // raft log — rather than gathered from the workers.
    const view = await node.json<{ dbs: { db: string; leaseHeldHere: boolean }[] }>("/v1/cluster")
    for (const name of NAMES) {
      const entry = view.dbs.find((one) => one.db === name)
      expect(entry).toBeDefined()
      expect(entry?.leaseHeldHere).toBe(true)
    }
  }, 30_000)

  test("keeps writing on every shard across several lease lifetimes", async () => {
    // The harness leases for 1200 ms. Two and a half of those is long enough that nothing here
    // passes on the lease it was granted at startup: every write below is on a renewed one.
    const [node] = await startCluster(1, { overrides: { server: { workers: WORKERS } } })
    if (!node) throw new Error("no node")
    await waitFor("a raft leader", () => node.handle.runtime.cluster?.isLeader() === true)
    for (const name of NAMES) {
      await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
      await node.fetch(`/v1/db/${name}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: "create table t (a integer)" }),
      })
    }
    for (let round = 0; round < 3; round++) {
      if (round > 0) await new Promise((resolve) => setTimeout(resolve, 1500))
      for (const name of NAMES) {
        const wrote = await node.fetch(`/v1/db/${name}/query`, {
          method: "POST",
          body: JSON.stringify({ sql: "insert into t values (1)" }),
        })
        expect(`${name} round ${round}: ${wrote.status}`).toBe(`${name} round ${round}: 200`)
      }
    }
  }, 30_000)

  test("promotes through a route hopped to the worker that owns the database", async () => {
    const [node] = await startCluster(1, { overrides: { server: { workers: WORKERS } } })
    if (!node) throw new Error("no node")
    await waitFor("a raft leader", () => node.handle.runtime.cluster?.isLeader() === true)
    const name = NAMES[1] as string
    await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
    // Already this node's primary, so the decision is `ALREADY_PRIMARY` — which is the point: the
    // request was built from tenant facts on the worker, decided on the raft leader on the router,
    // and the answer came back across the channel rather than timing out.
    const response = await node.fetch(`/v1/db/${name}/promote`, { method: "POST", body: "{}" })
    const body = (await response.json()) as {
      promoted?: boolean
      error?: { code?: string; message?: string }
    }
    expect(body.promoted === true || body.error?.code === "ALREADY_PRIMARY").toBe(true)
    // Whichever it was, it is an answer and not a timeout: a promotion request that never reached
    // the raft leader across the channel would spend `proposeTimeoutMs` and come back NO_LEADER.
    expect(body.error?.code).not.toBe("NO_LEADER")
  }, 30_000)
  test("loses a sharded primary, and a sharded replica is promoted on the worker that owns it", async () => {
    // The end of the whole milestone: three clustered nodes, every one of them sharding its
    // databases across three worker threads, and a failover between them. The lease lapses on the
    // router of the dead node, the raft leader grants it elsewhere, and the promotion happens on
    // the *worker* that owns `acme` there — `#flip` evicts, detaches the stream, rewrites the
    // catalog row and reopens, all on the thread that holds the tenant.
    const servers = await startCluster(3, {
      followFirst: true,
      overrides: { server: { workers: WORKERS } },
    })
    const dbView = (node: ClusterServer, db: string) =>
      node.handle.runtime.cluster?.observeDbs().find((one) => one.db === db)
    await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
    const owner = servers[0] as ClusterServer
    const followers = servers.slice(1)

    await owner.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
    await owner.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (v text)" }),
    })
    await owner.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t values ('before')" }),
    })

    await waitFor("both followers to hold a copy", () =>
      followers.every((node) => node.handle.runtime.registry.has("acme")),
    )
    await waitFor("the placement to name both followers", () => {
      const entry = dbView(owner, "acme")
      return followers.every((node) => entry?.replicas.includes(node.id) ?? false)
    })
    await waitFor("both followers to ack", () => {
      const acked = dbView(owner, "acme")?.acked ?? {}
      return followers.every((node) => Number(acked[node.id] ?? "0") > 0)
    })

    // Nothing renews the lease now: the holder is what renews it, and the holder is gone.
    await owner.close()
    await waitFor(
      "the lease to lapse and move to a survivor",
      () => {
        const leader = followers.find((s) => s.handle.runtime.cluster?.isLeader())
        if (!leader) return false
        const lease = dbView(leader, "acme")?.lease
        return lease !== null && lease !== undefined && lease.node !== owner.id
      },
      15_000,
    )
    const leader = followers.find((s) => s.handle.runtime.cluster?.isLeader()) as ClusterServer
    const entry = dbView(leader, "acme")
    const winner = followers.find((s) => s.id === entry?.lease?.node) as ClusterServer
    expect(winner).toBeDefined()
    // The lease changed hands, so the fencing token the old primary held is behind the cluster's.
    expect(entry?.epoch).toBeGreaterThan(0)

    // The router's own view of the role moved too, which is the `role` envelope: the flip happened
    // on a worker, and a catalog row another thread rewrote fires no `onChange` here.
    await waitFor("the winner to promote itself", () => winner.handle.runtime.roleFor("acme") === "primary")
    expect(winner.handle.runtime.cluster?.holdsLease("acme")).toBe(true)

    const wrote = await winner.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t values ('after')" }),
    })
    expect(wrote.status).toBe(200)
    const read = await winner.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select v from t order by rowid" }),
    })
    expect(((await read.json()) as { rows: unknown[][] }).rows).toEqual([["before"], ["after"]])
  }, 60_000)
})

// ── the two decisions, where they are decided ───────────────────────────────────────────────────

/** A `ClusterLink` that records what it was told, for the router-side half. */
function fakeCluster(): ClusterLink & { owned: string[]; leases: Map<string, number> } {
  const leases = new Map<string, number>()
  const link = {
    id: "n1",
    proposeTimeoutMs: 1000,
    owned: [] as string[],
    leases,
    holdsLease: () => true,
    leaseFor: (db: string): LeaseHandle | null => {
      const until = leases.get(db)
      return until === undefined ? null : { node: "n1", epoch: 1, validUntilLocalMs: until }
    },
    knows: () => true,
    epochOf: () => 1,
    primaryOf: () => "n1",
    advertiseOf: () => "ws://127.0.0.1:1",
    isLeader: () => true,
    state: { nodes: {}, dbs: {}, term: 0 } as ClusterState,
    observeDbs: (): ClusterViewDb[] =>
      [...leases.keys()].map((db) => ({
        db,
        primary: "n1",
        replicas: [],
        epoch: 1,
        lease: { node: "n1", until: 0 },
        acked: {},
        generation: null,
      })),
    observe: () => null,
    socket: null,
    propose: async () => ({ ok: true }),
    promote: async () => ({ ok: true, epoch: 1, why: "" }) as never,
    setOwned: (dbs: Iterable<string>) => {
      link.owned = [...dbs]
    },
    onChange: () => () => {},
    start: async () => {},
    close: async () => {},
  }
  return link
}

/** A pool that only has to shard a name and collect what was posted to each worker. */
function fakePool(size: number): WorkerPool & { views: ClusterViewPush[] } {
  const views: ClusterViewPush[] = []
  return {
    size,
    views,
    shardOf: (name: string) => shardOf(name, size),
    clusterView: (_index: number, push: ClusterViewPush) => views.push(push),
    clusterProbe: () => {},
    clusterOffset: () => {},
    clusterProposed: () => {},
    clusterPromoted: () => {},
  } as unknown as WorkerPool & { views: ClusterViewPush[] }
}

describe("the owned set is a union of the shards", () => {
  test("a second shard's primaries are added, never substituted", () => {
    const cluster = fakeCluster()
    const shards = new ClusterShards(fakePool(WORKERS), cluster, () => {})
    shards.owned(0, ["alpha"])
    expect(cluster.owned).toEqual(["alpha"])
    shards.owned(1, ["beta"])
    // The failure this catches: `setOwned(dbs)` instead of the union, which drops `alpha` from the
    // node's owned set — so `#renewOwn` stops renewing it and it fails over for nothing.
    expect([...cluster.owned].sort()).toEqual(["alpha", "beta"])
    shards.owned(2, ["gamma"])
    expect([...cluster.owned].sort()).toEqual(["alpha", "beta", "gamma"])
    // A shard that has let a database go replaces only its own entry.
    shards.owned(1, [])
    expect([...cluster.owned].sort()).toEqual(["alpha", "gamma"])
  })

  test("each shard is pushed only its own databases, with only its own deadlines", () => {
    const cluster = fakeCluster()
    const pool = fakePool(WORKERS)
    for (const name of NAMES) cluster.leases.set(name, 1000 + shardOf(name, WORKERS))
    const shards = new ClusterShards(pool, cluster, () => {})
    shards.push()
    expect(pool.views.length).toBe(WORKERS)
    for (const name of NAMES) {
      const mine = pool.views[shardOf(name, WORKERS)] as ClusterViewPush
      expect(mine.dbs.map((one) => one.db)).toEqual([name])
      expect(mine.hold).toEqual([[name, 1000 + shardOf(name, WORKERS)]])
    }
  })
})

describe("a lease deadline converted onto the worker's clock", () => {
  /** A `HostedCluster` with a clock this test drives, and the messages it posted. */
  function hosted(): { cluster: HostedCluster; sent: FromWorker[]; now: (at: number) => void } {
    const sent: FromWorker[] = []
    let clock = 0
    const cluster = new HostedCluster(
      (message) => sent.push(message),
      () => clock,
    )
    return {
      cluster,
      sent,
      now: (at: number) => {
        clock = at
      },
    }
  }

  function push(hold: [string, number][]): ClusterViewPush {
    return {
      kind: "cluster.view",
      id: "n1",
      leader: "n1",
      nodes: [],
      proposeTimeoutMs: 1000,
      dbs: hold.map(([db]) => ({
        db,
        primary: "n1",
        replicas: [],
        epoch: 1,
        lease: { node: "n1", until: 0 },
        acked: {},
        generation: null,
      })),
      hold,
    }
  }

  test("the router's instant becomes this thread's instant, and expires on this thread's clock", () => {
    const { cluster, now } = hosted()
    // This thread reads 50 ms *behind* the router, so a deadline the router stamped at 1000 is
    // 950 here — and a worker that ignored the offset would hold the lease 50 ms too long.
    cluster.offset(-50)
    cluster.view(push([["alpha", 1000]]))
    now(940)
    expect(cluster.holdsLease("alpha")).toBe(true)
    now(950)
    expect(cluster.holdsLease("alpha")).toBe(false)
    expect(cluster.leaseFor("alpha")?.validUntilLocalMs).toBe(950)
  })

  test("a delayed view does not extend the lease", () => {
    // The whole reason a deadline crosses as an instant rather than as a remaining duration: a
    // `cluster.view` that sat in a busy worker's queue converts to a deadline that much closer,
    // not to a fresh full lease.
    const { cluster, now } = hosted()
    cluster.offset(0)
    now(900)
    cluster.view(push([["alpha", 1000]]))
    now(1001)
    expect(cluster.holdsLease("alpha")).toBe(false)
  })

  test("the bound is only ever tightened, and a lease with no deadline is not held", () => {
    const { cluster, now } = hosted()
    cluster.offset(-80)
    cluster.offset(-50)
    // A looser sample never loosens what was measured: the offset does not drift, and rounding it
    // down can only shorten a lease.
    cluster.offset(-200)
    cluster.view(push([["alpha", 1000]]))
    now(949)
    expect(cluster.holdsLease("alpha")).toBe(true)
    // A database the router did not name in `hold` is one this node does not hold the lease on.
    cluster.view(push([]))
    expect(cluster.holdsLease("alpha")).toBe(false)
  })

  test("a view that arrives before the first probe waits rather than converting against a guess", () => {
    const { cluster, now } = hosted()
    cluster.view(push([["alpha", 1000]]))
    now(0)
    expect(cluster.holdsLease("alpha")).toBe(false)
    cluster.offset(-50)
    expect(cluster.holdsLease("alpha")).toBe(true)
    now(950)
    expect(cluster.holdsLease("alpha")).toBe(false)
  })

  test("a probe carries the router's stamp back untouched beside this thread's own", () => {
    const { cluster, sent, now } = hosted()
    now(7)
    cluster.probed(3, 12345)
    expect(sent).toEqual([{ kind: "cluster.probe.reply", id: 3, t1: 12345, t2: 7 }])
  })
})
