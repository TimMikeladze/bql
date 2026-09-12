// Raft's durable half: `<dir>/meta`, `<dir>/entries.log` and `<dir>/snapshot`.
//
// Invariant: what this file says is on disk *is* on disk. Every mutating call fsyncs before it
// returns, and `meta` — the term and the vote — is written and fsynced before any entry that
// depends on it, because a node that answered a vote in term 7 and came back believing it was in
// term 6 would vote twice in one term. `raft.ts` hands its actions back with `persist` ahead of
// `send`; this module is the half that makes that ordering mean something.
//
// Second invariant: a crash can only tear the tail of `entries.log`. On open the file is walked
// record by record — header hash, body hash, and a dense ascending index starting at
// `snapshotIndex + 1` — and anything past the first record that fails is truncated away and
// flagged in `repaired`. The log always reopens as a clean prefix of what was durable, the same
// contract `src/wal/log.ts` gives the transaction log.
//
// Record layout (little-endian, as in `src/wal/record.ts`; this is our format, not SQLite's):
//
//   0   magic "BQLR"    4      24  dataLength u32   4
//   4   version u8      1      28  reserved u32     4
//   5   kind u8         1      32  dataHash u64     8   xxh3 of the payload
//   6   reserved u16    2      40  headerHash u64   8   xxh3 of bytes [0, 40)
//   8   index u64       8      48  data
//   16  term u64        8
//
// Compaction rewrites `entries.log` whole rather than keeping segments. `snapshotEntries` bounds
// the file at a few hundred records of a few hundred bytes, so a rewrite costs less than the
// bookkeeping a segmented log would need — the opposite trade to `src/wal/log.ts`, where a segment
// is 16 MB of page images.

import fs from "node:fs"
import path from "node:path"
import type { HardState, LogEntry, RaftSnapshot } from "./raft.ts"
import { ClusterFormatError, type NodeId } from "./state.ts"

/** "BQLR" read as a little-endian u32. */
const RECORD_MAGIC = 0x524c5142
const RECORD_VERSION = 1
const RECORD_HEADER_SIZE = 48

/** "BQLM", the metadata file. */
const META_MAGIC = 0x4d4c5142
const META_VERSION = 1

/** "BQLS", the snapshot file. */
const SNAPSHOT_MAGIC = 0x534c5142
const SNAPSHOT_VERSION = 1

const KINDS = ["noop", "command", "config"] as const
type Kind = (typeof KINDS)[number]

export interface RaftLogOptions {
  /** The cluster's own directory, usually `<dataDir>/cluster`. Created when missing. */
  dir: string
  /** Off only for a test that is measuring something other than the disk. Default on. */
  fsync?: boolean
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class RaftLog {
  readonly dir: string
  readonly fsync: boolean
  /** True when a torn tail was truncated away on open. */
  repaired = false

  #fd: number | null = null
  #entries: LogEntry[] = []
  /** Byte offset of each entry, plus a final entry for the end of the file. */
  #offsets: number[] = [0]
  #bytes = 0
  #hardState: HardState = { term: 0, votedFor: null }
  #snapshot: RaftSnapshot | null = null
  #closed = false

  private constructor(options: RaftLogOptions) {
    this.dir = options.dir
    this.fsync = options.fsync ?? true
  }

  static open(options: RaftLogOptions): RaftLog {
    const log = new RaftLog(options)
    fs.mkdirSync(log.dir, { recursive: true })
    log.#hardState = log.#readMeta()
    log.#snapshot = log.#readSnapshot()
    log.#scan()
    return log
  }

  get hardState(): HardState {
    return this.#hardState
  }

  get snapshot(): RaftSnapshot | null {
    return this.#snapshot
  }

  /** Entries after the snapshot, oldest first. */
  get entries(): readonly LogEntry[] {
    return this.#entries
  }

  get firstIndex(): number {
    return (this.#snapshot?.index ?? 0) + 1
  }

  get lastIndex(): number {
    return this.#entries.at(-1)?.index ?? this.#snapshot?.index ?? 0
  }

  get bytes(): number {
    return this.#bytes
  }

  /** Writes `{currentTerm, votedFor}` and fsyncs. Nothing that depends on it may go out first. */
  setHardState(hardState: HardState): void {
    this.#assertOpen()
    if (
      hardState.term === this.#hardState.term &&
      hardState.votedFor === this.#hardState.votedFor
    ) {
      return
    }
    this.#hardState = { term: hardState.term, votedFor: hardState.votedFor }
    this.#writeMeta()
  }

  /** Appends entries, which must continue the log densely. Fsyncs before returning. */
  append(entries: readonly LogEntry[]): void {
    this.#assertOpen()
    if (entries.length === 0) return
    const fd = this.#descriptor()
    let at = this.#bytes
    for (const entry of entries) {
      const expected = this.lastIndex + 1
      if (entry.index !== expected) {
        throw new ClusterFormatError(
          `raft log is at index ${this.lastIndex}, entry ${entry.index} does not follow it`,
        )
      }
      const bytes = encodeEntry(entry)
      fs.writeSync(fd, bytes, 0, bytes.byteLength, at)
      at += bytes.byteLength
      this.#entries.push(entry)
      this.#offsets.push(at)
      this.#bytes = at
    }
    this.#flush(fd)
  }

  /** Drops every entry at `fromIndex` and above. Fsyncs before returning. */
  truncate(fromIndex: number): void {
    this.#assertOpen()
    const keep = this.#entries.findIndex((entry) => entry.index >= fromIndex)
    if (keep === -1) return
    const bytes = this.#offsets[keep] as number
    const fd = this.#descriptor()
    fs.ftruncateSync(fd, bytes)
    this.#entries = this.#entries.slice(0, keep)
    this.#offsets = this.#offsets.slice(0, keep + 1)
    this.#bytes = bytes
    this.#flush(fd)
  }

  /**
   * Stores a snapshot and drops every entry it covers. The snapshot lands first: a crash between
   * the two leaves a snapshot and a log that overlaps it, which reopens correctly, where the
   * reverse order would leave a hole.
   */
  saveSnapshot(snapshot: RaftSnapshot): void {
    this.#assertOpen()
    this.#writeSnapshot(snapshot)
    this.#snapshot = snapshot
    const keep = this.#entries.findIndex((entry) => entry.index > snapshot.index)
    const survivors = keep === -1 ? [] : this.#entries.slice(keep)
    this.#rewrite(survivors)
  }

  /**
   * Throws the log away and starts again after `snapshot.index`. What a follower does when the
   * leader sends it a state it could not have reached by replaying entries.
   */
  installSnapshot(snapshot: RaftSnapshot): void {
    this.#assertOpen()
    this.#writeSnapshot(snapshot)
    this.#snapshot = snapshot
    this.#rewrite([])
  }

  close(): void {
    if (this.#closed) return
    this.#closeDescriptor()
    this.#closed = true
  }

  // ── files ────────────────────────────────────────────────────────────────────────────────────

  get #entriesPath(): string {
    return path.join(this.dir, "entries.log")
  }

  get #metaPath(): string {
    return path.join(this.dir, "meta")
  }

  get #snapshotPath(): string {
    return path.join(this.dir, "snapshot")
  }

  #assertOpen(): void {
    if (this.#closed) throw new ClusterFormatError("raft log is closed")
  }

  #descriptor(): number {
    if (this.#fd !== null) return this.#fd
    this.#fd = fs.openSync(this.#entriesPath, fs.existsSync(this.#entriesPath) ? "r+" : "w+")
    return this.#fd
  }

  #closeDescriptor(): void {
    if (this.#fd !== null) {
      fs.closeSync(this.#fd)
      this.#fd = null
    }
  }

  #flush(fd: number): void {
    if (this.fsync) fs.fsyncSync(fd)
  }

  /** Rewrites `entries.log` to hold exactly `entries`, through a temp file and a rename. */
  #rewrite(entries: readonly LogEntry[]): void {
    const parts: Uint8Array[] = []
    const offsets = [0]
    let at = 0
    for (const entry of entries) {
      const bytes = encodeEntry(entry)
      parts.push(bytes)
      at += bytes.byteLength
      offsets.push(at)
    }
    const out = new Uint8Array(at)
    let cursor = 0
    for (const part of parts) {
      out.set(part, cursor)
      cursor += part.byteLength
    }
    this.#closeDescriptor()
    writeFileDurably(this.#entriesPath, out, this.fsync)
    this.#entries = [...entries]
    this.#offsets = offsets
    this.#bytes = at
  }

  #writeMeta(): void {
    const vote = encoder.encode(this.#hardState.votedFor ?? "")
    const out = new Uint8Array(24 + vote.byteLength)
    const view = new DataView(out.buffer)
    view.setUint32(0, META_MAGIC, true)
    view.setUint8(4, META_VERSION)
    view.setUint16(6, vote.byteLength, true)
    view.setBigUint64(8, BigInt(this.#hardState.term), true)
    out.set(vote, 16)
    view.setBigUint64(
      16 + vote.byteLength,
      Bun.hash.xxHash3(out.subarray(0, 16 + vote.byteLength)),
      true,
    )
    writeFileDurably(this.#metaPath, out, this.fsync)
  }

  #readMeta(): HardState {
    let raw: Buffer
    try {
      raw = fs.readFileSync(this.#metaPath)
    } catch {
      return { term: 0, votedFor: null }
    }
    if (raw.byteLength < 24) return { term: 0, votedFor: null }
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    if (view.getUint32(0, true) !== META_MAGIC) {
      throw new ClusterFormatError(`${this.#metaPath} is not a raft metadata file`)
    }
    if (view.getUint8(4) !== META_VERSION) {
      throw new ClusterFormatError(`${this.#metaPath} is version ${view.getUint8(4)}, not ${META_VERSION}`)
    }
    const voteLength = view.getUint16(6, true)
    if (raw.byteLength !== 24 + voteLength) return { term: 0, votedFor: null }
    const stored = view.getBigUint64(16 + voteLength, true)
    if (Bun.hash.xxHash3(bytes.subarray(0, 16 + voteLength)) !== stored) {
      // Torn on the way out. The vote is lost, which costs at most one election: a node that comes
      // back not knowing whether it voted must start from "no vote in this term", and the term
      // itself going backwards is caught by the first message from anyone else.
      return { term: 0, votedFor: null }
    }
    const term = Number(view.getBigUint64(8, true))
    const votedFor = voteLength === 0 ? null : decoder.decode(bytes.subarray(16, 16 + voteLength))
    return { term, votedFor }
  }

  #writeSnapshot(snapshot: RaftSnapshot): void {
    const members = encoder.encode(
      JSON.stringify({ config: snapshot.config, learners: snapshot.learners }),
    )
    const length = 40 + members.byteLength + snapshot.data.byteLength
    const out = new Uint8Array(length)
    const view = new DataView(out.buffer)
    view.setUint32(0, SNAPSHOT_MAGIC, true)
    view.setUint8(4, SNAPSHOT_VERSION)
    view.setBigUint64(8, BigInt(snapshot.index), true)
    view.setBigUint64(16, BigInt(snapshot.term), true)
    view.setUint32(24, members.byteLength, true)
    view.setUint32(28, snapshot.data.byteLength, true)
    out.set(members, 32)
    out.set(snapshot.data, 32 + members.byteLength)
    view.setBigUint64(length - 8, Bun.hash.xxHash3(out.subarray(0, length - 8)), true)
    writeFileDurably(this.#snapshotPath, out, this.fsync)
  }

  #readSnapshot(): RaftSnapshot | null {
    let raw: Buffer
    try {
      raw = fs.readFileSync(this.#snapshotPath)
    } catch {
      return null
    }
    if (raw.byteLength < 40) return null
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    if (view.getUint32(0, true) !== SNAPSHOT_MAGIC) {
      throw new ClusterFormatError(`${this.#snapshotPath} is not a raft snapshot`)
    }
    if (view.getUint8(4) !== SNAPSHOT_VERSION) {
      throw new ClusterFormatError(
        `${this.#snapshotPath} is version ${view.getUint8(4)}, not ${SNAPSHOT_VERSION}`,
      )
    }
    const membersLength = view.getUint32(24, true)
    const dataLength = view.getUint32(28, true)
    if (raw.byteLength !== 40 + membersLength + dataLength) return null
    if (Bun.hash.xxHash3(bytes.subarray(0, raw.byteLength - 8)) !== view.getBigUint64(raw.byteLength - 8, true)) {
      return null
    }
    let members: { config?: NodeId[]; learners?: NodeId[] }
    try {
      members = JSON.parse(decoder.decode(bytes.subarray(32, 32 + membersLength))) as {
        config?: NodeId[]
        learners?: NodeId[]
      }
    } catch {
      return null
    }
    return {
      index: Number(view.getBigUint64(8, true)),
      term: Number(view.getBigUint64(16, true)),
      config: members.config ?? [],
      learners: members.learners ?? [],
      data: bytes.slice(32 + membersLength, 32 + membersLength + dataLength),
    }
  }

  /** Walks `entries.log`, truncating anything from the first unreadable or out-of-order record. */
  #scan(): void {
    let size: number
    try {
      size = fs.statSync(this.#entriesPath).size
    } catch {
      return
    }
    if (size === 0) return

    const raw = fs.readFileSync(this.#entriesPath)
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    let at = 0
    let expected = this.firstIndex
    while (at + RECORD_HEADER_SIZE <= size) {
      const decoded = decodeEntry(bytes, at)
      if (!decoded) break
      if (decoded.entry.index !== expected) break
      this.#entries.push(decoded.entry)
      at += decoded.byteLength
      this.#offsets.push(at)
      expected += 1
    }
    this.#bytes = at
    if (at < size) {
      fs.truncateSync(this.#entriesPath, at)
      this.repaired = true
    }
  }
}

// ── the record codec ───────────────────────────────────────────────────────────────────────────

export function encodeEntry(entry: LogEntry): Uint8Array {
  const kind = KINDS.indexOf(entry.kind as Kind)
  if (kind === -1) throw new ClusterFormatError(`unknown raft entry kind ${entry.kind}`)
  const out = new Uint8Array(RECORD_HEADER_SIZE + entry.data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, RECORD_MAGIC, true)
  view.setUint8(4, RECORD_VERSION)
  view.setUint8(5, kind)
  view.setBigUint64(8, BigInt(entry.index), true)
  view.setBigUint64(16, BigInt(entry.term), true)
  view.setUint32(24, entry.data.byteLength, true)
  view.setBigUint64(32, Bun.hash.xxHash3(entry.data), true)
  view.setBigUint64(40, Bun.hash.xxHash3(out.subarray(0, 40)), true)
  out.set(entry.data, RECORD_HEADER_SIZE)
  return out
}

export interface DecodedEntry {
  entry: LogEntry
  /** Total bytes of the record: what to skip to reach the next one. */
  byteLength: number
}

/**
 * Reads one record. Returns null for anything that is not a whole, self-consistent record — a
 * short read, a bad magic, either hash failing — because in this file every one of those means
 * the same thing: the tail was torn by a crash and everything from here on is not ours.
 */
export function decodeEntry(bytes: Uint8Array, offset = 0): DecodedEntry | null {
  if (bytes.byteLength - offset < RECORD_HEADER_SIZE) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, RECORD_HEADER_SIZE)
  if (view.getUint32(0, true) !== RECORD_MAGIC) return null
  if (view.getUint8(4) !== RECORD_VERSION) return null
  if (Bun.hash.xxHash3(bytes.subarray(offset, offset + 40)) !== view.getBigUint64(40, true)) {
    return null
  }
  const kind = KINDS[view.getUint8(5)]
  if (!kind) return null
  const dataLength = view.getUint32(24, true)
  const byteLength = RECORD_HEADER_SIZE + dataLength
  if (bytes.byteLength - offset < byteLength) return null
  const data = bytes.slice(offset + RECORD_HEADER_SIZE, offset + byteLength)
  if (Bun.hash.xxHash3(data) !== view.getBigUint64(32, true)) return null
  return {
    entry: {
      index: Number(view.getBigUint64(8, true)),
      term: Number(view.getBigUint64(16, true)),
      kind,
      data,
    },
    byteLength,
  }
}

/** Temp file, fsync, rename: a reader never sees half of one of these. */
function writeFileDurably(filePath: string, bytes: Uint8Array, fsync: boolean): void {
  const temp = `${filePath}.${process.pid}.tmp`
  const fd = fs.openSync(temp, "w")
  try {
    fs.writeSync(fd, bytes, 0, bytes.byteLength, 0)
    if (fsync) fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, filePath)
}
