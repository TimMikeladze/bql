// The embedded API of design §9.2: the same `Db` interface as the client, a synchronous escape
// hatch that has to agree with it, realtime without HTTP in the middle, and `serve()` mounting the
// server on the engine this process already has open.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bql, type EmbeddedDb } from "../../src/embedded.ts"
import { BqlClientError } from "../../src/client/errors.ts"
import type { DecodedChangeEvent } from "../../src/client/feed.ts"
import { removeTempDir } from "../tmpdir.ts"

/** The error a promise rejected with. Fails the test when it resolved instead. */
async function failure(promise: PromiseLike<unknown>): Promise<BqlClientError> {
  try {
    await promise
  } catch (err) {
    return err as BqlClientError
  }
  throw new Error("expected the call to fail, and it did not")
}

/** A result array as a plain one, which is what `toEqual` compares against a literal. */
function plain<T>(rows: readonly T[]): T[] {
  return [...rows]
}

const dirs: string[] = []
const open: Bql[] = []

async function openBql(): Promise<Bql> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-embedded-"))
  dirs.push(dir)
  const bq = await Bql.open({ dir, realtime: { idleRetainMs: 0 } })
  open.push(bq)
  return bq
}

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let bq: Bql
let db: EmbeddedDb

beforeAll(async () => {
  bq = await openBql()
  db = await bq.create("acme")
  await db.sql`create table todos(id integer primary key, title text, done integer default 0)`.run()
})

afterAll(async () => {
  while (open.length > 0) await open.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) removeTempDir(dir)
  }
})

describe("statements", () => {
  test("the async surface is the client's, down to the metadata", async () => {
    const written = await db.sql`insert into todos(title) values (${"write it"})`.run()
    expect(written.command).toBe("INSERT")
    expect(written.affectedRows).toBe(1)
    expect(written.lastInsertRowid).toBe(1)
    expect(written.txid).toBeGreaterThan(0)

    const rows = await db.sql`select id, title from todos`
    expect(plain(rows)).toEqual([{ id: 1, title: "write it" }])
    expect(rows.columns).toEqual(["id", "title"])
    expect(plain(await db.sql`select id from todos`.values())).toEqual([[1]])
    expect(await db.sql`select title from todos`.first()).toEqual({ title: "write it" })
  })

  test("the sync surface answers with exactly what the async one does", async () => {
    const asyncRows = await db.sql`select id, title from todos order by id`
    const syncRows = db.sync.sql`select id, title from todos order by id`.all()
    expect(syncRows).toEqual(asyncRows as never)
    expect(syncRows.columns).toEqual(asyncRows.columns)
    expect(syncRows.command).toBe(asyncRows.command)
    expect(db.sync.sql`select id from todos order by id`.values()).toEqual(
      (await db.sql`select id from todos order by id`.values()) as never,
    )
    expect(db.sync.sql`select title from todos order by id`.get()).toEqual(
      (await db.sql`select title from todos order by id`.first()) as never,
    )
  })

  test("a sync write moves the txid the same way", () => {
    const before = db.txid
    const run = db.sync.sql`insert into todos(title) values (${"sync"})`.run()
    expect(run.affectedRows).toBe(1)
    expect(run.txid).toBeGreaterThan(before)
    expect(db.txid).toBe(run.txid)
  })

  test("blobs and big integers cross the boundary as themselves", async () => {
    const wide = await bq.create("wide")
    await wide.sql`create table v(id integer primary key, b blob, n integer)`.run()
    const bytes = new Uint8Array([9, 8, 7])
    await wide.execute("insert into v(b, n) values (?, ?)", [bytes, 9007199254740993n]).run()
    expect((await failure(wide.sql`select n from v`)).code).toBe("CLIENT")
    const row = await wide.sql`select b from v`.first()
    expect([...(row?.b as Uint8Array)]).toEqual([9, 8, 7])
  })

  test("a SQLite failure is the client SDK's error, not a raw throw", async () => {
    const error = await failure(db.sql`select * from nope`)
    expect(error).toBeInstanceOf(BqlClientError)
    expect(error.code).toBe("SQLITE_ERROR")
    expect(error.status).toBe(400)
  })

  test("an unknown database is a 404 from the handle, not a crash", async () => {
    expect((await failure(bq.db("missing").sql`select 1`)).code).toBe("DB_NOT_FOUND")
  })
})

describe("batch and transactions", () => {
  test("a batch is one transaction with one txid", async () => {
    const results = await db.batch([
      db.stmt`insert into todos(title) values (${"a"})`,
      db.stmt`select count(*) as n from todos`,
    ])
    expect(results).toHaveLength(2)
    expect(results[0]?.command).toBe("INSERT")
    expect(results[0]?.txid).toBe(results[1]?.txid as number)
  })

  test("an async transaction commits, and a throw rolls it back", async () => {
    const before = Number((await db.sql`select count(*) as n from todos`.first())?.n)
    await db.transaction(async (tx) => {
      await tx.sql`insert into todos(title) values (${"tx"})`
    })
    expect(Number((await db.sql`select count(*) as n from todos`.first())?.n)).toBe(before + 1)

    const rolled = await failure(
      db.transaction(async (tx) => {
        await tx.sql`insert into todos(title) values (${"gone"})`
        throw new Error("no")
      }),
    )
    expect(rolled.message).toBe("no")
    expect(Number((await db.sql`select count(*) as n from todos`.first())?.n)).toBe(before + 1)
  })

  test("a sync transaction is the same transaction without the promise", () => {
    const before = Number(db.sync.sql`select count(*) as n from todos`.get()?.n)
    const returned = db.sync.transaction((tx) => {
      tx.sql`insert into todos(title) values (${"sync tx"})`.run()
      return tx.sql`select count(*) as n from todos`.get()?.n
    })
    expect(Number(returned)).toBe(before + 1)
    expect(() =>
      db.sync.transaction((tx) => {
        tx.sql`insert into todos(title) values (${"rolled back"})`.run()
        throw new Error("no")
      }),
    ).toThrow("no")
    expect(Number(db.sync.sql`select count(*) as n from todos`.get()?.n)).toBe(before + 1)
  })
})

describe("realtime in process", () => {
  test("changes arrive on the bus, with no HTTP in the middle", async () => {
    const watched = await bq.create("watched")
    await watched.sql`create table t(id integer primary key, v text)`.run()
    const feed = watched.changes({ include: "row" })
    const heard: DecodedChangeEvent[] = []
    feed.on("change", (event) => heard.push(event))
    try {
      await watched.sql`insert into t(v) values (${"hello"})`.run()
      await until(() => heard.length > 0)
      expect(heard[0]?.changes[0]).toMatchObject({
        table: "t",
        op: "insert",
        row: { id: 1, v: "hello" },
      })
    } finally {
      feed.close()
    }
  })

  test("a live query re-runs and diffs by key", async () => {
    const watched = bq.db("watched")
    const live = watched.live`select id, v from t order by id`.key("id")
    const rows: number[] = []
    const diffs: string[] = []
    live.on("rows", (event) => rows.push(event.rows.length))
    live.on("diff", (event) => diffs.push(`+${event.added.length} -${event.removed.length}`))
    try {
      await until(() => rows.length > 0)
      await watched.sql`insert into t(v) values (${"second"})`.run()
      await until(() => diffs.length > 0)
      expect(diffs[0]).toBe("+1 -0")
    } finally {
      live.close()
    }
  })

  test("on(commit) hears every database this process writes", async () => {
    const seen: { db: string; txid: number }[] = []
    const off = bq.on("commit", (event) => seen.push(event))
    try {
      await db.sql`insert into todos(title) values (${"heard"})`.run()
      const other = await bq.create("hears")
      await other.sql`create table t(id integer primary key)`.run()
      expect(seen.map((one) => one.db)).toContain("acme")
      expect(seen.map((one) => one.db)).toContain("hears")
      expect(seen.every((one) => one.txid > 0)).toBe(true)
    } finally {
      off()
    }
  })
})

describe("lifecycle", () => {
  test("create, list, stat, fork and delete", async () => {
    const bq2 = await openBql()
    const one = await bq2.create("one")
    await one.sql`create table t(id integer primary key, v text)`.run()
    await one.sql`insert into t(v) values (${"kept"})`.run()

    await bq2.fork("two", "one")
    expect(await bq2.db("two").sql`select v from t`.first()).toEqual({ v: "kept" })

    const names = bq2.list().map((row) => row.name)
    expect(names.sort()).toEqual(["one", "two"])
    const stats = bq2.stat("one")
    expect(stats.name).toBe("one")
    expect(Number(stats.txid)).toBeGreaterThan(0)

    const trash = bq2.delete("two")
    expect(trash).toContain("trash")
    expect(bq2.list().map((row) => row.name)).toEqual(["one"])
  })

  test("snapshot, restore and checkpoint, the node-local three", async () => {
    const bq4 = await openBql()
    const source = await bq4.create("local")
    await source.sql`create table t(id integer primary key, v text)`.run()
    const at = (await source.sql`insert into t(v) values (${"first"})`.run()).txid
    const tip = (await source.sql`insert into t(v) values (${"second"})`.run()).txid

    const snapshot = await bq4.snapshot("local")
    expect(snapshot.txid).toBe(tip)
    expect(snapshot.bytes).toBeGreaterThan(0)
    expect(bq4.stat("local").lastSnapshotTxid).toBe(tip)

    // Never in place: a restore names a new database, as the route does.
    const restored = await bq4.restore("local", { at })
    expect(restored.name).toBe(`local-restore-${at}`)
    expect(await restored.sql`select count(*) as n from t`.first()).toEqual({ n: 1 })
    const named = await bq4.restore("local", { at, into: "rewound-here" })
    expect(named.name).toBe("rewound-here")

    const checkpoint = bq4.checkpoint("local", "TRUNCATE")
    expect(checkpoint.mode).toBe("TRUNCATE")
    expect(checkpoint.walBytes).toBe(0)
    expect(checkpoint.txid).toBe(tip)
  })

  test("a fork at a txid keeps only what was committed by then", async () => {
    const bq3 = await openBql()
    const source = await bq3.create("source")
    await source.sql`create table t(id integer primary key, v text)`.run()
    const at = (await source.sql`insert into t(v) values (${"first"})`.run()).txid
    await source.sql`insert into t(v) values (${"second"})`.run()
    await bq3.fork("rewound", "source", at)
    expect(await bq3.db("rewound").sql`select count(*) as n from t`.first()).toEqual({ n: 1 })
  })
})

describe("serve", () => {
  test("mounts the HTTP surface on the same engine", async () => {
    const served = await openBql()
    const local = await served.create("acme")
    await local.sql`create table t(id integer primary key, v text)`.run()
    const handle = await served.serve({ port: 0, host: "127.0.0.1" })
    try {
      const url = `http://127.0.0.1:${handle.server.port}`
      const response = await fetch(`${url}/v1/db/acme/query`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${served.adminKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql: "insert into t(v) values ('over http')" }),
      })
      expect(response.status).toBe(200)
      // The write went through the listener; the in-process handle sees it because there is one
      // engine, not two.
      expect(local.sync.sql`select v from t`.get()).toEqual({ v: "over http" })
      const health = (await (await fetch(`${url}/healthz`)).json()) as { ok: boolean }
      expect(health.ok).toBe(true)
    } finally {
      await handle.close()
    }
    // Closing the listener leaves the engine open, because the runtime belongs to bql.sh.
    expect(local.sync.sql`select count(*) as n from t`.get()).toEqual({ n: 1 })
  })
})
