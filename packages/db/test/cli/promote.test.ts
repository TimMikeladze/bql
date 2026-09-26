// `bql promote` and `bql cluster`, spawned as an operator runs them, against real nodes.
//
// The CLI addresses the node that should become the primary, not the cluster: promotion is that
// node's own copy being accepted, so `--url` names the candidate.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  untilPrimaryLost,
  untilSynced,
  type Node,
} from "../replication/harness.ts"
import {
  homeServer,
  startCluster,
  stopAll as stopCluster,
  untilMembership,
  waitFor,
} from "../cluster/servers.ts"

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts")

afterAll(async () => {
  await stopAll()
  await stopCluster()
})

interface Ran {
  code: number
  stdout: string
  stderr: string
}

async function bql(url: string, adminKey: string, ...args: string[]): Promise<Ran> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, BQL_URL: url, BQL_ADMIN_KEY: adminKey, BQL_TOKEN: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

const on = (node: Node, ...args: string[]): Promise<Ran> => bql(node.url, node.adminKey, ...args)

describe("bql promote", () => {
  test("promotes a replica whose primary is gone, end to end", async () => {
    const primary = await startPrimary()
    await createDb(primary, "acme", "create table t (v text)")
    await query(primary, "acme", "insert into t (v) values ('one')")
    const replica = await startReplica(primary)
    await untilSynced(primary, replica, "acme")

    // With the primary up it refuses, and says why in a sentence an operator can act on.
    const refused = await on(replica, "promote", "acme")
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("STREAM_LIVE")

    await primary.close()
    await untilPrimaryLost(replica)

    const promoted = await on(replica, "promote", "acme")
    expect(promoted.stderr).toBe("")
    expect(promoted.code).toBe(0)
    expect(promoted.stdout).toContain("acme promoted")
    expect(promoted.stdout).toContain("epoch 1")

    // It is a primary now, and `bql exec` against it writes.
    const wrote = await on(replica, "exec", "acme", "--sql", "insert into t (v) values ('two')")
    expect(wrote.code).toBe(0)
    const read = await on(replica, "exec", "acme", "--sql", "select count(*) as n from t", "--json")
    expect(read.code).toBe(0)
    expect(JSON.parse(read.stdout)).toEqual([{ n: 2 }])
  }, 30_000)

  test("--json prints the server's own body, and a missing database is an error", async () => {
    const primary = await startPrimary()
    await createDb(primary, "beta")
    const replica = await startReplica(primary)
    await untilSynced(primary, replica, "beta")
    await primary.close()
    await untilPrimaryLost(replica)

    const missing = await on(replica, "promote", "nothing")
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("NO_COPY")

    const promoted = await on(replica, "promote", "beta", "--json")
    expect(promoted.code).toBe(0)
    expect(JSON.parse(promoted.stdout)).toMatchObject({ db: "beta", promoted: true, role: "primary" })
  }, 30_000)

  test("promote needs a database", async () => {
    const primary = await startPrimary()
    const ran = await on(primary, "promote")
    expect(ran.code).toBe(1)
    expect(ran.stderr).toContain("promote needs a database")
  })
})

describe("bql cluster", () => {
  test("reports membership, the term and where each database lives", async () => {
    const servers = await startCluster(3)
    await waitFor("a raft leader", () => servers.some((s) => s.handle.runtime.cluster?.isLeader()))
    await untilMembership(servers)
    // C3's create gate: only the node the placement function names may create it, so the test asks
    // the same function the cluster does rather than assuming the first node.
    const owner = homeServer(servers, "acme")
    const created = await bql(owner.url, owner.adminKey, "db", "create", "acme")
    expect(created.code).toBe(0)

    const json = await bql(owner.url, owner.adminKey, "cluster", "--json")
    expect(json.code).toBe(0)
    const view = JSON.parse(json.stdout) as {
      id: string
      term: number
      nodes: { id: string }[]
      dbs: { db: string; primary: string | null; leaseHeldHere: boolean }[]
    }
    expect(view.id).toBe(owner.id)
    expect(view.term).toBeGreaterThan(0)
    expect(view.nodes.map((node) => node.id).sort()).toEqual(["n1", "n2", "n3"])
    expect(view.dbs.find((db) => db.db === "acme")).toMatchObject({
      primary: owner.id,
      leaseHeldHere: true,
    })

    const table = await bql(owner.url, owner.adminKey, "cluster")
    expect(table.code).toBe(0)
    expect(table.stdout).toContain("acme")
    expect(table.stdout).toContain("term")
  }, 30_000)

  test("a node with no [cluster] section says so rather than pretending", async () => {
    const standalone = await startPrimary()
    const ran = await on(standalone, "cluster")
    expect(ran.code).toBe(1)
    expect(ran.stderr).toContain("CLUSTER_DISABLED")
  })
})
