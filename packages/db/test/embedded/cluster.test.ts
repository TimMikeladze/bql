// Three embedded `Bql` instances, each `open` with `[cluster]` and then `serve()`d, form one Raft
// group. The primary of a database closes, a survivor takes its lease, and the embedder on that
// node hears it through `bq.on("role")` and writes through `db.sync.write`.
//
// The same shape as `test/cluster/failover.test.ts` with `followFirst`: the other two nodes follow
// the first over `/v1/replication`, so the failover has a candidate with a copy.

import { afterEach, expect, test } from "bun:test"
import { homeOf } from "../../src/cluster/index.ts"
import { Bql, type EmbeddedRole } from "../../src/embedded.ts"
import { ADMIN_KEY, CLUSTER_SECRET, freePort, stopAll, tempDir, waitFor } from "../cluster/servers.ts"

let open: Bql[] = []

afterEach(async () => {
  const current = open
  open = []
  for (const bq of current) if (!bq.closed) await bq.close()
  await stopAll()
  errors.clear()
})

/** What each node's `onError` saw, by node id. */
const errors = new Map<string, unknown[]>()

/**
 * `placement: true` leaves `[replication] primary` unset, so every node follows whatever the
 * control plane places on it, which is how `bql serve --cluster` without a static upstream runs.
 */
async function embeddedCluster(
  ids: string[],
  options: { placement?: boolean } = {},
): Promise<Map<string, Bql>> {
  const ports = new Map<string, number>()
  for (const id of ids) ports.set(id, await freePort())
  const advertise = (id: string) => `ws://127.0.0.1:${ports.get(id) as number}`
  const first = ids[0] as string
  const nodes = new Map<string, Bql>()
  for (const id of ids) {
    const bq = await Bql.open({
      dir: tempDir(`bql-embedded-${id}-`),
      server: { port: ports.get(id) as number, host: "127.0.0.1", node: id },
      auth: { adminKey: ADMIN_KEY },
      limits: { txIdleTimeoutMs: 1000, txWaitMs: 500 },
      replication: {
        secret: CLUSTER_SECRET,
        heartbeatMs: 100,
        reconnectMs: 20,
        ...(id === first || options.placement ? {} : { primary: `${advertise(first)}/v1/replication` }),
      },
      cluster: {
        enabled: true,
        id,
        advertise: advertise(id),
        peers: ids.filter((peer) => peer !== id).map((peer) => `${peer}=${advertise(peer)}`),
        bootstrap: true,
        ...(options.placement ? { rf: ids.length } : {}),
        // The timings `test/cluster/servers.ts` settled on for three nodes on one event loop.
        leaseTtlMs: 1200,
        leaseRenewMs: 300,
        leaseGuardMs: 400,
        electionTimeoutMs: 700,
        heartbeatMs: 120,
      },
      onError: (err) => {
        const seen = errors.get(id) ?? []
        seen.push(err)
        errors.set(id, seen)
        if (process.env.BQL_TEST_CLUSTER_LOG) console.error(`[${id}]`, err)
      },
    })
    open.push(bq)
    await bq.serve()
    nodes.set(id, bq)
  }
  return nodes
}

/** A database name placement puts on `id`, so that node may create it. */
function nameOn(bq: Bql, id: string): string {
  const state = bq.runtime.cluster?.state
  const members = Object.entries(state?.nodes ?? {}).map(([node, info]) => ({ id: node, zone: info.zone }))
  for (let i = 0; i < 5000; i++) {
    const name = `acme${i}`
    if (homeOf(name, members) === id) return name
  }
  throw new Error(`no name placed on ${id}`)
}

test(
  "serve() joins the Raft group; a survivor's on('role') fires primary and it accepts sync.write",
  async () => {
    const nodes = await embeddedCluster(["n1", "n2", "n3"])
    const all = [...nodes.values()]
    await waitFor("a raft leader", () => all.some((bq) => bq.runtime.cluster?.isLeader()), 20_000)
    await waitFor(
      "every node to know every node",
      () => all.every((bq) => Object.keys(bq.runtime.cluster?.state.nodes ?? {}).length === 3),
      20_000,
    )

    const owner = nodes.get("n1") as Bql
    const followers = ["n2", "n3"].map((id) => [id, nodes.get(id) as Bql] as const)
    const name = nameOn(owner, "n1")
    // Through the route, which is where placement's create gate and the first lease claim live.
    const created = await fetch(`http://127.0.0.1:${owner.config.server.port}/v1/db`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
    expect(created.status).toBe(201)
    await waitFor("n1 to hold the lease", () => owner.runtime.cluster?.holdsLease(name) === true, 20_000)
    const db = owner.db(name)
    db.sync.write((d) => {
      d.exec("create table t (v text)")
      d.query("insert into t (v) values ('before')").run()
    })

    const view = () => owner.runtime.cluster?.observeDbs().find((one) => one.db === name)
    await waitFor(
      "both followers to hold a copy and ack it",
      () =>
        followers.every(
          ([id, bq]) =>
            bq.runtime.registry.has(name) &&
            (view()?.replicas.includes(id) ?? false) &&
            Number(view()?.acked[id] ?? "0") >= db.txid,
        ),
      20_000,
    )
    expect(followers.every(([, bq]) => bq.role(name) === "replica")).toBe(true)

    const heard: { node: string; event: EmbeddedRole }[] = []
    for (const [id, bq] of followers) bq.on("role", (event) => heard.push({ node: id, event }))

    await owner.close()

    await waitFor(
      "a follower to hear it became the primary",
      () => heard.some(({ event }) => event.db === name && event.role === "primary"),
      30_000,
    )
    const winnerId = heard.find(({ event }) => event.db === name && event.role === "primary")?.node
    const winner = nodes.get(winnerId as string) as Bql
    expect(winner.role(name)).toBe("primary")

    const promoted = winner.db(name)
    const before = promoted.txid
    const { txid } = promoted.sync.write((d) => d.query("insert into t (v) values ('after')").run())
    expect(txid).toBe(before + 1)
    expect(promoted.sync.read((d) => d.query("select v from t order by rowid").all())).toEqual([
      { v: "before" },
      { v: "after" },
    ])
  },
  90_000,
)

async function settled(nodes: Map<string, Bql>): Promise<void> {
  const all = [...nodes.values()]
  await waitFor("a raft leader", () => all.some((bq) => bq.runtime.cluster?.isLeader()), 20_000)
  await waitFor(
    "every node to know every node",
    () => all.every((bq) => Object.keys(bq.runtime.cluster?.state.nodes ?? {}).length === 3),
    20_000,
  )
}

test(
  "embedded create goes through placement: refused off its home node, leased on it",
  async () => {
    const nodes = await embeddedCluster(["n1", "n2", "n3"], { placement: true })
    await settled(nodes)
    const home = nodes.get("n1") as Bql
    const away = nodes.get("n2") as Bql
    const name = nameOn(home, "n1")

    const refused = await away.create(name).then(
      () => null,
      (err: unknown) => err,
    )
    // The same answer `POST /v1/db` gives: the home node's address, so the caller can go there.
    expect(refused).toMatchObject({
      code: "NOT_PRIMARY",
      status: 503,
      primary: `http://127.0.0.1:${home.config.server.port}`,
    })
    expect(away.runtime.registry.has(name)).toBe(false)

    // Resolves only once this node holds the lease, so the first write is not `NOT_PRIMARY`.
    const db = await home.create(name)
    expect(home.runtime.cluster?.holdsLease(name)).toBe(true)
    const { txid } = db.sync.write((d) => d.exec("create table t (v text)"))
    expect(txid).toBe(1)
  },
  60_000,
)

test(
  "after a failover the other replica keeps its copy and follows the new primary",
  async () => {
    const nodes = await embeddedCluster(["n1", "n2", "n3"], { placement: true })
    await settled(nodes)
    const owner = nodes.get("n1") as Bql
    const name = nameOn(owner, "n1")
    const db = await owner.create(name)
    db.sync.write((d) => {
      d.exec("create table t (v text)")
      d.query("insert into t (v) values ('before')").run()
    })
    const generation = owner.runtime.generationOf(name)
    const followers = ["n2", "n3"].map((id) => [id, nodes.get(id) as Bql] as const)
    const view = () => owner.runtime.cluster?.observeDbs().find((one) => one.db === name)
    await waitFor(
      "both followers to hold a copy and ack it",
      () =>
        followers.every(
          ([id, bq]) =>
            bq.runtime.registry.has(name) && Number(view()?.acked[id] ?? "0") >= db.txid,
        ),
      30_000,
    )
    for (const [, bq] of followers) expect(bq.runtime.generationOf(name)).toBe(generation)

    await owner.close()
    await waitFor(
      "a follower to be promoted",
      () => followers.some(([, bq]) => bq.role(name) === "primary"),
      30_000,
    )
    const [winnerId, winner] = followers.find(([, bq]) => bq.role(name) === "primary")!
    const [loserId, loser] = followers.find(([id]) => id !== winnerId)!
    // The identity survives promotion, and the follow planner dropping the dead upstream does not
    // make the winner forget it.
    await waitFor(
      "the winner to drop its old upstream",
      () => winner.runtime.replicaClients.length === 0,
      30_000,
    )
    expect(winner.runtime.generationOf(name)).toBe(generation)

    const promoted = winner.db(name)
    const { txid } = promoted.sync.write((d) => d.query("insert into t (v) values ('after')").run())
    await waitFor(
      `${loserId} to apply the new primary's write`,
      () => loser.runtime.registry.has(name) && loser.tenantOf(name).txid >= txid,
      30_000,
    )
    const unfollowed = (errors.get(loserId) ?? []).filter((err) =>
      String(err).includes("re-created"),
    )
    expect(unfollowed).toEqual([])
    expect(loser.runtime.replicaClients.flatMap((client) => client.status().unfollowed)).toEqual([])
    expect(loser.db(name).sync.read((d) => d.query("select v from t order by rowid").all())).toEqual([
      { v: "before" },
      { v: "after" },
    ])
  },
  90_000,
)
