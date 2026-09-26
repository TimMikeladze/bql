// `db.transaction` over both transports of design §9.1: the socket's `tx.*` (§7) and the HTTP
// baton (§6.3). The same callback has to behave the same way on either.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BqlClientError } from "../../src/client/index.ts"
import { startClientFixture, stopAll, type ClientFixture } from "./harness.ts"

let fixture: ClientFixture

beforeAll(async () => {
  fixture = await startClientFixture({}, `create table t(id integer primary key, v text)`)
})
afterAll(stopAll)

async function count(): Promise<number> {
  const row = await fixture.client.db("acme").sql`select count(*) as n from t`.first()
  return Number(row?.n ?? 0)
}

for (const via of ["ws", "http"] as const) {
  describe(`transaction over ${via}`, () => {
    test("commits what the callback wrote, under one txid", async () => {
      const db = fixture.client.db("acme")
      const before = await count()
      const rows = await db.transaction(async (tx) => {
        await tx.sql`insert into t(v) values (${`${via}-1`})`
        await tx.sql`insert into t(v) values (${`${via}-2`})`
        return (await tx.sql`select count(*) as n from t`.first())?.n
      }, { via })
      expect(Number(rows)).toBe(before + 2)
      expect(await count()).toBe(before + 2)
    })

    test("a throw rolls back and the error reaches the caller", async () => {
      const db = fixture.client.db("acme")
      const before = await count()
      const failure = await db
        .transaction(async (tx) => {
          await tx.sql`insert into t(v) values (${"rolled back"})`
          throw new Error("no")
        }, { via })
        .then(null, (err: unknown) => err as Error)
      expect(failure?.message).toBe("no")
      expect(await count()).toBe(before)
    })

    test("a failing statement inside leaves the writer free afterwards", async () => {
      const db = fixture.client.db("acme")
      const failure = await db
        .transaction(async (tx) => {
          await tx.sql`insert into nope(v) values (1)`
        }, { via })
        .then(null, (err: unknown) => err as BqlClientError)
      expect(failure?.code).toBe("SQLITE_ERROR")
      // The next transaction proves the baton was dropped rather than left holding the writer.
      await db.transaction(async (tx) => {
        await tx.sql`insert into t(v) values (${"after failure"})`
      }, { via })
      expect(await count()).toBeGreaterThan(0)
    })

    test("the txid the client tracks moves to the committed one", async () => {
      const db = fixture.client.db("acme")
      const before = db.txid
      await db.transaction(async (tx) => {
        await tx.sql`insert into t(v) values (${"txid"})`
      }, { via })
      expect(db.txid).toBeGreaterThan(before)
    })
  })
}

describe("transport choice", () => {
  test("a client with no WebSocket falls back to the baton on its own", async () => {
    const { client } = await startClientFixture({ WebSocket: null })
    try {
      const db = client.db("acme")
      await db.sql`create table t(id integer primary key, v text)`.run()
      await db.transaction(async (tx) => {
        await tx.sql`insert into t(v) values (${"baton"})`
      })
      expect(await db.sql`select v from t`.first()).toEqual({ v: "baton" })
    } finally {
      client.close()
    }
  })

  // R2 queues a second transaction for `limits.txWaitMs` (500 ms in the harness) before refusing,
  // so a nested one on the same database still fails — just after waiting for a writer its own
  // caller is holding.
  test("a nested transaction on the same database is refused once the queue wait expires", async () => {
    const db = fixture.client.db("acme")
    let inner: BqlClientError | null = null
    await db.transaction(async () => {
      inner = (await db
        .transaction(async () => undefined, { via: "http" })
        .then(null, (err: unknown) => err as BqlClientError)) as BqlClientError | null
    }, { via: "http" })
    expect(inner).not.toBeNull()
    expect((inner as unknown as BqlClientError).code).toBe("TX_BUSY")
    expect((inner as unknown as BqlClientError).status).toBe(409)
  })
})
