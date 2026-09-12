// The end-to-end property: whatever SQL runs on the primary, a replica fed only through
// tail -> record -> encode -> decode -> apply holds exactly the same database. The replica reader
// is opened before the first apply, so every round also exercises the shm invalidation on a
// connection that is already live.

import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "../../src/sqlite/index.ts"
import {
  type ApplyMechanism,
  ChecksumMismatch,
  computeFull,
  decode,
  encode,
  PositionMismatch,
  TxnLog,
  TxnRecorder,
  type TxnRecordInput,
  WalApplier,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, dump, dumpFile, integrityOk, openPrimary, rng, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

interface Rig {
  root: string
  primaryDir: string
  replicaDir: string
  db: Database
  dbPath: string
  replicaPath: string
  recorder: TxnRecorder
  log: TxnLog
  applier: WalApplier
  reader: Database
}

/** A primary with a schema, checkpointed, physically copied to a replica seeded at txid 0. */
function rig(mechanism?: ApplyMechanism): Rig {
  const root = tempDir()
  const primaryDir = path.join(root, "primary")
  const replicaDir = path.join(root, "replica")
  fs.mkdirSync(primaryDir)
  fs.mkdirSync(replicaDir)

  const { db, dbPath } = openPrimary(primaryDir)
  db.exec("create table users(id integer primary key, name text, score real)")
  db.exec("create table notes(id integer primary key, user_id integer, body text)")
  db.exec("create index notes_user on notes(user_id)")
  db.walCheckpoint("TRUNCATE")

  const replicaPath = path.join(replicaDir, "main.db")
  fs.copyFileSync(dbPath, replicaPath)
  const base = computeFull(replicaPath, { includeWal: false })

  const recorder = TxnRecorder.open({ dbPath, epoch: 1 })
  const log = TxnLog.open({ dir: primaryDir, fsync: "never" })
  const applier = new WalApplier({
    dbPath: replicaPath,
    dir: replicaDir,
    ...(mechanism ? { mechanism } : {}),
  })
  applier.seed({
    txid: 0n,
    epoch: 1,
    postChecksum: base.checksum,
    dbSizePages: base.pages,
    pageSize: base.pageSize,
  })
  // Opened before the first apply on purpose.
  const reader = Database.open(replicaPath, { readonly: true })

  return { root, primaryDir, replicaDir, db, dbPath, replicaPath, recorder, log, applier, reader }
}

function closeRig(r: Rig): void {
  r.reader.close()
  r.applier.close()
  r.log.close()
  r.recorder.close()
  r.db.close()
}

function walSize(dbPath: string): number {
  try {
    return fs.statSync(`${dbPath}-wal`).size
  } catch {
    return 0
  }
}

/** Tails, logs, re-decodes and applies every transaction that has committed. Returns the txids. */
function ship(r: Rig): bigint[] {
  const shipped: bigint[] = []
  for (const input of r.recorder.poll()) {
    const bytes = r.log.append(input)
    // Decode from the bytes, so the wire format is on the path rather than the in-memory object.
    r.applier.apply(decode(bytes).record)
    shipped.push(input.txid)
  }
  return shipped
}

describe("primary to replica", () => {
  test("a randomised workload replicates exactly, round by round", () => {
    const r = rig()
    const random = rng(0x5eed1234)
    const pick = (n: number) => Math.floor(random() * n)

    const insertUser = r.db.prepare("insert into users(name, score) values (?, ?)")
    const insertNote = r.db.prepare("insert into notes(user_id, body) values (?, ?)")
    let ddl = 0
    let checkpoints = 0
    let txids = 0

    for (let round = 0; round < 40; round++) {
      r.db.transaction(() => {
        switch (pick(6)) {
          case 0:
            // Multi-page transaction.
            for (let i = 0; i < 60; i++) insertNote.run(pick(50) + 1, "n".repeat(180) + round + i)
            break
          case 1:
            for (let i = 0; i < 8; i++) insertUser.run(`user-${round}-${i}`, random() * 100)
            break
          case 2:
            r.db.run("update users set score = score + 1 where id % 3 = ?", [pick(3)])
            break
          case 3:
            r.db.run("delete from notes where id % 7 = ?", [pick(7)])
            break
          case 4:
            // DDL inside the stream, plus rows into the new table.
            ddl += 1
            r.db.exec(`create table extra_${ddl}(id integer primary key, v text)`)
            r.db.run(`insert into extra_${ddl}(v) values (?)`, [`seed-${round}`])
            break
          default:
            for (let i = 0; i < 3; i++) insertUser.run(`u${round}_${i}`, round)
            insertNote.run(1, `note-${round}`)
            break
        }
      })()

      txids += ship(r).length

      // Occasional checkpoints on the primary, in every mode. PASSIVE leaves the salts alone;
      // RESTART and TRUNCATE reset the WAL and the tailer has to follow.
      if (round % 11 === 3) {
        r.db.walCheckpoint(["PASSIVE", "RESTART", "TRUNCATE"][checkpoints % 3] as "PASSIVE")
        checkpoints += 1
      }

      expect(dump(r.reader)).toBe(dump(r.db))
      expect(r.reader.prepare("pragma integrity_check").get()?.integrity_check).toBe("ok")
    }

    // A round whose statement matched no rows commits without writing a page, so it produces no
    // transaction to replicate and the txid does not advance. That is the intended behaviour.
    expect(txids).toBeGreaterThan(30)
    expect(txids).toBeLessThanOrEqual(40)
    expect(ddl).toBeGreaterThan(0)
    expect(checkpoints).toBeGreaterThanOrEqual(3)
    expect(r.applier.position.txid).toBe(BigInt(txids))
    expect(r.applier.position.postChecksum).toBe(r.recorder.position.checksum)
    expect(r.applier.verify()).toBe(true)
    expect(computeFull(r.replicaPath).checksum).toBe(computeFull(r.dbPath).checksum)

    closeRig(r)
  })

  // Both mechanisms of design §4.5, because this is the one test whose setup can see which one
  // ran: mechanism B grows the replica's own WAL and needs the checkpoint, mechanism A keeps that
  // WAL at zero bytes and the checkpoint is a truthful no-op. The stream must survive either way.
  test.each(["wal", "pages"] as const)(
    "a replica checkpoint mid-stream does not break the stream (%s)",
    (mechanism) => {
      const r = rig(mechanism)
      const insert = r.db.prepare("insert into users(name, score) values (?, ?)")
      for (let i = 0; i < 15; i++) {
        r.db.transaction(() => insert.run(`before-${i}`, i))()
        ship(r)
      }
      const walBefore = fs.statSync(`${r.replicaPath}-wal`).size
      if (mechanism === "wal") expect(walBefore).toBeGreaterThan(1000)
      else expect(walBefore).toBe(0)

      // The reader holds no open transaction here, which is the caller's half of the contract.
      const result = r.applier.checkpoint("TRUNCATE")
      expect(result.busy).toBe(false)
      expect(fs.statSync(`${r.replicaPath}-wal`).size).toBeLessThanOrEqual(walBefore)

      for (let i = 0; i < 10; i++) {
        r.db.transaction(() => insert.run(`after-${i}`, i))()
        ship(r)
      }

      expect(dump(r.reader)).toBe(dump(r.db))
      expect(r.reader.prepare("select count(*) c from users").get()?.c).toBe(25)
      expect(r.applier.verify()).toBe(true)
      expect(integrityOk(r.replicaPath)).toBe(true)
      closeRig(r)
    },
  )

  test("a primary WAL reset mid-stream loses nothing", () => {
    const r = rig()
    const insert = r.db.prepare("insert into users(name, score) values (?, ?)")
    for (let i = 0; i < 5; i++) {
      r.db.transaction(() => insert.run(`a${i}`, i))()
      ship(r)
    }
    r.db.walCheckpoint("TRUNCATE")
    const saltBefore = r.recorder.position.wal.salt1

    for (let i = 0; i < 5; i++) {
      r.db.transaction(() => insert.run(`b${i}`, i))()
      ship(r)
    }
    expect(r.recorder.position.wal.salt1).toBe(saltBefore + 1)
    expect(r.applier.position.txid).toBe(10n)
    expect(dump(r.reader)).toBe(dump(r.db))
    closeRig(r)
  })
})

describe("crash reconcile", () => {
  test("resuming from a persisted position replays exactly the missed transactions", () => {
    const r = rig()
    const insert = r.db.prepare("insert into users(name, score) values (?, ?)")
    for (let i = 0; i < 6; i++) {
      r.db.transaction(() => insert.run(`live-${i}`, i))()
      ship(r)
    }
    // What the tenant owner persists after every batch.
    const saved = r.recorder.position
    expect(saved.txid).toBe(6n)

    // Committed while the recorder was down, so the database is ahead of the log.
    for (let i = 0; i < 4; i++) r.db.transaction(() => insert.run(`lost-${i}`, i))()
    r.recorder.close()

    const resumed = TxnRecorder.open({
      dbPath: r.dbPath,
      epoch: saved.epoch,
      txid: saved.txid,
      checksum: saved.checksum,
      dbSizePages: saved.dbSizePages,
      walPosition: saved.wal,
    })
    expect(resumed.walRestore).toBe("resumed")

    const caught = resumed.poll()
    expect(caught.map((x) => x.txid)).toEqual([7n, 8n, 9n, 10n])
    expect(caught[0]?.prevTxid).toBe(6n)
    for (const input of caught) r.applier.apply(decode(r.log.append(input)).record)

    // Nothing repeated, nothing skipped: the log is a dense 1..10 and the replica agrees.
    expect(r.log.lastTxid).toBe(10n)
    expect([...r.log.iterate(1n)].map((x) => x.txid)).toEqual(
      Array.from({ length: 10 }, (_, i) => BigInt(i + 1)),
    )
    expect(resumed.poll()).toEqual([])
    expect(dump(r.reader)).toBe(dump(r.db))
    expect(r.applier.position.postChecksum).toBe(resumed.position.checksum)

    resumed.close()
    r.recorder = resumed
    closeRig(r)
  })

  test("a WAL reset while the recorder was down is reported rather than guessed at", () => {
    const r = rig()
    const insert = r.db.prepare("insert into users(name, score) values (?, ?)")
    for (let i = 0; i < 3; i++) {
      r.db.transaction(() => insert.run(`x${i}`, i))()
      ship(r)
    }
    const saved = r.recorder.position
    r.recorder.close()
    r.db.walCheckpoint("TRUNCATE")
    r.db.transaction(() => insert.run("after-reset", 0))()

    const resumed = TxnRecorder.open({
      dbPath: r.dbPath,
      epoch: saved.epoch,
      txid: saved.txid,
      checksum: saved.checksum,
      dbSizePages: saved.dbSizePages,
      walPosition: saved.wal,
    })
    expect(resumed.walRestore).toBe("reset")

    // Everything up to the saved txid is in the database file now, so the saved checksum still
    // describes it and streaming carries on from frame 1 of the new generation.
    const caught = resumed.poll()
    expect(caught.map((x) => x.txid)).toEqual([4n])
    r.applier.apply(decode(r.log.append(caught[0] as TxnRecordInput)).record)
    expect(dump(r.reader)).toBe(dump(r.db))

    resumed.close()
    r.recorder = resumed
    closeRig(r)
  })
})

describe("divergence is refused", () => {
  test("a record that does not follow the replica raises PositionMismatch", () => {
    const r = rig()
    r.db.transaction(() => r.db.run("insert into users(name) values ('a')"))()
    const [first] = r.recorder.poll()
    if (!first) throw new Error("nothing to ship")
    r.applier.apply(decode(encode(first)).record)

    const skipped = decode(encode({ ...first, txid: 3n, prevTxid: 2n })).record
    expect(() => r.applier.apply(skipped)).toThrow(PositionMismatch)
    try {
      r.applier.apply(skipped)
    } catch (error) {
      expect((error as PositionMismatch).expected).toBe(1n)
      expect((error as PositionMismatch).received).toBe(2n)
    }
    // Replaying an already-applied record is the same error, not a silent double apply.
    expect(() => r.applier.apply(decode(encode(first)).record)).toThrow(PositionMismatch)
    expect(r.applier.position.txid).toBe(1n)
    closeRig(r)
  })

  test("a record whose pages do not produce its postChecksum is refused before anything is written", () => {
    const r = rig()
    r.db.transaction(() => r.db.run("insert into users(name) values ('a')"))()
    const [first] = r.recorder.poll()
    if (!first) throw new Error("nothing to ship")

    const walBefore = walSize(r.replicaPath)
    const tampered = decode(encode({ ...first, postChecksum: first.postChecksum ^ 0xffn })).record
    expect(() => r.applier.apply(tampered)).toThrow(ChecksumMismatch)
    try {
      r.applier.apply(tampered)
    } catch (error) {
      expect((error as ChecksumMismatch).phase).toBe("post")
      expect((error as ChecksumMismatch).txid).toBe(1n)
    }
    expect(r.applier.position.txid).toBe(0n)
    expect(walSize(r.replicaPath)).toBe(walBefore)

    // A wrong pre-image checksum is caught first, and names itself.
    const wrongPre = decode(encode({ ...first, preChecksum: first.preChecksum ^ 0x99n })).record
    try {
      r.applier.apply(wrongPre)
      throw new Error("expected a ChecksumMismatch")
    } catch (error) {
      expect(error).toBeInstanceOf(ChecksumMismatch)
      expect((error as ChecksumMismatch).phase).toBe("pre")
    }

    // The untouched record still applies, so the rejection really did leave no trace.
    r.applier.apply(decode(encode(first)).record)
    expect(dumpFile(r.replicaPath)).toBe(dump(r.db))
    closeRig(r)
  })
})
