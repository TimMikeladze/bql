// A real cluster losing its primary, on real sockets and free ports.
//
// The things this exists to catch are the ones a unit test cannot: that a lease actually lapses
// when its holder dies (it is the *holder* that renews it, not the leader — a leader renewing on a
// dead node's behalf would keep a dead primary's database for ever and nothing would ever fail
// over), that the replica with the best copy takes it, and that a client following `BQL-Primary`
// reaches the node that took it.
//
// A database gets its second copy the phase-1 way, with the other nodes following the owner over
// `/v1/replication` while sharing its Raft group — C3's placement decides *where* a database is
// created, not who streams it, which is C3b.
//
// The name is chosen by `nameOn` rather than written as `db`, because C3's create gate means
// only the node the placement function names may create it, and these tests need the database on
// the node the others follow. The subject here is the failover, not the name.

import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "../../src/client/index.ts"
import { type ClusterServer, nameOn, startCluster, stopAll, untilMembership, waitFor } from "./servers.ts"

afterEach(async () => {
  await stopAll()
})

async function createDb(node: ClusterServer, name: string, schema?: string): Promise<void> {
  const created = await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
  if (created.status !== 201) throw new Error(`create ${name}: ${await created.text()}`)
  if (!schema) return
  const response = await node.fetch(`/v1/db/${name}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: schema }),
  })
  if (!response.ok) throw new Error(`schema for ${name}: ${await response.text()}`)
}

interface QueryBody {
  rows: unknown[][]
  txid: number
}

async function query(node: ClusterServer, db: string, sql: string): Promise<QueryBody> {
  const response = await node.fetch(`/v1/db/${db}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  })
  if (!response.ok) {
    throw new Error(`${sql} on ${node.id}: ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as QueryBody
}

function dbView(node: ClusterServer, db: string) {
  return node.handle.runtime.cluster?.observeDbs().find((one) => one.db === db)
}

/** Waits until every node's control plane agrees on one lease holder for `db`, and returns it. */
async function holderOf(servers: ClusterServer[], db: string): Promise<string> {
  let holder = ""
  await waitFor(`a lease holder for ${db}`, () => {
    const seen = new Set<string>()
    for (const server of servers) {
      const lease = dbView(server, db)?.lease
      if (!lease) return false
      seen.add(lease.node)
    }
    if (seen.size !== 1) return false
    holder = [...seen][0] as string
    return true
  })
  return holder
}

describe("a cluster", () => {
  test(
    "places a database on the node that created it, and only that node holds the lease",
    async () => {
      const servers = await startCluster(3)
      await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
      await untilMembership(servers)

      const owner = servers[0] as ClusterServer
      const db = nameOn(servers, owner.id)
      await createDb(owner, db, "create table t (v text)")
      expect(await holderOf(servers, db)).toBe(owner.id)

      await query(owner, db, "insert into t (v) values ('one')")

      const view = (await owner.json("/v1/cluster")) as {
        dbs: { db: string; leaseHeldHere: boolean; primary: string | null; generation: string | null }[]
      }
      const entry = view.dbs.find((one) => one.db === db)
      expect(entry?.primary).toBe(owner.id)
      expect(entry?.leaseHeldHere).toBe(true)
      // The primary states the database's identity, so a promotion can be refused against it.
      expect(entry?.generation).toMatch(/^[0-9a-f]{16}$/)
      for (const other of servers.slice(1)) {
        expect(other.handle.runtime.cluster?.holdsLease(db)).toBe(false)
      }
    },
    20_000,
  )

  test(
    "loses its primary, a replica takes over, and a client follows BQL-Primary to it",
    async () => {
      const servers = await startCluster(3, { followFirst: true })
      await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
      await untilMembership(servers)

      const owner = servers[0] as ClusterServer
      const followers = servers.slice(1)
      const db = nameOn(servers, owner.id)
      await createDb(owner, db, "create table t (v text)")
      await query(owner, db, "insert into t (v) values ('before')")
      expect(await holderOf(servers, db)).toBe(owner.id)

      // The followers bootstrap the database and register themselves in its placement.
      await waitFor("both followers to hold a copy", () =>
        followers.every((node) => node.handle.runtime.registry.has(db)),
      )
      await waitFor("the placement to name both followers", () => {
        const entry = dbView(owner, db)
        return followers.every((node) => entry?.replicas.includes(node.id) ?? false)
      })
      // …and to report how far they have applied, which is what the failover picks on.
      await waitFor("both followers to ack", () => {
        const acked = dbView(owner, db)?.acked ?? {}
        return followers.every((node) => Number(acked[node.id] ?? "0") > 0)
      })

      // Kill the holder. Nothing renews its lease now, because the holder is what renews it.
      await owner.close()

      await waitFor(
        "the lease to lapse and move to a survivor",
        () => {
          const leader = followers.find((s) => s.handle.runtime.cluster?.isLeader())
          if (!leader) return false
          const lease = dbView(leader, db)?.lease
          return lease !== null && lease !== undefined && lease.node !== owner.id
        },
        15_000,
      )

      const leader = followers.find((s) => s.handle.runtime.cluster?.isLeader()) as ClusterServer
      const entry = dbView(leader, db)
      const winner = followers.find((s) => s.id === entry?.lease?.node) as ClusterServer
      expect(winner).toBeDefined()
      // The epoch moved: the lease changed hands, and that is the fencing token the old primary no
      // longer holds.
      expect(entry?.epoch).toBeGreaterThan(0)

      // The winner promoted itself for real: its live role, its lease, and a write that lands.
      await waitFor("the winner to promote itself", () => winner.handle.runtime.roleFor(db) === "primary")
      expect(winner.handle.runtime.cluster?.holdsLease(db)).toBe(true)
      expect(winner.handle.runtime.replica?.detached).toContain(db)
      const written = await query(winner, db, "insert into t (v) values ('after')")
      expect(written.txid).toBeGreaterThan(1)
      expect((await query(winner, db, "select v from t order by rowid")).rows).toEqual([
        ["before"],
        ["after"],
      ])

      // The other survivor is not a primary for it, says where it went, and its SDK gets there.
      const bystander = followers.find((s) => s.id !== winner.id) as ClusterServer
      await waitFor(
        `the bystander to learn where ${db} went`,
        () => bystander.handle.runtime.primaryUrlFor(db) === winner.url,
      )
      const refused = await bystander.fetch(`/v1/db/${db}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: "insert into t (v) values ('nope')" }),
      })
      expect(refused.status).toBe(503)
      expect(refused.headers.get("BQL-Primary")).toBe(winner.url)
      expect((await refused.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "NOT_PRIMARY" },
      })

      // The SDK's one transparent replay, against the node the header names.
      const client = createClient({ url: bystander.url, token: bystander.adminKey, db: db })
      try {
        const rows = await client.db().unsafe("insert into t (v) values ('via sdk') returning v")
        expect(rows.length).toBe(1)
      } finally {
        client.close()
      }
      expect((await query(winner, db, "select count(*) as n from t")).rows).toEqual([[3]])
    },
    30_000,
  )

  test(
    "a node's lease is valid for less than the lease it was granted, by the guard",
    async () => {
      const servers = await startCluster(1, {
        overrides: { cluster: { leaseTtlMs: 600, leaseGuardMs: 250, leaseRenewMs: 150 } },
      })
      await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
      await untilMembership(servers)
      const owner = servers[0] as ClusterServer
      const db = nameOn(servers, owner.id)
      await createDb(owner, db, "create table t (v text)")
      await holderOf(servers, db)

      const cluster = owner.handle.runtime.cluster as NonNullable<typeof owner.handle.runtime.cluster>
      const handle = cluster.leaseFor(db)
      expect(handle?.node).toBe(owner.id)
      // The holder's deadline is on its own monotonic clock and is strictly inside the lease:
      // `ttl - guard` from the moment it asked. That difference is the margin that makes two
      // primaries impossible.
      const remaining = (handle?.validUntilLocalMs ?? 0) - performance.now()
      expect(remaining).toBeGreaterThan(0)
      expect(remaining).toBeLessThanOrEqual(600 - 250)
      expect(cluster.holdsLease(db)).toBe(true)
      // And the same object is handed back every time: the write path allocates nothing to read it.
      expect(cluster.leaseFor(db)).toBe(handle)
    },
    20_000,
  )

  test(
    "a replica holding a different generation is refused promotion",
    async () => {
      const servers = await startCluster(2, { followFirst: true })
      await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
      await untilMembership(servers)
      const owner = servers[0] as ClusterServer
      const follower = servers[1] as ClusterServer
      const db = nameOn(servers, owner.id)

      await createDb(owner, db, "create table t (v text)")
      await query(owner, db, "insert into t (v) values ('one')")
      await waitFor("the follower to hold a copy", () => follower.handle.runtime.registry.has(db))
      await holderOf(servers, db)

      // The cluster now records a generation for the database. Pretend the follower's copy is an older
      // one of the same name — which is exactly what a delete and a re-create leaves behind on a
      // replica that was disconnected across both (`docs/r7-unfollow.md`).
      const decision = (
        await import("../../src/cluster/promotion.ts")
      ).decidePromotion({
        db: db,
        node: follower.id,
        hasCopy: true,
        isPrimaryLocally: false,
        localGeneration: "0123456789abcdef",
        placedGeneration: dbView(owner, db)?.generation ?? null,
        applied: "2",
        localEpoch: 0,
        streamLive: true,
        cluster: {
          epoch: 0,
          primary: owner.id,
          replicas: [follower.id],
          lease: null,
          acked: {},
          nowMs: Date.now(),
        },
        force: true,
      })
      expect(decision).toMatchObject({ ok: false, code: "GENERATION_MISMATCH" })

      // And end to end: the follower's real copy has the *right* generation, so what stops it is
      // the live lease, not the identity.
      const refused = await follower.fetch(`/v1/db/${db}/promote`, {
        method: "POST",
        body: JSON.stringify({}),
      })
      expect(refused.status).toBe(503)
      expect((await refused.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "LEASE_HELD" },
      })
      expect(follower.handle.runtime.roleFor(db)).toBe("replica")
    },
    20_000,
  )
})
