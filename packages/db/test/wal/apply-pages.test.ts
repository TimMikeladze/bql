// Mechanism A's own properties (design §4.5, `docs/c5-apply-pages.md`). The end-to-end equivalence
// of the two mechanisms lives in `replication.test.ts`, which knows about neither; this file is
// about the things only A can be asked: an empty WAL, the lock set, and the crash window.

import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "../../src/sqlite/index.ts"
import {
  ApplyBusy,
  type ApplyMechanism,
  ChecksumMismatch,
  computeFull,
  decode,
  readWalIndexHeader,
  TxnLog,
  TxnRecorder,
  type TxnRecord,
  WALINDEX_HDR_COPY_SIZE,
  WalApplier,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, dumpFile, integrityOk, openPrimary, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

interface Rig {
  db: Database
  dbPath: string
  replicaPath: string
  replicaDir: string
  recorder: TxnRecorder
  log: TxnLog
  applier: WalApplier
}

function rig(mechanism: ApplyMechanism = "pages", busyMs?: number): Rig {
  const root = tempDir("bunql-apply-a-")
  const primaryDir = path.join(root, "primary")
  const replicaDir = path.join(root, "replica")
  fs.mkdirSync(primaryDir)
  fs.mkdirSync(replicaDir)

  const { db, dbPath } = openPrimary(primaryDir)
  db.exec("create table t(id integer primary key, v text, n real)")
  db.walCheckpoint("TRUNCATE")

  const replicaPath = path.join(replicaDir, "main.db")
  fs.copyFileSync(dbPath, replicaPath)
  const base = computeFull(replicaPath, { includeWal: false })

  const recorder = TxnRecorder.open({ dbPath, epoch: 1 })
  const log = TxnLog.open({ dir: primaryDir, fsync: "never" })
  const applier = new WalApplier({
    dbPath: replicaPath,
    dir: replicaDir,
    mechanism,
    ...(busyMs !== undefined ? { busyMs } : {}),
  })
  applier.seed({
    txid: 0n,
    epoch: 1,
    postChecksum: base.checksum,
    dbSizePages: base.pages,
    pageSize: base.pageSize,
  })
  return { db, dbPath, replicaPath, replicaDir, recorder, log, applier }
}

function closeRig(r: Rig): void {
  r.applier.close()
  r.log.close()
  r.recorder.close()
  r.db.close()
}

/** Tails and applies everything that has committed; returns the records as they went over. */
function ship(r: Rig): TxnRecord[] {
  const shipped: TxnRecord[] = []
  for (const input of r.recorder.poll()) {
    const record = decode(r.log.append(input)).record
    r.applier.apply(record)
    shipped.push(record)
  }
  return shipped
}

function walSize(dbPath: string): number {
  try {
    return fs.statSync(`${dbPath}-wal`).size
  } catch {
    return 0
  }
}

describe("mechanism A — page apply", () => {
  test("the replica's WAL stays empty and a reader opened first sees every commit", () => {
    const r = rig()
    const reader = Database.open(r.replicaPath, { readonly: true })
    const count = reader.prepare("select count(*) c from t")
    expect(count.get()?.c).toBe(0)

    const insert = r.db.prepare("insert into t(v, n) values (?, ?)")
    for (let i = 0; i < 20; i++) {
      r.db.transaction(() => insert.run(`row-${i}`, i))()
      ship(r)
      expect(count.get()?.c).toBe(i + 1)
      expect(walSize(r.replicaPath)).toBe(0)
    }

    expect(r.applier.mechanism).toBe("pages")
    expect(r.applier.fallbackReason).toBeNull()
    expect(r.applier.verify()).toBe(true)
    expect(r.applier.position.postChecksum).toBe(r.recorder.position.checksum)
    expect(integrityOk(r.replicaPath)).toBe(true)
    reader.close()
    closeRig(r)
  })

  test("the published wal-index header says 'empty WAL, N pages' and its iChange advances", () => {
    const r = rig()
    const reader = Database.open(r.replicaPath, { readonly: true })
    reader.exec("select count(*) from t")

    const read = (): { iChange: number; mxFrame: number; nPage: number } => {
      const buf = new Uint8Array(WALINDEX_HDR_COPY_SIZE)
      const fd = fs.openSync(`${r.replicaPath}-shm`, "r")
      fs.readSync(fd, buf, 0, WALINDEX_HDR_COPY_SIZE, 0)
      fs.closeSync(fd)
      const header = readWalIndexHeader(buf)
      if (!header) throw new Error("no wal-index header")
      return { iChange: header.iChange, mxFrame: header.mxFrame, nPage: header.nPage }
    }

    const insert = r.db.prepare("insert into t(v, n) values (?, ?)")
    r.db.transaction(() => insert.run("a", 1))()
    ship(r)
    const first = read()
    expect(first.mxFrame).toBe(0)
    expect(first.nPage).toBe(r.applier.position.dbSizePages)

    r.db.transaction(() => insert.run("b", 2))()
    ship(r)
    const second = read()
    expect(second.iChange).toBe(first.iChange + 1)
    expect(second.mxFrame).toBe(0)

    reader.close()
    closeRig(r)
  })

  test("a reader mid-transaction is not written under: ApplyBusy, then it applies", () => {
    const r = rig("pages", 60)
    const insert = r.db.prepare("insert into t(v, n) values (?, ?)")
    r.db.transaction(() => insert.run("first", 1))()
    ship(r)

    const before = computeFull(r.replicaPath, { includeWal: false }).checksum
    const reader = Database.open(r.replicaPath, { readonly: true })
    reader.exec("begin")
    expect(reader.prepare("select count(*) c from t").get()?.c).toBe(1)

    r.db.transaction(() => insert.run("second", 2))()
    const pending = r.recorder.poll().map((input) => decode(r.log.append(input)).record)
    expect(pending.length).toBe(1)

    expect(() => r.applier.apply(pending[0] as TxnRecord)).toThrow(ApplyBusy)
    // Nothing was written: the reader is still looking at the database it started on.
    expect(computeFull(r.replicaPath, { includeWal: false }).checksum).toBe(before)
    expect(reader.prepare("select count(*) c from t").get()?.c).toBe(1)
    expect(r.applier.position.txid).toBe(1n)

    reader.exec("commit")
    r.applier.apply(pending[0] as TxnRecord)
    expect(r.applier.position.txid).toBe(2n)
    expect(reader.prepare("select count(*) c from t").get()?.c).toBe(2)

    reader.close()
    closeRig(r)
  })

  test("a crash between the page write and the position write resumes, not re-snapshots", () => {
    const r = rig()
    const insert = r.db.prepare("insert into t(v, n) values (?, ?)")
    for (let i = 0; i < 5; i++) {
      r.db.transaction(() => insert.run(`row-${i}`, i))()
      ship(r)
    }
    // The position as it stood before the record whose meta write we are about to lose.
    const staleMeta = fs.readFileSync(r.applier.metaPath)

    r.db.transaction(() => insert.run("crashing", 99))()
    const [record] = r.recorder.poll().map((input) => decode(r.log.append(input)).record)
    if (!record) throw new Error("expected a record")
    r.applier.apply(record)
    expect(r.applier.position.txid).toBe(6n)
    r.applier.close()

    // The crash: the pages are durable, `meta.json` is not.
    fs.writeFileSync(r.applier.metaPath, staleMeta)

    const resumed = new WalApplier({ dbPath: r.replicaPath, dir: r.replicaDir })
    expect(resumed.position.txid).toBe(5n)
    resumed.apply(record)
    expect(resumed.position.txid).toBe(6n)
    expect(resumed.position.postChecksum).toBe(record.postChecksum)
    expect(resumed.verify()).toBe(true)
    expect(dumpFile(r.replicaPath)).toContain("crashing")

    // And the stream carries on from there.
    r.db.transaction(() => insert.run("after", 100))()
    for (const input of r.recorder.poll()) resumed.apply(decode(r.log.append(input)).record)
    expect(resumed.position.postChecksum).toBe(r.recorder.position.checksum)
    resumed.close()
    closeRig(r)
  })

  test("a torn apply is refused loudly rather than resumed", () => {
    const r = rig()
    const insert = r.db.prepare("insert into t(v, n) values (?, ?)")
    for (let i = 0; i < 5; i++) {
      r.db.transaction(() => insert.run(`row-${i}`, i))()
      ship(r)
    }
    const staleMeta = fs.readFileSync(r.applier.metaPath)
    const pageSize = r.applier.position.pageSize

    r.db.transaction(() => insert.run("torn", 7))()
    const [record] = r.recorder.poll().map((input) => decode(r.log.append(input)).record)
    if (!record) throw new Error("expected a record")
    r.applier.apply(record)
    r.applier.close()
    fs.writeFileSync(r.applier.metaPath, staleMeta)

    // Only half the transaction reached the disk: one of its pages is still rubbish.
    const pgno = [...record.pages.keys()].sort((a, b) => a - b)[0] as number
    const fd = fs.openSync(r.replicaPath, "r+")
    fs.writeSync(fd, new Uint8Array(pageSize).fill(0x5a), 0, pageSize, (pgno - 1) * pageSize)
    fs.closeSync(fd)

    const resumed = new WalApplier({ dbPath: r.replicaPath, dir: r.replicaDir })
    expect(() => resumed.apply(record)).toThrow(ChecksumMismatch)
    expect(resumed.position.txid).toBe(5n)
    resumed.close()
    closeRig(r)
  })

  test("a replica that ran mechanism B folds its WAL away when it switches to A", () => {
    const r = rig("wal")
    const insert = r.db.prepare("insert into t(v, n) values (?, ?)")
    for (let i = 0; i < 10; i++) {
      r.db.transaction(() => insert.run(`b-${i}`, i))()
      ship(r)
    }
    expect(walSize(r.replicaPath)).toBeGreaterThan(0)
    const checksum = r.applier.position.postChecksum
    r.applier.close()

    const switched = new WalApplier({
      dbPath: r.replicaPath,
      dir: r.replicaDir,
      mechanism: "pages",
    })
    r.db.transaction(() => insert.run("a-0", 100))()
    for (const input of r.recorder.poll()) switched.apply(decode(r.log.append(input)).record)

    expect(switched.mechanism).toBe("pages")
    expect(walSize(r.replicaPath)).toBe(0)
    expect(switched.position.postChecksum).not.toBe(checksum)
    expect(switched.position.postChecksum).toBe(r.recorder.position.checksum)
    expect(switched.verify()).toBe(true)
    expect(integrityOk(r.replicaPath)).toBe(true)
    switched.close()
    closeRig(r)
  })

  test("both mechanisms produce the same database from the same records", () => {
    const root = tempDir("bunql-apply-both-")
    const primaryDir = path.join(root, "primary")
    fs.mkdirSync(primaryDir)
    const { db, dbPath } = openPrimary(primaryDir)
    db.exec("create table t(id integer primary key, v text)")
    db.exec("create index t_v on t(v)")
    db.walCheckpoint("TRUNCATE")

    const appliers = (["pages", "wal"] as const).map((mechanism) => {
      const dir = path.join(root, mechanism)
      fs.mkdirSync(dir)
      const replicaPath = path.join(dir, "main.db")
      fs.copyFileSync(dbPath, replicaPath)
      const base = computeFull(replicaPath, { includeWal: false })
      const applier = new WalApplier({ dbPath: replicaPath, dir, mechanism })
      applier.seed({
        txid: 0n,
        epoch: 1,
        postChecksum: base.checksum,
        dbSizePages: base.pages,
        pageSize: base.pageSize,
      })
      return { applier, replicaPath, mechanism }
    })

    const recorder = TxnRecorder.open({ dbPath, epoch: 1 })
    const log = TxnLog.open({ dir: primaryDir, fsync: "never" })
    const insert = db.prepare("insert into t(v) values (?)")
    for (let i = 0; i < 40; i++) {
      db.transaction(() => {
        for (let j = 0; j < 3; j++) insert.run(`v-${i}-${j}`)
      })()
      if (i === 20) db.exec("delete from t where id % 3 = 0")
      for (const input of recorder.poll()) {
        const bytes = log.append(input)
        for (const target of appliers) target.applier.apply(decode(bytes).record)
      }
    }

    const target = recorder.position.checksum
    for (const entry of appliers) {
      expect(entry.applier.position.postChecksum).toBe(target)
      expect(entry.applier.verify()).toBe(true)
      expect(integrityOk(entry.replicaPath)).toBe(true)
      expect(dumpFile(entry.replicaPath)).toBe(dumpFile(dbPath))
    }
    // The same database, byte for byte, reached two different ways.
    const [a, b] = appliers
    if (!a || !b) throw new Error("expected two appliers")
    expect(computeFull(a.replicaPath, { includeWal: false }).checksum).toBe(
      computeFull(b.replicaPath, { includeWal: true }).checksum,
    )

    for (const entry of appliers) entry.applier.close()
    log.close()
    recorder.close()
    db.close()
  })
})
