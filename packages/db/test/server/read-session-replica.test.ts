// A read session on a **replica** (`docs/p8-read-sessions.md` §3). This is the case the mechanism
// design §11 named would have got wrong: under `[replication] apply = "pages"` the applier pwrites
// pages straight into the database file and keeps a zero-byte `-wal`, so there is no old version
// of a page for a `sqlite3_snapshot` handle to name. The read transaction works here, and works
// *because* the reader lease makes the applier answer `ApplyBusy` and back off.
//
// Two mechanisms, because they fail differently and only one of them can show both halves of the
// claim at the same instant:
//
//   - `apply = "wal"` (mechanism B): the replica keeps applying under an open session, so the
//     write is invisible inside it and visible outside it at once.
//   - `apply = "pages"` (mechanism A, the default): the applier defers while the session is held,
//     so replication is *delayed* — and the test's job is to show it resumes rather than breaks.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { ErrorBody, QueryResult } from "../../src/client/protocol.ts"
import {
  createDb,
  type Node,
  query,
  startPrimary,
  startReplica,
  stopAll,
  untilSynced,
  untilTxid,
} from "../replication/harness.ts"

const SCHEMA = "create table t (id integer primary key, v text)"

let open: { close(): Promise<void> }[] = []

function track<T extends { close(): Promise<void> }>(thing: T): T {
  open.push(thing)
  return thing
}

afterEach(async () => {
  const current = open
  open = []
  for (const thing of current.reverse()) {
    try {
      await thing.close()
    } catch {
      // Already closed by the test itself.
    }
  }
})

afterAll(stopAll)

interface ReadBeginResult {
  read: string
  expiresInMs: number
  idleTimeoutMs: number
}

async function beginOn(node: Node, db: string): Promise<string> {
  const response = await node.fetch(`/v1/db/${db}/read`, {
    method: "POST",
    body: JSON.stringify({}),
  })
  if (response.status !== 200) throw new Error(`begin: ${response.status} ${await response.text()}`)
  return ((await response.json()) as ReadBeginResult).read
}

async function countIn(node: Node, db: string, read: string): Promise<number> {
  const response = await node.fetch(`/v1/db/${db}/read/${read}`, {
    method: "POST",
    body: JSON.stringify({ sql: "select count(*) from t" }),
  })
  if (response.status !== 200) throw new Error(`in session: ${response.status} ${await response.text()}`)
  const result = (await response.json()) as QueryResult
  return Number((result.rows[0] as unknown[])[0])
}

async function countOn(node: Node, db: string): Promise<number> {
  const result = await query(node, db, "select count(*) from t")
  return Number((result.rows[0] as unknown[])[0])
}

function endOn(node: Node, db: string, read: string): Promise<Response> {
  return node.fetch(`/v1/db/${db}/read/${read}`, { method: "DELETE" })
}

/** A replica of a fresh primary, synced, with one row in `t`. */
async function pair(apply: "pages" | "wal"): Promise<{ primary: Node; replica: Node }> {
  const primary = track(await startPrimary())
  await createDb(primary, "acme", SCHEMA)
  await query(primary, "acme", "insert into t(id, v) values (1, 'a')")
  const replica = track(
    await startReplica(primary, {
      overrides: { replication: { apply }, limits: { txIdleTimeoutMs: 10_000, readTxTimeoutMs: 20_000 } },
    }),
  )
  await untilSynced(primary, replica, "acme")
  return { primary, replica }
}

describe("a read session on a replica", () => {
  test("mechanism B: a write replicated mid-session is invisible inside it and visible outside it", async () => {
    const { primary, replica } = await pair("wal")
    expect(replica.handle.registry.open("acme").applier?.mechanism).toBe("wal")

    const read = await beginOn(replica, "acme")
    try {
      // Request one takes the snapshot.
      expect(await countIn(replica, "acme", read)).toBe(1)

      // A write on the primary, replicated to this node while the session is open.
      const written = await query(primary, "acme", "insert into t(id, v) values (2, 'b')")
      await untilTxid(replica, "acme", written.txid)

      // Both halves, at the same instant, on the node that is serving the session.
      expect(await countIn(replica, "acme", read)).toBe(1)
      expect(await countOn(replica, "acme")).toBe(2)
    } finally {
      expect((await endOn(replica, "acme", read)).status).toBe(200)
    }
    expect(await countOn(replica, "acme")).toBe(2)
  })

  test("mechanism A: the session delays the applier and replication resumes when it ends", async () => {
    const { primary, replica } = await pair("pages")
    expect(replica.handle.registry.open("acme").applier?.mechanism).toBe("pages")

    const read = await beginOn(replica, "acme")
    // The first *read* is what pins the snapshot: `BEGIN DEFERRED` takes no read mark until then,
    // which is SQLite's own behaviour and the reason the applier is free until this line runs.
    expect(await countIn(replica, "acme", read)).toBe(1)

    const written = await query(primary, "acme", "insert into t(id, v) values (2, 'b')")

    // Held: the applier takes the wal-index lock set itself, so a reader mid-session makes it
    // answer `ApplyBusy`. The record goes on `stream.deferred` and is retried — nothing is
    // written, nothing is lost, and the position does not move. The wait is long enough for the
    // record to have arrived and been refused; that it is *only* deferred is what the catch-up
    // below proves.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await countIn(replica, "acme", read)).toBe(1)
    expect(await countOn(replica, "acme")).toBe(1)
    expect(Number(replica.handle.registry.open("acme").txid)).toBeLessThan(written.txid)

    // Released: the retry lands and the replica catches up on its own.
    expect((await endOn(replica, "acme", read)).status).toBe(200)
    await untilTxid(replica, "acme", written.txid)
    expect(await countOn(replica, "acme")).toBe(2)

    // And a session opened now sees the world the first one was hiding from.
    const after = await beginOn(replica, "acme")
    expect(await countIn(replica, "acme", after)).toBe(2)
    await endOn(replica, "acme", after)
  })

  test("the session is served by the replica itself, not forwarded to the primary", async () => {
    const { primary, replica } = await pair("pages")
    const read = await beginOn(replica, "acme")
    expect(await countIn(replica, "acme", read)).toBe(1)

    // Local, not forwarded. A writer transaction on a replica has its whole baton lifecycle on
    // the primary and this node only holds the mapping; a read session takes no writer, so it
    // lives here — which is what the replica's own counter rising and the primary's staying at
    // zero says. It is also why `sqlite3_snapshot` could not have served this case.
    expect((await replica.json<{ readSessions: number }>("/v1/db/acme")).readSessions).toBe(1)
    expect((await primary.json<{ readSessions: number }>("/v1/db/acme")).readSessions).toBe(0)

    // A write inside one is refused here for the read-session reason, not the replica reason.
    const write = await replica.fetch(`/v1/db/acme/read/${read}`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(id, v) values (3, 'c')" }),
    })
    expect(write.status).toBe(403)
    expect(((await write.json()) as ErrorBody).error.code).toBe("SQLITE_READONLY")
    expect((await endOn(replica, "acme", read)).status).toBe(200)

    const stats = await replica.json<{ role: string; readSessions: number }>("/v1/db/acme")
    expect(stats.role).toBe("replica")
    expect(stats.readSessions).toBe(0)
  })
})
