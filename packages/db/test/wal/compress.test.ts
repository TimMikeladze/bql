// `[durability] compress` is per record and lives in the record's own header, which is what makes
// it safe to change on a node that has already written a log: `decode` has always read the flag,
// so a log, a replica stream and a bucket may hold both kinds at once.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Database } from "../../src/sqlite/index.ts"
import {
  computeFull,
  decode,
  encode,
  FLAG_ZSTD,
  TxnLog,
  TxnRecorder,
  WalApplier,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, tempDir } from "../tenant/tmp.ts"

afterAll(cleanupTempDirs)

/** A primary with a table and a recorder, ready to make transactions. */
function primary(dir: string) {
  const dbPath = path.join(dir, "main.db")
  const db = Database.open(dbPath)
  db.exec("pragma synchronous = normal")
  db.exec("pragma wal_autocheckpoint = 0")
  db.exec("create table t(id integer primary key, v text)")
  db.walCheckpoint("TRUNCATE")
  return { db, dbPath, recorder: TxnRecorder.open({ dbPath, epoch: 1 }) }
}

describe("record compression", () => {
  test("the flag says which body a record carries, and the sizes differ", () => {
    const dir = tempDir()
    const { db, recorder } = primary(dir)
    db.run("insert into t(v) values (?)", ["x".repeat(64)])
    const [record] = recorder.poll()
    if (!record) throw new Error("no record")

    const zstd = encode(record)
    const plain = encode(record, { compress: false })

    expect(zstd[5]! & FLAG_ZSTD).toBe(FLAG_ZSTD)
    expect(plain[5]! & FLAG_ZSTD).toBe(0)
    expect(plain.byteLength).toBeGreaterThan(zstd.byteLength)

    // Both decode to the same pages: the choice is about bytes on disk, never about content.
    const a = decode(zstd).record
    const b = decode(plain).record
    expect(b.txid).toBe(a.txid)
    expect(b.postChecksum).toBe(a.postChecksum)
    expect([...b.pages.keys()]).toEqual([...a.pages.keys()])
    db.close()
  })

  test("a log written both ways replays onto a replica in one stream", async () => {
    const dir = tempDir()
    const replicaDir = tempDir()
    const { db, dbPath, recorder } = primary(dir)
    const replicaPath = path.join(replicaDir, "main.db")
    await Bun.write(replicaPath, Bun.file(dbPath))
    const base = computeFull(replicaPath, { includeWal: false })
    const applier = new WalApplier({ dbPath: replicaPath, dir: replicaDir })
    applier.seed({
      txid: 0n,
      epoch: 1,
      postChecksum: base.checksum,
      dbSizePages: base.pages,
      pageSize: base.pageSize,
    })

    // Compressed, then not, then compressed again — a node whose setting changed twice.
    const log = TxnLog.open({ dir, fsync: "never" })
    expect(log.compress).toBe(true)
    db.run("insert into t(v) values ('first')")
    for (const record of recorder.poll()) applier.apply(decode(log.append(record)).record)
    log.close()

    const plainLog = TxnLog.open({ dir, fsync: "never", compress: false })
    expect(plainLog.compress).toBe(false)
    db.run("insert into t(v) values ('second')")
    for (const record of recorder.poll()) applier.apply(decode(plainLog.append(record)).record)
    plainLog.close()

    const again = TxnLog.open({ dir, fsync: "never" })
    db.run("insert into t(v) values ('third')")
    for (const record of recorder.poll()) applier.apply(decode(again.append(record)).record)

    // The replica's checksum is the primary's: a mixed log is not a divergent one.
    const primaryState = computeFull(dbPath, { includeWal: true })
    const replicaState = computeFull(replicaPath, { includeWal: true })
    expect(replicaState.checksum).toBe(primaryState.checksum)

    const rows = Database.open(replicaPath, { readonly: true })
    expect(rows.prepare("select count(*) c from t").get()).toEqual({ c: 3 })
    rows.close()

    // And the log reads back in order whichever way each record was written.
    expect([...again.iterate(1n)].map((r) => r.txid)).toEqual([1n, 2n, 3n])
    again.close()
    db.close()
  })

  test("an uncompressed record is smaller to make and larger to keep", () => {
    const dir = tempDir()
    const { db, recorder } = primary(dir)
    db.run("insert into t(v) values (?)", ["y".repeat(200)])
    const [record] = recorder.poll()
    if (!record) throw new Error("no record")
    const zstd = encode(record).byteLength
    const plain = encode(record, { compress: false }).byteLength
    // A page of mostly-empty SQLite page compresses several times over; that is the trade.
    expect(plain / zstd).toBeGreaterThan(2)
    db.close()
  })

  test("the tenant honours the setting, and defaults to compressing", async () => {
    const { TenantRegistry } = await import("../../src/tenant/index.ts")
    for (const [compressLog, wantFlag] of [
      [undefined, FLAG_ZSTD],
      [true, FLAG_ZSTD],
      [false, 0],
    ] as const) {
      const reg = TenantRegistry.open({
        dir: tempDir(),
        ...(compressLog === undefined ? {} : { compressLog }),
      })
      const tenant = await reg.create("acme")
      // The commit event carries the encoded record — the same bytes the log kept and a replica
      // would be sent, which is where the flag has to be right.
      let encoded: Uint8Array | null = null
      tenant.onCommit((event) => {
        encoded = event.bytes
      })
      tenant.write((db) => db.exec("create table t(id integer primary key, v text)"))
      if (!encoded) throw new Error("no commit event")
      expect((encoded as Uint8Array)[5]! & FLAG_ZSTD).toBe(wantFlag)
      reg.close()
    }
  })
})
