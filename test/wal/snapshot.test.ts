// Snapshots and point-in-time restore. The real assertion is the one in the middle: a database
// restored to a middle txid is exactly the state the primary was in at that txid, compared
// against a dump taken at the time rather than against itself.

import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import {
  computeFull,
  listSnapshots,
  removeSnapshot,
  restore,
  snapshot,
  type SnapshotRef,
  TxnLog,
  TxnRecorder,
  WalError,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, dump, dumpFile, integrityOk, openPrimary, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

interface Marks {
  root: string
  dir: string
  dbPath: string
  /** txid -> the primary's full dump right after that txid was recorded. */
  dumps: Map<bigint, string>
  lastTxid: bigint
  liveDump: string
  snapshots: SnapshotRef[]
  checksums: Map<bigint, bigint>
}

/**
 * A primary that writes 30 transactions, snapshotting after the named rounds, and remembering what
 * it looked like after every one of them. The snapshots are taken inside the loop, which is the
 * only way the contract holds: the writer is this loop, and it is not writing while `snapshot`
 * checkpoints and copies.
 */
async function history(snapshotAfterRounds: number[] = [12]): Promise<Marks> {
  const root = tempDir()
  const dir = path.join(root, "tenant")
  fs.mkdirSync(dir)
  const { db, dbPath } = openPrimary(dir)
  db.exec("create table t(id integer primary key, v text, n real)")
  db.walCheckpoint("TRUNCATE")

  const recorder = TxnRecorder.open({ dbPath, epoch: 2 })
  const log = TxnLog.open({ dir, fsync: "never" })
  const insert = db.prepare("insert into t(v, n) values (?, ?)")
  const dumps = new Map<bigint, string>()
  const checksums = new Map<bigint, bigint>()
  const snapshots: SnapshotRef[] = []

  for (let round = 0; round < 30; round++) {
    db.transaction(() => {
      for (let i = 0; i < 6; i++) insert.run(`r${round}-${i}-${"m".repeat(80)}`, round + i / 10)
      if (round % 5 === 4) db.run("delete from t where id % 9 = 0")
    })()
    for (const input of recorder.poll()) log.append(input)
    dumps.set(recorder.position.txid, dump(db))
    checksums.set(recorder.position.txid, recorder.position.checksum)

    if (snapshotAfterRounds.includes(round)) {
      snapshots.push(await snapshot({ db, dbPath, dir }, recorder.position.txid, { epoch: 2 }))
    }
  }

  const lastTxid = recorder.position.txid
  const liveDump = dump(db)
  log.close()
  recorder.close()
  db.close()
  return { root, dir, dbPath, dumps, lastTxid, liveDump, snapshots, checksums }
}

/** The primary's dump right after `txid`, or a failure naming the txid rather than `undefined`. */
function dumpAt(marks: Marks, txid: bigint): string {
  const value = marks.dumps.get(txid)
  if (value === undefined) throw new Error(`no dump recorded for txid ${txid}`)
  return value
}

function checksumAt(marks: Marks, txid: bigint): bigint {
  const value = marks.checksums.get(txid)
  if (value === undefined) throw new Error(`no checksum recorded for txid ${txid}`)
  return value
}

describe("snapshots", () => {
  test("records the database at the txid the caller names", async () => {
    const marks = await history([12])
    const ref = marks.snapshots[0]
    if (!ref) throw new Error("no snapshot")
    const txid = BigInt(ref.txid)

    expect(ref.epoch).toBe(2)
    expect(ref.path).toBe(path.join(marks.dir, "snapshots", `${ref.txid.padStart(20, "0")}.db`))
    expect(BigInt(ref.checksum)).toBe(checksumAt(marks, txid))
    expect(dumpFile(ref.path)).toBe(dumpAt(marks, txid))
    expect(integrityOk(ref.path)).toBe(true)
    expect(computeFull(ref.path, { includeWal: false }).checksum).toBe(BigInt(ref.checksum))
    expect(listSnapshots(marks.dir).map((s) => s.txid)).toEqual([ref.txid])
  })

  test("the tailer keeps up across the reset the snapshot's checkpoint causes", async () => {
    const marks = await history([5, 20])
    // 30 rounds each wrote a transaction, and the two checkpoints in the middle did not cost one.
    expect(marks.lastTxid).toBe(30n)
    expect(marks.snapshots.map((s) => s.txid)).toEqual(["6", "21"])
    const log = TxnLog.open({ dir: marks.dir, fsync: "never" })
    expect([...log.iterate(1n)].map((r) => r.txid)).toEqual(
      Array.from({ length: 30 }, (_, i) => BigInt(i + 1)),
    )
    log.close()
  })

  test("deleting a snapshot removes the file and the index entry", async () => {
    const marks = await history([5, 20])
    expect(removeSnapshot(marks.dir, 6n)).toBe(true)
    expect(listSnapshots(marks.dir).map((s) => s.txid)).toEqual(["21"])
    expect(fs.existsSync(path.join(marks.dir, "snapshots", "00000000000000000006.db"))).toBe(false)
    expect(removeSnapshot(marks.dir, 999n)).toBe(false)
  })

  test("refuses to file a second snapshot under a txid it already holds", async () => {
    const root = tempDir()
    const dir = path.join(root, "tenant")
    fs.mkdirSync(dir)
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(a)")
    await snapshot({ db, dbPath, dir }, 1n)
    await expect(snapshot({ db, dbPath, dir }, 1n)).rejects.toThrow(WalError)
    db.close()
  })
})

describe("restore", () => {
  test("a middle txid restores to exactly the state the primary was in", async () => {
    const marks = await history([12])
    const ref = marks.snapshots[0]
    if (!ref) throw new Error("no snapshot")
    const from = BigInt(ref.txid)
    const at = from + 9n
    const expected = dumpAt(marks, at)
    expect(expected).toBeDefined()

    const into = path.join(marks.root, "restored")
    const result = await restore({ dir: marks.dir, at, into })

    expect(result.txid).toBe(at)
    expect(result.fromTxid).toBe(from)
    expect(result.applied).toBe(9)
    expect(result.path).toBe(path.join(into, "main.db"))
    expect(dumpFile(result.path)).toBe(expected)
    expect(integrityOk(result.path)).toBe(true)
    expect(result.checksum).toBe(checksumAt(marks, at))
    expect(computeFull(result.path).checksum).toBe(result.checksum)
  })

  test("restoring to the snapshot itself replays nothing", async () => {
    const marks = await history([12])
    const ref = marks.snapshots[0]
    if (!ref) throw new Error("no snapshot")
    const into = path.join(marks.root, "at-snapshot", "db.db")
    const result = await restore({ dir: marks.dir, at: BigInt(ref.txid), into })
    expect(result.applied).toBe(0)
    expect(result.path).toBe(into)
    expect(dumpFile(into)).toBe(dumpAt(marks, BigInt(ref.txid)))
  })

  test("restoring to the end of the log matches the primary's final state", async () => {
    const marks = await history([12])
    const into = path.join(marks.root, "latest")
    const result = await restore({ dir: marks.dir, at: marks.lastTxid, into })
    expect(result.txid).toBe(marks.lastTxid)
    expect(dumpFile(result.path)).toBe(marks.liveDump)
    expect(result.checksum).toBe(checksumAt(marks, marks.lastTxid))
  })

  test("picks the newest snapshot at or before the target", async () => {
    const marks = await history([5, 20])
    const [first, second] = marks.snapshots
    if (!first || !second) throw new Error("expected two snapshots")

    const early = await restore({
      dir: marks.dir,
      at: BigInt(first.txid) + 3n,
      into: path.join(marks.root, "early"),
    })
    expect(early.fromTxid).toBe(BigInt(first.txid))
    expect(dumpFile(early.path)).toBe(dumpAt(marks, BigInt(first.txid) + 3n))

    const late = await restore({
      dir: marks.dir,
      at: BigInt(second.txid) + 2n,
      into: path.join(marks.root, "late"),
    })
    expect(late.fromTxid).toBe(BigInt(second.txid))
    expect(late.applied).toBe(2)
    expect(dumpFile(late.path)).toBe(dumpAt(marks, BigInt(second.txid) + 2n))
  })

  test("a target older than every snapshot is refused", async () => {
    const marks = await history([12])
    await expect(
      restore({ dir: marks.dir, at: 2n, into: path.join(marks.root, "nope") }),
    ).rejects.toThrow(WalError)
  })

  test("a restored database is a normal database that can be written to", async () => {
    const marks = await history([12])
    const into = path.join(marks.root, "forked")
    const result = await restore({
      dir: marks.dir,
      at: BigInt(marks.snapshots[0]?.txid ?? "0") + 4n,
      into,
    })
    expect(result.applied).toBe(4)

    const forked = openPrimary(into, "main.db")
    forked.db.exec("insert into t(v, n) values ('forked', 1.0)")
    expect(forked.db.prepare("select count(*) c from t where v = 'forked'").get()?.c).toBe(1)
    expect(forked.db.prepare("pragma integrity_check").get()?.integrity_check).toBe("ok")
    forked.db.close()
  })
})
