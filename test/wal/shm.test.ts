// The wal-index header format. The interesting assertion is the last one: a header this module
// built is one SQLite reads without running recovery, which is the whole premise of mechanism A.

import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "../../src/sqlite/index.ts"
import {
  encodeCkptInfo,
  encodeWalIndexHeader,
  READMARK_NOT_USED,
  readWalIndexHeader,
  WAL_NREADER,
  WALINDEX_CKPT_OFFSET,
  WALINDEX_HDR_COPY_SIZE,
  WALINDEX_HDR_SIZE,
  WALINDEX_LOCK_OFFSET,
  WALINDEX_MAX_VERSION,
  walIndexChecksum,
  walIndexHeaderValid,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, openPrimary, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

describe("wal-index header", () => {
  test("round-trips every field", () => {
    const bytes = encodeWalIndexHeader({ iChange: 7, pageSize: 4096, mxFrame: 0, nPage: 12 })
    expect(bytes.byteLength).toBe(WALINDEX_HDR_COPY_SIZE)
    const header = readWalIndexHeader(bytes)
    expect(header).not.toBeNull()
    expect(header?.iVersion).toBe(WALINDEX_MAX_VERSION)
    expect(header?.iChange).toBe(7)
    expect(header?.isInit).toBe(true)
    expect(header?.bigEndCksum).toBe(false)
    expect(header?.pageSize).toBe(4096)
    expect(header?.mxFrame).toBe(0)
    expect(header?.nPage).toBe(12)
    expect(walIndexHeaderValid(bytes)).toBe(true)
  })

  test("a 64 KiB page size is stored as 1, as SQLite spells it", () => {
    const bytes = encodeWalIndexHeader({ iChange: 1, pageSize: 65536, nPage: 2 })
    expect(new DataView(bytes.buffer).getUint16(14, true)).toBe(1)
    expect(readWalIndexHeader(bytes)?.pageSize).toBe(65536)
  })

  test("a flipped bit fails the checksum, and isInit = 0 reads as 'no header yet'", () => {
    const bytes = encodeWalIndexHeader({ iChange: 3, pageSize: 4096, nPage: 5 })
    bytes[20] = (bytes[20] as number) ^ 1
    expect(walIndexHeaderValid(bytes)).toBe(false)
    expect(readWalIndexHeader(new Uint8Array(WALINDEX_HDR_COPY_SIZE))).toBeNull()
  })

  test("the checksum is the s1/s2 chain over the first 40 bytes, seeded from zero", () => {
    const bytes = encodeWalIndexHeader({ iChange: 9, pageSize: 4096, nPage: 3 })
    const [c1, c2] = walIndexChecksum(bytes, 0, 40)
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(40, true)).toBe(c1)
    expect(view.getUint32(44, true)).toBe(c2)
  })

  test("the checkpoint block frees every read mark but slot 0, and stops at the lock bytes", () => {
    const ckpt = encodeCkptInfo()
    expect(ckpt.byteLength).toBe(WALINDEX_LOCK_OFFSET - WALINDEX_CKPT_OFFSET)
    const view = new DataView(ckpt.buffer)
    expect(view.getUint32(0, true)).toBe(0) // nBackfill
    expect(view.getUint32(4, true)).toBe(0) // aReadMark[0] is always 0
    for (let i = 1; i < WAL_NREADER; i++) {
      expect(view.getUint32(4 + i * 4, true)).toBe(READMARK_NOT_USED)
    }
  })

  test("SQLite accepts a header this module wrote, and reads the database through it", () => {
    const dir = tempDir("bunql-shm-")
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    db.walCheckpoint("TRUNCATE")
    // One read maps the wal-index, so the `-shm` exists to be rewritten.
    db.exec("select count(*) from t")

    const shmPath = `${dbPath}-shm`
    const before = new Uint8Array(WALINDEX_HDR_COPY_SIZE)
    const fd = fs.openSync(shmPath, "r+")
    fs.readSync(fd, before, 0, WALINDEX_HDR_COPY_SIZE, 0)
    const previous = readWalIndexHeader(before)
    expect(previous).not.toBeNull()
    const pages = Math.floor(fs.statSync(dbPath).size / (previous?.pageSize ?? 4096))

    const header = encodeWalIndexHeader({
      iChange: (previous?.iChange ?? 0) + 1,
      pageSize: previous?.pageSize ?? 4096,
      mxFrame: 0,
      nPage: pages,
    })
    const second = new Uint8Array(WALINDEX_LOCK_OFFSET - WALINDEX_HDR_COPY_SIZE)
    second.set(header, 0)
    second.set(encodeCkptInfo(0), WALINDEX_CKPT_OFFSET - WALINDEX_HDR_COPY_SIZE)
    fs.writeSync(fd, second, 0, second.byteLength, WALINDEX_HDR_COPY_SIZE)
    fs.writeSync(fd, header, 0, WALINDEX_HDR_COPY_SIZE, 0)
    fs.closeSync(fd)

    // A connection opened after the rewrite reads the database through the header we wrote. What
    // proves SQLite accepted it rather than recovering over it is that the header is still ours
    // afterwards, iChange and all.
    const reader = Database.open(dbPath, { readonly: true })
    expect(reader.prepare("select count(*) c from t").get()?.c).toBe(3)
    reader.close()

    const after = new Uint8Array(WALINDEX_HDR_SIZE)
    const check = fs.openSync(shmPath, "r")
    fs.readSync(check, after, 0, WALINDEX_HDR_SIZE, 0)
    fs.closeSync(check)
    const live = readWalIndexHeader(after)
    expect(live?.iChange).toBe((previous?.iChange ?? 0) + 1)
    expect(live?.mxFrame).toBe(0)
    expect(live?.nPage).toBe(pages)
    // Both copies still agree, which is what a reader checks before it trusts either.
    expect(after.subarray(0, WALINDEX_HDR_COPY_SIZE)).toEqual(
      after.subarray(WALINDEX_HDR_COPY_SIZE, WALINDEX_HDR_COPY_SIZE * 2),
    )
    expect(fs.statSync(path.join(dir, "main.db-wal")).size).toBe(0)
    db.close()
  })
})
