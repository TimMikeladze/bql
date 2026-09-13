// Placement deciding which node subscribes to which (C3b, `docs/c3-placement.md` §3.4).
//
// Nothing here is configured with `[replication] primary`. The whole point is that a node works
// out its upstreams from the cluster's placement, and that a node in the replica set of databases
// whose primaries are **different nodes** holds a connection to each.

import { afterEach, describe, expect, test } from "bun:test"
import { homeOf, type PlacementNode } from "../../src/cluster/index.ts"
import { startCluster, stopAll, untilMembership, waitFor, type ClusterServer } from "./servers.ts"

afterEach(stopAll)

function membersOf(servers: ClusterServer[]): PlacementNode[] {
  const state = servers[0]?.handle.runtime.cluster?.state
  return Object.entries(state?.nodes ?? {}).map(([id, info]) => ({ id, zone: info.zone }))
}

/** One database name placed on each node, so every node is a primary for one. */
function oneEach(servers: ClusterServer[]): string[] {
  const members = membersOf(servers)
  const names: string[] = []
  for (const node of servers) {
    for (let i = 0; i < 5000; i++) {
      const name = `db${i}`
      if (homeOf(name, members) === node.id && !names.includes(name)) {
        names.push(name)
        break
      }
    }
  }
  return names
}

async function seed(servers: ClusterServer[], names: string[]): Promise<void> {
  for (let i = 0; i < names.length; i++) {
    const owner = servers[i] as ClusterServer
    const name = names[i] as string
    const created = await owner.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
    expect(`${name}: ${created.status}`).toBe(`${name}: 201`)
    await owner.fetch(`/v1/db/${name}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (v text)" }),
    })
    await owner.fetch(`/v1/db/${name}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t values ('one')" }),
    })
  }
}

describe("placement decides who follows whom", () => {
  test("every database reaches its rf-1 replicas with nothing configured to follow", async () => {
    const servers = await startCluster(3, { overrides: { cluster: { rf: 2 } } })
    await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
    await untilMembership(servers)
    for (const node of servers) expect(node.handle.config.replication.primary).toBe("")

    const names = oneEach(servers)
    await seed(servers, names)

    for (const name of names) {
      await waitFor(
        `${name} to reach a second node`,
        () => servers.filter((one) => one.handle.runtime.registry.has(name)).length >= 2,
        20_000,
      )
      // And the copy is a real one, with the row in it.
      const holder = servers.find(
        (one) => one.handle.runtime.registry.has(name) && one.handle.runtime.roleFor(name) === "replica",
      ) as ClusterServer
      await waitFor(`${name} to carry its row`, () => {
        try {
          return holder.handle.runtime.registry.open(name).txid > 0n
        } catch {
          return false
        }
      })
    }
  }, 60_000)

  test("a node in two replica sets holds one client per upstream node", async () => {
    // The shape C3b exists for, forced rather than hoped for: `rf = 3` over three nodes puts every
    // node in the replica set of the two databases it does not own, and those two have **different
    // primaries** — so each node needs a connection to each of the others. With `rf = 2` whether
    // any node lands in two sets is down to the hash, which is not a thing to assert on.
    const servers = await startCluster(3, { overrides: { cluster: { rf: 3 } } })
    await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
    await untilMembership(servers)
    await seed(servers, oneEach(servers))

    await waitFor(
      "every node to hold two upstreams",
      () => servers.every((one) => one.handle.runtime.replicaClients.length === 2),
      20_000,
    )
    const busiest = servers
      .slice()
      .sort((a, b) => b.handle.runtime.replicaClients.length - a.handle.runtime.replicaClients.length)[0] as ClusterServer
    const clients = busiest.handle.runtime.replicaClients
    // One per upstream *node*, not per database, and no two clients on the same upstream.
    expect(new Set(clients.map((one) => one.primary)).size).toBe(clients.length)
    // And every stream is on the client for the node that actually holds that database.
    for (const client of clients) {
      for (const stream of client.status().streams) {
        expect(busiest.handle.runtime.replicaFor(stream.db)).toBe(client)
      }
    }
  }, 60_000)

  test("R7 does not trash a copy another upstream is feeding", async () => {
    // The bug this milestone found. The generation ledger is node-level while an announcement is
    // one upstream's, so a client for A used to see a database B was feeding, miss it in A's
    // announcement, and take the copy to the trash underneath a live stream.
    const servers = await startCluster(3, { overrides: { cluster: { rf: 2 } } })
    await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
    await untilMembership(servers)
    const names = oneEach(servers)
    await seed(servers, names)

    await waitFor(
      "every database to reach a second node",
      () => names.every((name) => servers.filter((one) => one.handle.runtime.registry.has(name)).length >= 2),
      20_000,
    )
    // Several heartbeats, which is when `#resolveFollow` runs and when the trashing happened.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    for (const name of names) {
      expect(
        `${name}: ${servers.filter((one) => one.handle.runtime.registry.has(name)).length} holders`,
      ).toBe(`${name}: 2 holders`)
    }
  }, 60_000)

  test("a sharded node follows several upstreams too", async () => {
    // Every `follow.*` envelope carries the upstream it belongs to, so a worker keeps one hosted
    // client per upstream. Without that id the frames of two upstreams would meet in one client.
    const servers = await startCluster(3, {
      overrides: { cluster: { rf: 3 }, server: { workers: 2 } },
    })
    await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
    await untilMembership(servers)
    const names = oneEach(servers)
    await seed(servers, names)

    for (const name of names) {
      await waitFor(
        `${name} to reach a second node`,
        () => servers.filter((one) => one.handle.runtime.registry.has(name)).length >= 2,
        25_000,
      )
    }
    // Two upstreams each, on nodes that shard their databases across worker threads: every
    // `follow.*` frame carried the upstream it belongs to, or the two would have met in one client.
    await waitFor(
      "every sharded node to hold two upstreams",
      () => servers.every((one) => one.handle.runtime.replicaClients.length === 2),
      25_000,
    )
  }, 90_000)
})
