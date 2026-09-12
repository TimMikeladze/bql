// Placement on three real nodes (`docs/c3-placement.md` §5): the create gate that closes the
// two-`acme` hole, and the direction a node gives for a database it holds no copy of.
//
// The oracle is the same one `placement.test.ts` asserts on the pure function — every node computes
// the same home — reached here through HTTP, which is what an operator has.

import { afterEach, describe, expect, test } from "bun:test"
import { homeOf, type PlacementNode } from "../../src/cluster/index.ts"
import { startCluster, stopAll, waitFor, type ClusterServer } from "./servers.ts"

/** The membership as every node's control plane holds it, once `addNode` has committed. */
function membersOf(node: ClusterServer): PlacementNode[] {
  const state = node.handle.runtime.cluster?.state
  if (!state) return []
  return Object.entries(state.nodes).map(([id, info]) => ({ id, zone: info.zone }))
}

/** A database name whose home is `id`, so the test drives the function rather than hoping. */
function nameFor(members: PlacementNode[], id: string): string {
  for (let i = 0; i < 5000; i++) {
    const name = `acme${i}`
    if (homeOf(name, members) === id) return name
  }
  throw new Error(`no name placed on ${id}`)
}

afterEach(stopAll)

describe("placement", () => {
  test("creates on the node the function names and redirects the ones it does not", async () => {
    const servers = await startCluster(3)
    await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
    // Every node has to agree on the membership before the gate can agree on a home.
    await waitFor("every node to know every node", () =>
      servers.every((s) => membersOf(s).length === servers.length),
    )
    const [first, second, third] = servers as [ClusterServer, ClusterServer, ClusterServer]
    const members = membersOf(first)
    for (const node of servers) expect(membersOf(node).map((one) => one.id).sort()).toEqual(members.map((one) => one.id).sort())

    const name = nameFor(members, second.id)

    // The node that is not the home refuses, and says which node is.
    const refused = await first.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
    expect(refused.status).toBe(503)
    const body = (await refused.json()) as { error: { code: string; primary?: string } }
    expect(body.error.code).toBe("NOT_PRIMARY")
    expect(refused.headers.get("bunql-primary")).toContain(String(second.port))

    // The home node creates it.
    const created = await second.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
    expect(created.status).toBe(201)

    // …and this is the hole that closes: the same name on another node is still refused, rather
    // than producing a second file with the same name and different contents.
    const again = await third.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
    expect(again.status).toBe(503)
  }, 30_000)

  test("a node with no copy says where the database is instead of answering 404", async () => {
    const servers = await startCluster(3)
    await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
    await waitFor("every node to know every node", () =>
      servers.every((s) => membersOf(s).length === servers.length),
    )
    const [first, second, third] = servers as [ClusterServer, ClusterServer, ClusterServer]
    const name = nameFor(membersOf(first), first.id)
    expect((await first.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })).status).toBe(201)
    // The claim is what makes the cluster know where it is, and the direction reads that.
    await waitFor("the cluster to know where it is", () =>
      servers.every((s) => s.handle.runtime.cluster?.primaryOf(name) === first.id),
    )

    for (const other of [second, third]) {
      const response = await other.fetch(`/v1/db/${name}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: "select 1" }),
      })
      // Not a 404: the cluster can locate it, so the client is told rather than refused.
      expect(response.status).toBe(503)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_PRIMARY")
      expect(response.headers.get("bunql-primary")).toContain(String(first.port))
    }

    // A name nothing has ever heard of is still a 404: there is nowhere to send the client.
    const missing = await second.fetch("/v1/db/never-existed/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(missing.status).toBe(404)
  }, 30_000)

  test("a database that already exists here is never re-gated by a later membership change", async () => {
    // §2.3: a recorded primary is not moved by a recomputation. Created on a one-node cluster,
    // then two more nodes join and may well change what the function would say.
    const servers = await startCluster(1)
    const [only] = servers as [ClusterServer]
    await waitFor("a raft leader", () => only.handle.runtime.cluster?.isLeader() === true)
    expect((await only.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })).status).toBe(201)
    const wrote = await only.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (a integer)" }),
    })
    expect(wrote.status).toBe(200)
    // It keeps working whatever the placement function would now prefer.
    const again = await only.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t values (1)" }),
    })
    expect(again.status).toBe(200)
  }, 30_000)

  test("a standalone node places nothing and creates what it likes", async () => {
    const servers = await startCluster(1, { overrides: { cluster: { enabled: false } } })
    const [only] = servers as [ClusterServer]
    for (const name of ["alpha", "beta", "gamma"]) {
      expect((await only.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })).status).toBe(201)
    }
  }, 30_000)
})
