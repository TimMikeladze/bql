// Promotion in a static topology (`--replica-of`, no `[cluster]`): the operator is the authority,
// and the epoch is what stops a primary that comes back from being one again.
//
// The four things worth pinning here are the four that were wrong or missing before C2: a replica
// cannot be promoted while its primary is demonstrably up; a promoted node serves its own admin
// routes (the `readonly role` bug in `docs/next.md`); the promoted node stops following the
// database it now owns; and a node holding an epoch somebody else has moved past is fenced rather
// than left accepting writes.

import { afterEach, describe, expect, test } from "bun:test"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  tempDir,
  untilPrimaryLost,
  untilSynced,
  type Node,
} from "./harness.ts"

afterEach(async () => {
  await stopAll()
})

async function post(
  node: Node,
  route: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await node.fetch(route, { method: "POST", body: JSON.stringify(body) })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  }
}

function errorOf(body: Record<string, unknown>): { code: string; message: string } {
  return body.error as { code: string; message: string }
}

describe("promotion, static topology", () => {
  test("a replica whose primary is up is refused, and nothing local changes", async () => {
    const primary = await startPrimary()
    await createDb(primary, "acme", "create table t (v text)")
    const replica = await startReplica(primary)
    await untilSynced(primary, replica, "acme")

    const refused = await post(replica, "/v1/db/acme/promote", {})
    expect(refused.status).toBe(409)
    expect(errorOf(refused.body).code).toBe("STREAM_LIVE")

    // Still a replica, still following, still refusing writes to the primary's database.
    expect(replica.handle.runtime.roleFor("acme")).toBe("replica")
    expect(replica.handle.runtime.replica?.followed).toContain("acme")
    const write = await post(replica.handle ? replica : replica, "/v1/db/acme/query", {
      sql: "insert into t (v) values ('x')",
    })
    // Forwarding is on by default, so the write lands on the primary rather than being refused.
    expect(write.status).toBe(200)
    expect(primary.handle.runtime.registry.open("acme").txid).toBeGreaterThan(1n)
  })

  test("a promoted replica owns the database: its own admin routes, its own writes", async () => {
    const primary = await startPrimary()
    await createDb(primary, "acme", "create table t (v text)")
    await query(primary, "acme", "insert into t (v) values ('before')")
    const replica = await startReplica(primary)
    await untilSynced(primary, replica, "acme")
    const epochBefore = replica.handle.runtime.registry.open("acme").epoch

    await primary.close()
    await untilPrimaryLost(replica)

    const promoted = await post(replica, "/v1/db/acme/promote", {})
    // The body first: a refusal prints its code here, where `.status` alone would not.
    expect(promoted.body).toMatchObject({ promoted: true })
    expect(promoted.status).toBe(200)
    expect(promoted.body.promoted).toBe(true)
    expect(promoted.body.role).toBe("primary")
    expect(promoted.body.epoch).toBe(epochBefore + 1)

    // The live role moved, which is the bug `docs/next.md` said C2 had to fix: before this, the
    // node kept `role === "replica"` in-process and refused its own lifecycle routes.
    expect(replica.handle.runtime.roleFor("acme")).toBe("primary")
    expect(replica.handle.runtime.role).toBe("primary")
    expect(replica.handle.runtime.replica?.detached).toContain("acme")
    expect(replica.handle.runtime.replica?.followed).not.toContain("acme")

    // It writes.
    const written = await query(replica, "acme", "insert into t (v) values ('after')")
    expect(written.txid).toBeGreaterThan(0)
    const rows = await query(replica, "acme", "select v from t order by rowid")
    expect(rows.rows).toEqual([["before"], ["after"]])

    // And the record it authored carries the new epoch, which is the fencing token.
    expect(replica.handle.runtime.registry.open("acme").epoch).toBe(epochBefore + 1)

    // Its own admin routes work now, and no response claims a primary elsewhere.
    const created = await post(replica, "/v1/db", { name: "beta" })
    expect(created.status).toBe(201)
    const stat = await replica.fetch("/v1/db/acme")
    expect(stat.headers.get("BunQL-Role")).toBe("primary")
    expect(stat.headers.get("BunQL-Primary")).toBeNull()
    const health = (await replica.json("/healthz")) as { role: string }
    expect(health.role).toBe("primary")

    const deleted = await replica.fetch("/v1/db/beta", { method: "DELETE" })
    expect(deleted.status).toBe(200)
  })

  test("promoting twice is refused rather than burning a second epoch", async () => {
    const primary = await startPrimary()
    await createDb(primary, "acme", "create table t (v text)")
    const replica = await startReplica(primary)
    await untilSynced(primary, replica, "acme")
    await primary.close()
    await untilPrimaryLost(replica)

    // Losing a primary promotes nobody. There is no control plane here, so there is no lease path
    // and nothing that re-reads a role: `docs/c2-promotion.md` says the operator is the authority
    // in a static topology, and this is that claim as an assertion.
    expect(replica.handle.runtime.roleFor("acme")).toBe("replica")

    const first = await post(replica, "/v1/db/acme/promote", {})
    expect(first.body).toMatchObject({ promoted: true })
    expect(first.status).toBe(200)
    const epoch = replica.handle.runtime.registry.open("acme").epoch
    const again = await post(replica, "/v1/db/acme/promote", {})
    expect(again.status).toBe(409)
    expect(errorOf(again.body).code).toBe("ALREADY_PRIMARY")
    expect(replica.handle.runtime.registry.open("acme").epoch).toBe(epoch)
  })

  test("promoting a database this node has no copy of is refused", async () => {
    const primary = await startPrimary()
    await createDb(primary, "acme")
    const replica = await startReplica(primary)
    await untilSynced(primary, replica, "acme")

    const refused = await post(replica, "/v1/db/nothing/promote", {})
    expect(refused.status).toBe(404)
    expect(errorOf(refused.body).code).toBe("NO_COPY")
  })

  test("--force promotes against a live stream, for an operator who has checked", async () => {
    const primary = await startPrimary()
    await createDb(primary, "acme", "create table t (v text)")
    const replica = await startReplica(primary)
    await untilSynced(primary, replica, "acme")

    const forced = await post(replica, "/v1/db/acme/promote", { force: true })
    expect(forced.status).toBe(200)
    expect(replica.handle.runtime.roleFor("acme")).toBe("primary")
    // The promoted node stops following the database it now owns, so the still-live old primary
    // cannot stream over it — that is what `detach` is for.
    expect(replica.handle.runtime.replica?.detached).toContain("acme")
  })

  test("a node holding a stale epoch is fenced by a peer that holds a newer one", async () => {
    // Three nodes and the misconfiguration this is really about: a node is promoted, a follower is
    // moved onto it, and then something points that follower back at the node that was replaced.
    const primaryDir = tempDir("bunql-old-primary-")
    let old = await startPrimary({}, { dir: primaryDir, node: "old" })
    await createDb(old, "acme", "create table t (v text)")
    await query(old, "acme", "insert into t (v) values ('one')")

    const next = await startReplica(old, { node: "next" })
    await untilSynced(old, next, "acme")
    await old.close()
    await untilPrimaryLost(next)

    const promoted = await post(next, "/v1/db/acme/promote", {})
    expect(promoted.body).toMatchObject({ promoted: true })
    expect(promoted.status).toBe(200)
    await query(next, "acme", "insert into t (v) values ('two')")
    const newEpoch = next.handle.runtime.registry.open("acme").epoch

    // A third node follows the new primary, so it holds the new epoch.
    const thirdDir = tempDir("bunql-third-")
    let third = await startReplica(next, { node: "third", dir: thirdDir })
    await untilSynced(next, third, "acme")
    expect(third.handle.runtime.registry.open("acme").epoch).toBe(newEpoch)
    await third.close()

    // The old primary comes back, still believing it owns `acme`, and the third node is pointed
    // back at it by a stale config.
    old = await startPrimary({}, { dir: primaryDir, node: "old" })
    expect(old.handle.runtime.roleFor("acme")).toBe("primary")
    third = await startReplica(old, { node: "third", dir: thirdDir })

    // The subscribe carries an epoch the old primary does not hold, and that is the fencing signal.
    await untilRole(old, "acme", "replica")
    expect(old.handle.runtime.roleFor("acme")).toBe("replica")

    // It does not serve a write at the stale epoch. Forwarding is off in this direction — the old
    // primary follows nobody — so the refusal is the plain `503 NOT_PRIMARY`.
    const write = await post(old, "/v1/db/acme/query", { sql: "insert into t (v) values ('no')" })
    expect(write.status).toBe(503)
    expect(errorOf(write.body).code).toBe("NOT_PRIMARY")
    expect(write.headers.get("BunQL-Role")).toBe("replica")

    // And its lifecycle routes for that database are refused too.
    const deleted = await old.fetch("/v1/db/acme", { method: "DELETE" })
    expect(deleted.status).toBe(503)

    // The third node stopped following the fenced node for that database rather than looping.
    expect(third.handle.runtime.replica?.detached).toContain("acme")
  })
})

/** Waits for a node's live role for one database to become `role`. */
async function untilRole(node: Node, db: string, role: "primary" | "replica"): Promise<void> {
  const deadline = Date.now() + 5000
  while (node.handle.runtime.roleFor(db) !== role) {
    if (Date.now() > deadline) {
      throw new Error(`${db} on ${node.url} is still ${node.handle.runtime.roleFor(db)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
