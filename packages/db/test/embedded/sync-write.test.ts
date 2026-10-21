// `db.sync.write` and `db.sync.read`: the driver connection lent to a callback, with the tenant's
// write path around it, and the guard that keeps the callback from ending the transaction or
// changing the connection under the tenant.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bql } from "../../src/embedded.ts"
import { BqlClientError } from "../../src/client/errors.ts"
import { SqliteError } from "../../src/sqlite/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const dirs: string[] = []
let open: Bql[] = []

async function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-embedded-write-"))
  dirs.push(dir)
  const bq = await Bql.open({ dir })
  open.push(bq)
  const db = await bq.create("acme")
  db.sync.execute("create table t (id integer primary key, v text not null unique)").run()
  return { bq, db }
}

function failure(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to fail, and it did not")
}

afterEach(async () => {
  const current = open
  open = []
  for (const bq of current) await bq.close()
})

afterAll(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop() as string)
})

describe("sync.write", () => {
  test("commits through the log, answers the txid, and reads see the transaction's own writes", async () => {
    const { bq, db } = await openDb()
    const commits: number[] = []
    bq.on("commit", (event) => commits.push(event.txid))
    const before = db.txid

    const { value, txid } = db.sync.write((d) => {
      const insert = d.query("insert into t (v) values (?)")
      insert.run("a")
      insert.run("b")
      return d.query("select count(*) as n from t").get() as { n: number }
    })
    expect(value).toEqual({ n: 2 })
    expect(txid).toBe(before + 1)
    expect(db.txid).toBe(txid)
    await Bun.sleep(0)
    expect(commits).toContain(txid)
    expect(db.sync.read((d) => d.query("select v from t order by id").all())).toEqual([
      { v: "a" },
      { v: "b" },
    ])
  })

  test("d.transaction nests as a SAVEPOINT; an inner throw undoes only the inner work", async () => {
    const { db } = await openDb()
    const { txid } = db.sync.write((d) => {
      d.query("insert into t (v) values ('outer')").run()
      const inner = d.transaction(() => {
        d.query("insert into t (v) values ('inner')").run()
        throw new Error("undo the inner work")
      })
      expect(() => inner()).toThrow("undo the inner work")
      d.transaction(() => d.query("insert into t (v) values ('kept')").run())()
    })
    expect(txid).toBe(db.txid)
    expect(db.sync.read((d) => d.query("select v from t order by id").all())).toEqual([
      { v: "outer" },
      { v: "kept" },
    ])
  })

  test("a throw from the callback rolls back and comes out as the driver threw it", async () => {
    const { db } = await openDb()
    db.sync.write((d) => d.query("insert into t (v) values ('a')").run())
    const before = db.txid
    const err = failure(() =>
      db.sync.write((d) => {
        d.query("insert into t (v) values ('b')").run()
        d.query("insert into t (v) values ('a')").run()
      }),
    )
    expect(err).toBeInstanceOf(SqliteError)
    expect((err as SqliteError).code).toBe("SQLITE_CONSTRAINT_UNIQUE")
    expect(db.txid).toBe(before)
    expect(db.sync.read((d) => d.query("select count(*) as n from t").get())).toEqual({ n: 1 })
  })

  test("refuses transaction control, connection pragmas and ATTACH, and the writer still works", async () => {
    const { db } = await openDb()
    for (const sql of [
      "commit",
      "rollback",
      "begin",
      "pragma journal_mode = delete",
      "pragma wal_checkpoint(TRUNCATE)",
      "pragma synchronous = off",
      "pragma foreign_keys = on",
      "attach database ':memory:' as other",
    ]) {
      const err = failure(() =>
        db.sync.write((d) => {
          d.query("insert into t (v) values ('x')").run()
          d.exec(sql)
        }),
      )
      expect(err).toBeInstanceOf(BqlClientError)
      expect((err as BqlClientError).code).toBe("NOT_AUTHORIZED")
    }
    // A `commit` some other path left in the writer's statement cache is refused too.
    db.tenant().writer.prepare("commit")
    const cached = failure(() => db.sync.write((d) => d.query("commit").run()))
    expect((cached as BqlClientError).code).toBe("NOT_AUTHORIZED")
    expect(db.sync.read((d) => d.query("select count(*) as n from t").get())).toEqual({ n: 0 })

    // Reading the schema, and the reading form of a pragma, are allowed.
    const { value } = db.sync.write((d) => {
      d.query("insert into t (v) values ('ok')").run()
      return {
        columns: d.query("pragma table_info(t)").all().length,
        mode: d.query("pragma journal_mode").get(),
      }
    })
    expect(value).toEqual({ columns: 2, mode: { journal_mode: "wal" } })
  })

  test("ack fsync syncs before returning; replica is refused before anything is written", async () => {
    const { bq, db } = await openDb()
    const { txid } = db.sync.write((d) => d.query("insert into t (v) values ('a')").run(), {
      ack: "fsync",
    })
    await bq.replicated("acme", txid, { ack: "fsync" })

    const before = db.txid
    const err = failure(() =>
      db.sync.write((d) => d.query("insert into t (v) values ('b')").run(), { ack: "replica" }),
    )
    expect((err as BqlClientError).code).toBe("NO_REPLICAS")
    expect(db.txid).toBe(before)
  })

  test("TX_BUSY while a transaction holds the writer, BUSY when nested", async () => {
    const { db } = await openDb()
    let release!: () => void
    const held = db.transaction(
      (tx) =>
        new Promise<void>((resolve) => {
          void tx.sql`insert into t (v) values ('held')`.run()
          release = resolve
        }),
    )
    await Bun.sleep(0)
    const busy = failure(() => db.sync.write((d) => d.query("select 1").get()))
    expect((busy as BqlClientError).code).toBe("TX_BUSY")
    release()
    await held

    const nested = failure(() =>
      db.sync.write(() => db.sync.write((d) => d.query("select 1").get())),
    )
    expect((nested as BqlClientError).code).toBe("BUSY")
  })
})

describe("sync.read", () => {
  test("a read transaction is allowed; one left open is rolled back and reported", async () => {
    const { db } = await openDb()
    db.sync.write((d) => d.query("insert into t (v) values ('a')").run())
    expect(db.sync.read((d) => d.transaction(() => d.query("select count(*) as n from t").get())())).toEqual({ n: 1 })

    const err = failure(() => db.sync.read((d) => d.exec("begin")))
    expect((err as BqlClientError).code).toBe("BAD_REQUEST")
    // The reader went back to the pool clean: a write after it is visible to the next read.
    db.sync.write((d) => d.query("insert into t (v) values ('b')").run())
    expect(db.sync.read((d) => d.query("select count(*) as n from t").get())).toEqual({ n: 2 })
  })

  test("refuses connection pragmas on a reader", async () => {
    const { db } = await openDb()
    const err = failure(() => db.sync.read((d) => d.exec("pragma query_only = 0")))
    expect((err as BqlClientError).code).toBe("NOT_AUTHORIZED")
  })
})

describe("a bare BEGIN through sync.execute", () => {
  test("is refused and does not leave a pooled reader inside a transaction", async () => {
    const { db } = await openDb()
    const err = failure(() => db.sync.execute("begin").run())
    expect((err as BqlClientError).code).toBe("BAD_REQUEST")
    // Every pooled reader is borrowed in turn; one stuck in a snapshot would miss this write.
    db.sync.execute("insert into t (v) values ('after')").run()
    for (let i = 0; i < 8; i++) {
      expect(db.sync.execute("select count(*) as n from t").get()).toEqual({ n: 1 })
    }
  })
})
