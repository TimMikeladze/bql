// `client.admin` against a live server — the control plane of design §6.5 through the SDK rather
// than through hand-written fetch. `docs/m9-client-admin.md` is the plan of record.

import { afterAll, describe, expect, test } from "bun:test"
import { createClient } from "../../src/client/index.ts"
import { failure, startClientFixture, stopAll, type ClientFixture } from "./harness.ts"

afterAll(stopAll)

/** A fixture whose `acme` has two rows committed at two different txids. */
async function seeded(): Promise<{ fixture: ClientFixture; first: number; second: number }> {
  const fixture = await startClientFixture()
  const db = fixture.client.db("acme")
  const first = (await db.sql`insert into todos(title) values ('one')`.run()).txid
  const second = (await db.sql`insert into todos(title) values ('two')`.run()).txid
  return { fixture, first, second }
}

describe("lifecycle", () => {
  test("creates, lists, stats, configures and deletes", async () => {
    const { client } = await startClientFixture()
    const admin = client.admin

    const created = await admin.create("made", { pageSize: 4096 })
    expect(created.name).toBe("made")
    expect(created.role).toBe("primary")

    const names = (await admin.list()).map((row) => row.name)
    expect(names).toContain("made")
    expect(names).toContain("acme")

    const stats = await admin.stat("made")
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.foreignKeys).toBeNull()

    const configured = await admin.configure("made", { foreignKeys: true })
    expect(configured.foreignKeys).toBe(true)

    const deleted = await admin.delete("made")
    expect(deleted).toMatchObject({ name: "made", deleted: true })
    expect(deleted.trash).toContain("made")
    expect((await admin.list()).map((row) => row.name)).not.toContain("made")
  })

  test("a fork takes the source as of a txid", async () => {
    const { fixture, first } = await seeded()
    const admin = fixture.client.admin

    const forked = await admin.fork("acme-at-first", "acme", first)
    expect(forked.txid).toBe(first)

    const rows = await fixture.client.db("acme-at-first").sql`select title from todos`
    expect(rows.map((row) => row.title)).toEqual(["one"])

    // The tip, for comparison: the fork is a point in history, not a copy of now.
    const tip = await admin.fork("acme-at-tip", "acme")
    const all = await fixture.client.db("acme-at-tip").sql`select title from todos`
    expect(tip.txid).toBeGreaterThan(first)
    expect(all).toHaveLength(2)
  })

  test("snapshot, restore into a new database, checkpoint", async () => {
    const { fixture, first, second } = await seeded()
    const admin = fixture.client.admin

    const snapshot = await admin.snapshot("acme")
    expect(snapshot.txid).toBe(second)
    expect(snapshot.bytes).toBeGreaterThan(0)
    expect(snapshot.snapshotId).toContain(".db")
    expect((await admin.stat("acme")).lastSnapshotTxid).toBe(second)

    // A restore never rewinds in place: it names a new database, defaulting to `<db>-restore-<txid>`.
    const restored = await admin.restore("acme", { at: first })
    expect(restored).toMatchObject({ from: "acme", txid: first })
    expect(restored.name).toBe(`acme-restore-${first}`)
    const rows = await fixture.client.db(restored.name).sql`select title from todos`
    expect(rows.map((row) => row.title)).toEqual(["one"])

    const named = await admin.restore("acme", { at: first, into: "rewound" })
    expect(named.name).toBe("rewound")

    const checkpoint = await admin.checkpoint("acme", "TRUNCATE")
    expect(checkpoint.mode).toBe("TRUNCATE")
    expect(checkpoint.walBytes).toBe(0)
    expect(checkpoint.txid).toBe(second)
  })

  test("dump streams the file out and import reads one back in", async () => {
    const { fixture } = await seeded()
    const admin = fixture.client.admin

    const dump = await admin.dump("acme")
    expect(dump.txid).toBeGreaterThan(0)
    const bytes = new Uint8Array(await new Response(dump.stream).arrayBuffer())
    expect(dump.bytes).toBe(bytes.byteLength)
    expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe("SQLite format 3")

    const imported = await admin.import("copied", bytes)
    expect(imported.name).toBe("copied")
    const rows = await fixture.client.db("copied").sql`select title from todos order by id`
    expect(rows.map((row) => row.title)).toEqual(["one", "two"])
  })
})

describe("replication and backup", () => {
  test("a standalone node is its own primary and ships nothing", async () => {
    const { client } = await startClientFixture()

    const replication = await client.admin.replication("acme")
    expect(replication.role).toBe("primary")
    expect(replication.s3).toBeNull()
    if (replication.role === "primary") expect(replication.replicas).toEqual([])

    const backup = await client.admin.backup("acme")
    expect(backup.enabled).toBe(false)
    expect(backup.bucket).toBeNull()
  })
})

describe("tokens", () => {
  test("mints one the server accepts, and revokes it", async () => {
    const { server, client } = await startClientFixture()

    const minted = await client.admin.mintToken({ dbs: ["acme"], scope: "ro", ttlMs: 60_000 })
    expect(minted.token.split(".")).toHaveLength(3)
    // `exp` is a JWT claim, so it is in seconds.
    expect(minted.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))

    const scoped = createClient({ url: server.url, token: minted.token })
    expect(await scoped.db("acme").sql`select 1 as n`).toHaveLength(1)

    const revoked = await client.admin.revokeToken(minted.jti)
    expect(revoked).toEqual({ jti: minted.jti, revoked: true })

    const refused = await failure(scoped.db("acme").sql`select 1 as n`)
    expect(refused.status).toBe(401)
    scoped.close()
  })

  test("a token needs at least one database, and nothing is sent without one", async () => {
    const { client, requests } = await startClientFixture()
    const before = requests.length
    const err = await failure(Promise.resolve().then(() => client.admin.mintToken({})))
    expect(err.code).toBe("CLIENT")
    expect(requests.length).toBe(before)
  })
})

describe("failures", () => {
  test("carry the server's own code", async () => {
    const { client } = await startClientFixture()

    const missing = await failure(client.admin.stat("nope"))
    expect(missing.code).toBe("DB_NOT_FOUND")
    expect(missing.status).toBe(404)

    const conflict = await failure(client.admin.create("acme"))
    expect(conflict.code).toBe("CONFLICT")

    const unauthorized = createClient({ url: (await startClientFixture()).server.url })
    const refused = await failure(unauthorized.admin.list())
    expect(refused.status).toBe(401)
    unauthorized.close()
  })
})
