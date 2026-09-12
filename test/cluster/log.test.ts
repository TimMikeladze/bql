// The durable half: appending, reading back, truncating at a conflict, and reopening a file whose
// tail a crash tore off.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { encodeEntry, RaftLog } from "../../src/cluster/log.ts"
import type { LogEntry, RaftSnapshot } from "../../src/cluster/raft.ts"
import { emptyState, encodeSnapshot } from "../../src/cluster/state.ts"

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-raft-"))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

function entry(index: number, term: number, text = `entry-${index}`): LogEntry {
  return { index, term, kind: "command", data: new TextEncoder().encode(text) }
}

describe("the raft log", () => {
  test("appends and reads back across a reopen", () => {
    const dir = tempDir()
    const log = RaftLog.open({ dir })
    log.setHardState({ term: 4, votedFor: "n2" })
    log.append([entry(1, 1), entry(2, 1), entry(3, 4)])
    expect(log.lastIndex).toBe(3)
    log.close()

    const reopened = RaftLog.open({ dir })
    expect(reopened.hardState).toEqual({ term: 4, votedFor: "n2" })
    expect(reopened.entries.map((e) => [e.index, e.term])).toEqual([
      [1, 1],
      [2, 1],
      [3, 4],
    ])
    expect(new TextDecoder().decode(reopened.entries[2]?.data)).toBe("entry-3")
    expect(reopened.repaired).toBe(false)
    reopened.close()
  })

  test("refuses an entry that does not continue the log", () => {
    const dir = tempDir()
    const log = RaftLog.open({ dir })
    log.append([entry(1, 1)])
    expect(() => log.append([entry(3, 1)])).toThrow(/does not follow it/)
    log.close()
  })

  test("truncates at an index and stays truncated after a reopen", () => {
    const dir = tempDir()
    const log = RaftLog.open({ dir })
    log.append([entry(1, 1), entry(2, 1), entry(3, 1), entry(4, 1)])
    log.truncate(3)
    expect(log.lastIndex).toBe(2)
    log.append([entry(3, 9, "replacement")])
    log.close()

    const reopened = RaftLog.open({ dir })
    expect(reopened.entries.map((e) => e.term)).toEqual([1, 1, 9])
    expect(new TextDecoder().decode(reopened.entries[2]?.data)).toBe("replacement")
    reopened.close()
  })

  test("a torn trailing record is discarded rather than trusted", () => {
    const dir = tempDir()
    const log = RaftLog.open({ dir })
    log.append([entry(1, 1), entry(2, 1), entry(3, 1)])
    const bytes = log.bytes
    log.close()

    // Half of the last record makes it to disk, which is all a crash can ever do here.
    const file = path.join(dir, "entries.log")
    const whole = encodeEntry(entry(3, 1))
    fs.truncateSync(file, bytes - Math.floor(whole.byteLength / 2))

    const reopened = RaftLog.open({ dir })
    expect(reopened.repaired).toBe(true)
    expect(reopened.lastIndex).toBe(2)
    // And the file is cut back, so the next append lands where it should.
    reopened.append([entry(3, 7)])
    reopened.close()
    expect(RaftLog.open({ dir }).entries.map((e) => e.term)).toEqual([1, 1, 7])
  })

  test("a record whose payload was corrupted is treated as a torn tail", () => {
    const dir = tempDir()
    const log = RaftLog.open({ dir })
    log.append([entry(1, 1), entry(2, 1)])
    log.close()

    const file = path.join(dir, "entries.log")
    const raw = fs.readFileSync(file)
    raw[raw.byteLength - 1] = (raw[raw.byteLength - 1] as number) ^ 0xff
    fs.writeFileSync(file, raw)

    const reopened = RaftLog.open({ dir })
    expect(reopened.repaired).toBe(true)
    expect(reopened.lastIndex).toBe(1)
    reopened.close()
  })

  test("a snapshot compacts the entries it covers and survives a reopen", () => {
    const dir = tempDir()
    const log = RaftLog.open({ dir })
    log.append([entry(1, 1), entry(2, 1), entry(3, 2), entry(4, 2)])
    const snapshot: RaftSnapshot = {
      index: 3,
      term: 2,
      config: ["n1", "n2", "n3"],
      learners: ["r1"],
      data: encodeSnapshot(emptyState()),
    }
    log.saveSnapshot(snapshot)
    expect(log.firstIndex).toBe(4)
    expect(log.entries.map((e) => e.index)).toEqual([4])
    log.append([entry(5, 2)])
    log.close()

    const reopened = RaftLog.open({ dir })
    expect(reopened.snapshot?.index).toBe(3)
    expect(reopened.snapshot?.config).toEqual(["n1", "n2", "n3"])
    expect(reopened.snapshot?.learners).toEqual(["r1"])
    expect(reopened.entries.map((e) => e.index)).toEqual([4, 5])
    reopened.close()
  })

  test("installing a snapshot throws the log away", () => {
    const dir = tempDir()
    const log = RaftLog.open({ dir })
    log.append([entry(1, 1), entry(2, 1)])
    log.installSnapshot({
      index: 40,
      term: 6,
      config: ["n1"],
      learners: [],
      data: encodeSnapshot(emptyState()),
    })
    expect(log.entries).toHaveLength(0)
    expect(log.firstIndex).toBe(41)
    log.append([entry(41, 6)])
    log.close()
    expect(RaftLog.open({ dir }).entries.map((e) => e.index)).toEqual([41])
  })

  test("a torn metadata file costs the vote, not the log", () => {
    const dir = tempDir()
    const log = RaftLog.open({ dir })
    log.setHardState({ term: 9, votedFor: "n3" })
    log.append([entry(1, 9)])
    log.close()

    const meta = path.join(dir, "meta")
    const raw = fs.readFileSync(meta)
    raw[raw.byteLength - 2] = (raw[raw.byteLength - 2] as number) ^ 0xff
    fs.writeFileSync(meta, raw)

    const reopened = RaftLog.open({ dir })
    expect(reopened.hardState).toEqual({ term: 0, votedFor: null })
    expect(reopened.entries).toHaveLength(1)
    reopened.close()
  })
})
