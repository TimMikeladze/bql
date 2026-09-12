// The tailer's contract, stated as tests: it emits whole committed transactions and nothing else,
// it never advances past a commit frame, and a saved position resumes exactly where it left off.

import fs from "node:fs"
import { afterAll, describe, expect, test } from "bun:test"
import {
  parseWalHeader,
  WAL_HEADER_SIZE,
  WalFormatError,
  WalTailer,
  walFrameOffset,
  walFrameSize,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, openPrimary, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

describe("polling", () => {
  test("emits one transaction per commit, with the last version of each page", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    const tailer = new WalTailer(`${dbPath}-wal`)
    // Everything written so far is one transaction (the CREATE TABLE).
    expect(tailer.poll().length).toBe(1)

    const insert = db.prepare("insert into t(v) values (?)")
    db.transaction(() => {
      for (let i = 0; i < 3; i++) insert.run(`a${i}`)
    })()
    db.transaction(() => insert.run("b"))()

    const txns = tailer.poll()
    expect(txns.length).toBe(2)
    for (const txn of txns) {
      expect(txn.commitSize).toBeGreaterThan(0)
      expect(txn.pages.length).toBe(txn.frames.size)
      expect(txn.pages).toEqual([...txn.pages].sort((a, b) => a - b))
      expect(txn.frameCount).toBeGreaterThanOrEqual(txn.pages.length)
      expect(txn.afterReset).toBe(false)
    }
    expect(tailer.poll().length).toBe(0)

    db.close()
    tailer.close()
  })

  test("a page written twice in one transaction appears once, at its last version", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    // A ten-page cache (SQLite's floor) makes a large transaction spill dirty pages into the WAL
    // mid-transaction; touching them again afterwards writes them a second time, which is the
    // only way one transaction writes the same page twice.
    db.exec("pragma cache_size = 10")
    db.exec("create table t(id integer primary key, v text)")
    const insert = db.prepare("insert into t(v) values (?)")
    db.transaction(() => {
      for (let i = 0; i < 8000; i++) insert.run("p".repeat(150))
    })()
    db.walCheckpoint("TRUNCATE")

    const tailer = new WalTailer(`${dbPath}-wal`)
    db.transaction(() => {
      db.run("update t set v = 'w' where id % 3 = 0")
      db.run("update t set v = 'e' where id % 5 = 0")
    })()

    const txns = tailer.poll()
    expect(txns.length).toBe(1)
    const txn = txns[0]
    if (!txn) throw new Error("no transaction")
    expect(txn.frameCount).toBeGreaterThan(txn.frames.size)
    expect(txn.frames.size).toBe(txn.pages.length)
    // Every page in the map is the newest image, so replaying the map alone reproduces the
    // database: the replication test proves that end to end.
    for (const page of txn.frames.values()) expect(page.byteLength).toBe(txn.pageSize)

    db.close()
    tailer.close()
  })

  test("a rolled-back transaction never reaches the stream", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    // A tiny page cache forces the aborted transaction to spill real frames into the WAL, which
    // is the case the commit-frame rule exists for.
    db.exec("pragma cache_size = 2")
    db.exec("create table t(id integer primary key, v text)")
    db.walCheckpoint("TRUNCATE")

    const tailer = new WalTailer(`${dbPath}-wal`)
    const before = tailer.position

    db.exec("begin")
    const insert = db.prepare("insert into t(v) values (?)")
    for (let i = 0; i < 500; i++) insert.run("q".repeat(200))
    const walSize = fs.statSync(`${dbPath}-wal`).size
    db.exec("rollback")

    expect(walSize).toBeGreaterThan(WAL_HEADER_SIZE)
    expect(tailer.poll()).toEqual([])
    expect(tailer.position.frame).toBe(before.frame)

    // The slots the aborted transaction used are reused by the next one, and the tailer reads it.
    db.transaction(() => insert.run("kept"))()
    const txns = tailer.poll()
    expect(txns.length).toBe(1)
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(1)

    db.close()
    tailer.close()
  })

  test("a half-written frame at the end of the WAL is ignored until it is whole", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    const tailer = new WalTailer(`${dbPath}-wal`)
    tailer.poll()
    db.transaction(() => db.run("insert into t(v) values ('x')"))()
    expect(tailer.poll().length).toBe(1)
    const settled = tailer.position

    // Simulate the tail of a frame that is still being written.
    const fd = fs.openSync(`${dbPath}-wal`, "r+")
    const size = fs.fstatSync(fd).size
    fs.writeSync(fd, new Uint8Array(100).fill(0xcc), 0, 100, size)
    fs.closeSync(fd)

    expect(tailer.poll()).toEqual([])
    expect(tailer.position).toEqual(settled)

    db.close()
    tailer.close()
  })

  test("garbage in a whole frame slot stops the scan without corrupting the position", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    db.walCheckpoint("TRUNCATE")
    const tailer = new WalTailer(`${dbPath}-wal`)
    db.transaction(() => db.run("insert into t(v) values ('x')"))()
    expect(tailer.poll().length).toBe(1)
    const settled = tailer.position

    const header = parseWalHeader(new Uint8Array(fs.readFileSync(`${dbPath}-wal`)))
    if (!header) throw new Error("no header")
    const fd = fs.openSync(`${dbPath}-wal`, "r+")
    const next = walFrameOffset(settled.frame + 1, header.pageSize)
    const garbage = new Uint8Array(walFrameSize(header.pageSize)).fill(0x11)
    fs.writeSync(fd, garbage, 0, garbage.byteLength, next)
    fs.closeSync(fd)

    expect(tailer.poll()).toEqual([])
    expect(tailer.position).toEqual(settled)

    db.close()
    tailer.close()
  })
})

describe("wal reset", () => {
  test("a RESTART checkpoint is followed without a gap", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    const tailer = new WalTailer(`${dbPath}-wal`)
    tailer.poll()

    const insert = db.prepare("insert into t(v) values (?)")
    db.transaction(() => insert.run("before"))()
    const before = tailer.poll()
    expect(before.length).toBe(1)
    const oldSalt = tailer.position.salt1

    db.walCheckpoint("RESTART")
    db.transaction(() => insert.run("after"))()

    const after = tailer.poll()
    expect(after.length).toBe(1)
    const txn = after[0]
    if (!txn) throw new Error("no transaction")
    expect(txn.afterReset).toBe(true)
    expect(txn.walSalt1).toBe(oldSalt + 1)
    expect(tailer.position.frame).toBeLessThan(before[0]?.walEndFrame ?? 0)

    db.close()
    tailer.close()
  })

  test("a TRUNCATE checkpoint is followed without a gap", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    const tailer = new WalTailer(`${dbPath}-wal`)
    tailer.poll()

    const insert = db.prepare("insert into t(v) values (?)")
    db.transaction(() => insert.run("one"))()
    expect(tailer.poll().length).toBe(1)

    db.walCheckpoint("TRUNCATE")
    expect(fs.statSync(`${dbPath}-wal`).size).toBeLessThan(WAL_HEADER_SIZE + 1)
    expect(tailer.poll()).toEqual([])

    db.transaction(() => insert.run("two"))()
    db.transaction(() => insert.run("three"))()
    const txns = tailer.poll()
    expect(txns.length).toBe(2)
    expect(txns[0]?.afterReset).toBe(true)
    expect(txns[1]?.afterReset).toBe(false)

    db.close()
    tailer.close()
  })
})

describe("saved positions", () => {
  test("a fresh tailer resumes exactly where the old one stopped", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    const insert = db.prepare("insert into t(v) values (?)")

    const first = new WalTailer(`${dbPath}-wal`)
    first.poll()
    for (let i = 0; i < 5; i++) db.transaction(() => insert.run(`a${i}`))()
    expect(first.poll().length).toBe(5)
    const saved = first.position
    first.close()

    // Committed while nobody was tailing.
    for (let i = 0; i < 4; i++) db.transaction(() => insert.run(`b${i}`))()

    const second = new WalTailer(`${dbPath}-wal`)
    expect(second.restore(saved)).toBe("resumed")
    expect(second.position).toEqual(saved)
    const caught = second.poll()
    expect(caught.length).toBe(4)
    expect(second.poll()).toEqual([])

    db.close()
    second.close()
  })

  test("a position from a previous WAL generation reports a reset", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    const tailer = new WalTailer(`${dbPath}-wal`)
    tailer.poll()
    db.transaction(() => db.run("insert into t(v) values ('x')"))()
    tailer.poll()
    const saved = tailer.position
    tailer.close()

    db.walCheckpoint("TRUNCATE")
    db.transaction(() => db.run("insert into t(v) values ('y')"))()

    const fresh = new WalTailer(`${dbPath}-wal`)
    expect(fresh.restore(saved)).toBe("reset")
    const txns = fresh.poll()
    expect(txns.length).toBe(1)
    expect(txns[0]?.afterReset).toBe(true)

    db.close()
    fresh.close()
  })

  test("a position past the end of its own generation is refused", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key)")
    const tailer = new WalTailer(`${dbPath}-wal`)
    tailer.poll()
    const saved = tailer.position
    tailer.close()

    const fresh = new WalTailer(`${dbPath}-wal`)
    expect(() => fresh.restore({ ...saved, frame: saved.frame + 50 })).toThrow(WalFormatError)

    db.close()
    fresh.close()
  })
})
