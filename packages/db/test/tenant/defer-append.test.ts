// P5: filing a committed transaction **after** the client is answered
// (`docs/p5-deferred-compression.md`). `[durability] deferAppend`, off by default.
//
// The case that matters is the last one, and it is why this file spawns processes: a crash in the
// window between the commit and the append has to be recovered by the reconcile that already runs
// after an unclean shutdown. That rests on a log record being **derived from the WAL** rather than
// authored — anything derived can be re-derived — and a test that never kills anything would not
// be testing it.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TenantRegistry } from "../../src/tenant/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const dirs: string[] = []
const open: TenantRegistry[] = []

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) removeTempDir(dir)
  }
})

function registryIn(
  deferAppend: boolean,
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-p5-")),
  extra: { checkpointWalBytes?: number } = {},
): TenantRegistry {
  if (!dirs.includes(dir)) dirs.push(dir)
  const registry = TenantRegistry.open({ dir, compressLog: true, deferAppend, ...extra })
  open.push(registry)
  return registry
}

describe("deferred append", () => {
  test("the log catches up, and holds exactly what was committed", async () => {
    const registry = registryIn(true)
    const tenant = await registry.create("acme", {})
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    const insert = tenant.writer.prepare("insert into t (v) values (?)")
    for (let i = 0; i < 50; i++) tenant.write(() => insert.run(`v${i}`))

    // Still outstanding: the appends are this turn's microtask, which has not run.
    expect(Number(tenant.log.lastTxid)).toBeLessThan(Number(tenant.txid))
    // The client was told the truth about the txid all the same — the rows are committed.
    expect(Number(tenant.txid)).toBe(51)

    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(Number(tenant.log.lastTxid)).toBe(Number(tenant.txid))

    let replayed = 0
    for (const record of tenant.log.iterate(1n)) replayed = Number(record.txid)
    expect(replayed).toBe(51)
  })

  test("records are filed in txid order, never reordered", async () => {
    const registry = registryIn(true)
    const tenant = await registry.create("acme", {})
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    const insert = tenant.writer.prepare("insert into t (v) values (?)")
    for (let i = 0; i < 200; i++) tenant.write(() => insert.run(`v${i}`))
    tenant.flushPending()

    const seen: number[] = []
    for (const record of tenant.log.iterate(1n)) seen.push(Number(record.txid))
    expect(seen).toEqual(Array.from({ length: 201 }, (_, i) => i + 1))
  })

  test("a snapshot flushes first, so the log explains it", async () => {
    const registry = registryIn(true)
    const tenant = await registry.create("acme", {})
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    const insert = tenant.writer.prepare("insert into t (v) values (?)")
    for (let i = 0; i < 20; i++) tenant.write(() => insert.run(`v${i}`))
    const ref = await tenant.snapshot()
    // A snapshot taken with records outstanding would be one the log cannot explain, which is the
    // one way this can be got wrong.
    expect(Number(tenant.log.lastTxid)).toBeGreaterThanOrEqual(Number(ref.txid))
  })

  test("`ack` above local is never deferred", async () => {
    // "replica" and "quorum" block on a record having shipped, which needs it encoded, so
    // deferring would schedule work the caller is about to wait for.
    const registry = registryIn(true)
    const tenant = await registry.create("acme", {})
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    const before = Number(tenant.log.lastTxid)
    tenant.write((db) => db.prepare("insert into t (v) values ('x')").run(), { ack: "replica" })
    expect(Number(tenant.log.lastTxid)).toBeGreaterThan(before)
    expect(Number(tenant.log.lastTxid)).toBe(Number(tenant.txid))
  })

  test("off by default, so nothing is outstanding after a write", async () => {
    const registry = registryIn(false)
    const tenant = await registry.create("acme", {})
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    tenant.write((db) => db.prepare("insert into t (v) values ('x')").run())
    expect(Number(tenant.log.lastTxid)).toBe(Number(tenant.txid))
  })

  test("a size checkpoint files what is outstanding before it empties the WAL", async () => {
    // The bug this pins: `#maybeCheckpoint` assumed the write path had already appended, which
    // `deferAppend` made false. A PASSIVE checkpoint then folded frames into the database file
    // that the log had never seen, and a crash there left a database ahead of a log with no WAL
    // left to re-derive from — `LOG_DIVERGED` on the next open, one run in seven.
    const registry = registryIn(true, undefined, { checkpointWalBytes: 64 * 1024 })
    const tenant = await registry.create("acme", {})
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    const insert = tenant.writer.prepare("insert into t (v) values (?)")

    // A PASSIVE checkpoint backfills and reuses the WAL in place rather than shrinking the file,
    // so the tell is the size crossing the threshold, not falling.
    const threshold = 64 * 1024
    let crossed = -1
    for (let i = 0; i < 400 && crossed < 0; i++) {
      tenant.write(() => insert.run(`v${i}`.padEnd(400, "x")))
      if (tenant.walBytes > threshold) crossed = i
    }
    expect(crossed).toBeGreaterThan(0)
    // The write that crossed it checkpointed, so every txid the WAL held is in the log: nothing
    // is allowed to be outstanding across a checkpoint. Before the fix this lagged by the whole
    // run, because the records were still sitting in `#pending`.
    expect(Number(tenant.log.lastTxid)).toBe(Number(tenant.txid))
  })

  test("a close files what is outstanding, so the log explains the database it leaves", async () => {
    // `close()` sets `#closed` and *then* captures and checkpoints. A flush refused on `#closed`
    // dropped exactly the records that last capture produced, and the TRUNCATE that follows took
    // their frames with them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-p5-close-"))
    dirs.push(dir)
    const registry = registryIn(true, dir)
    const tenant = await registry.create("acme", {})
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    const insert = tenant.writer.prepare("insert into t (v) values (?)")
    for (let i = 0; i < 30; i++) tenant.write(() => insert.run(`v${i}`))
    const txid = Number(tenant.txid)
    // Outstanding on purpose: the microtask has not run.
    expect(Number(tenant.log.lastTxid)).toBeLessThan(txid)
    registry.close()
    open.splice(open.indexOf(registry), 1)

    const reopened = registryIn(true, dir)
    const again = reopened.open("acme")
    expect(Number(again.txid)).toBe(txid)
    let replayed = 0
    for (const record of again.log.iterate(1n)) replayed = Number(record.txid)
    expect(replayed).toBe(txid)
  })

  test("a kill -9 in the window is recovered from the WAL", async () => {
    // The test this milestone exists to pass. A crash between the commit and the append loses log
    // records for transactions the writer had already returned from; the reconcile re-polls the
    // WAL from the saved position and derives them again.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-p5-kill-"))
    dirs.push(dir)
    const writer = Bun.spawn(
      [process.execPath, "run", path.join(import.meta.dir, "p5-writer.ts"), dir],
      { stdout: "pipe", stderr: "pipe" },
    )
    try {
      // Wait until it is actually writing, then let it get well ahead.
      const reader = writer.stdout.getReader()
      await reader.read()
      reader.releaseLock()
      await new Promise((resolve) => setTimeout(resolve, 1500))
    } finally {
      writer.kill(9)
      await writer.exited
    }

    const registry = registryIn(false, dir)
    const tenant = registry.open("acme")
    const rows = tenant.readSync((db) => db.prepare("select count(*) c from t").get()) as { c: number }
    expect(rows.c).toBeGreaterThan(0)

    // The three have to agree: what the database holds, what the tenant says it has recorded, and
    // what the log can replay. A record lost to the crash would show as the log trailing.
    let replayed = 0
    for (const record of tenant.log.iterate(1n)) replayed = Number(record.txid)
    expect(Number(tenant.log.lastTxid)).toBe(Number(tenant.txid))
    expect(replayed).toBe(Number(tenant.txid))
    // Every insert is one transaction, plus the `create table`.
    expect(rows.c).toBe(Number(tenant.txid) - 1)
  }, 60_000)
})
