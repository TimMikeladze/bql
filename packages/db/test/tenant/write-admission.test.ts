// L2. `maxGroupCommit` bounds a drain; nothing bounded the backlog. A tenant whose disk has
// stalled — or one simply fed faster than it commits — accumulated pending promises until the
// heap ended, and the caller waited however long that took.
//
// What is asserted here is the shape of the guarantee, not the mechanism: the queue holds at most
// `maxQueuedWrites` entries however hard it is fed, the writer never runs a statement whose caller
// has gone, and an entry that waits past `queueWaitMs` is refused rather than committed late.

import { afterAll, expect, test } from "bun:test"
import { BunQLError } from "../../src/server/errors.ts"
import { TenantRegistry } from "../../src/tenant/index.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

/** One write per drain, so entries pushed in a burst are still queued on the next turn. */
function registry(options: Record<string, unknown> = {}) {
  return TenantRegistry.open({
    dir: tempDir(),
    maxGroupCommit: 1,
    ...options,
  } as Parameters<typeof TenantRegistry.open>[0])
}

const codeOf = (err: unknown): string =>
  err instanceof BunQLError ? err.code : `not a BunQLError: ${String(err)}`

test("a tenant fed faster than it commits refuses at a steady queue depth", async () => {
  const reg = registry({ maxQueuedWrites: 4 })
  const tenant = await reg.create("acme")
  tenant.write((db) => db.exec("create table t(id integer primary key, v integer)"))

  // Sixty writes issued in one turn against a queue of four. Admission is at push, so the first
  // four are taken and the rest are refused — and the depth is never five.
  let peak = 0
  const settled = await Promise.allSettled(
    Array.from({ length: 60 }, (_, i) => {
      const promise = tenant.writeQueued((db) => db.run("insert into t(v) values (?)", [i]), {
        bytes: 32,
      })
      peak = Math.max(peak, tenant.stats().queuedWrites)
      return promise
    }),
  )
  expect(peak).toBeLessThanOrEqual(4)

  const accepted = settled.filter((s) => s.status === "fulfilled").length
  const refused = settled.filter((s) => s.status === "rejected")
  expect(accepted).toBe(4)
  expect(refused.length).toBe(56)
  for (const one of refused) {
    expect(codeOf((one as PromiseRejectedResult).reason)).toBe("WRITE_QUEUE_FULL")
  }
  // The refusal carries a retry hint derived from the drain rate, never a bare 503.
  const first = (refused[0] as PromiseRejectedResult).reason as BunQLError
  expect(first.status).toBe(503)
  expect(first.details?.retryAfterSec).toBeGreaterThanOrEqual(1)

  // Every accepted write landed; nothing was lost between admission and commit.
  expect(await tenant.read((db) => db.query("select count(*) as n from t").get())).toEqual({ n: 4 })
  expect(tenant.stats().queuedWriteBytes).toBe(0)
  await reg.close()
})

test("the byte ceiling refuses before the count does, and an oversize write still runs alone", async () => {
  const reg = registry({ maxQueuedWrites: 100, maxQueuedWriteBytes: 1000 })
  const tenant = await reg.create("acme")
  tenant.write((db) => db.exec("create table t(id integer primary key, v text)"))

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      tenant.writeQueued((db) => db.run("insert into t(v) values (?)", [String(i)]), { bytes: 400 }),
    ),
  )
  const refused = results.filter((r) => r.status === "rejected")
  expect(refused.length).toBeGreaterThan(0)
  expect(codeOf((refused[0] as PromiseRejectedResult).reason)).toBe("WRITE_QUEUE_FULL")

  // An entry heavier than the whole budget is served when the queue is empty, so a large write is
  // refused at a busy moment rather than at every moment.
  const big = await tenant.writeQueued((db) => db.run("insert into t(v) values ('big')"), {
    bytes: 5000,
  })
  expect(big.txid).toBeGreaterThan(0n)
  await reg.close()
})

test("a caller that disconnects has its entry dropped before the writer sees it", async () => {
  const reg = registry()
  const tenant = await reg.create("acme")
  tenant.write((db) => db.exec("create table t(id integer primary key, v text)"))

  const controller = new AbortController()
  let ran = false
  const first = tenant.writeQueued((db) => db.run("insert into t(v) values ('first')"))
  const abandoned = tenant.writeQueued(
    (db) => {
      ran = true
      return db.run("insert into t(v) values ('abandoned')")
    },
    { signal: controller.signal, bytes: 64 },
  )
  const rejected = abandoned.catch((err) => codeOf(err))
  controller.abort()

  await first
  expect(await rejected).toBe("BAD_REQUEST")
  // The writer never ran it, so there is no transaction to roll back and no row to find.
  expect(ran).toBe(false)
  expect(await tenant.read((db) => db.query("select count(*) as n from t").get())).toEqual({ n: 1 })
  // And its bytes went back, so an abandoned burst does not starve the queue it left.
  expect(tenant.stats().queuedWriteBytes).toBe(0)
  await reg.close()
})

test("a write that waits past queueWaitMs is refused rather than committed late", async () => {
  const reg = registry({ queueWaitMs: 25 })
  const tenant = await reg.create("acme")
  tenant.write((db) => db.exec("create table t(id integer primary key, v integer)"))

  // One write per drain, and each drain sleeps past the whole deadline, so everything behind the
  // first is stale by the time the writer reaches it.
  const writes = Array.from({ length: 6 }, (_, i) =>
    tenant.writeQueued((db) => {
      Bun.sleepSync(20)
      return db.run("insert into t(v) values (?)", [i])
    }),
  )
  const settled = await Promise.allSettled(writes)
  const refused = settled.filter((s) => s.status === "rejected")
  expect(refused.length).toBeGreaterThan(0)
  for (const one of refused) {
    expect(codeOf((one as PromiseRejectedResult).reason)).toBe("WRITE_QUEUE_TIMEOUT")
  }
  // Refused means never ran: the rows in the table are exactly the ones that were answered.
  const accepted = settled.filter((s) => s.status === "fulfilled").length
  expect(await tenant.read((db) => db.query("select count(*) as n from t").get())).toEqual({ n: accepted })
  await reg.close()
})
