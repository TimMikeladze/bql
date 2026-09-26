import fs from "node:fs"
import path from "node:path"
import { Database, sqlite } from "../sqlite/index.ts"
import type { ObjectStore } from "../storage/object-store.ts"
import { restoreFromInventory, type BucketRestoreResult } from "../storage/restore.ts"
import type { RestorePlan, SegmentEntry } from "../storage/layout.ts"
import { computeFull, decode, decodeHeader, RECORD_HEADER_SIZE, type TxnRecord } from "../wal/record.ts"
import { CloudFormatError, decimalU64, decodeJSON, objectRef, readObject, record, type DatabaseHead, type ObjectRef } from "./format.ts"
import { identity, nonnegative, pageSize } from "./catalog.ts"

/** Raw SQLite bytes plus recorder position. The descriptor itself is immutable
 * and checksummed by DatabaseHead.snapshotRef. */
export interface CloudSnapshot {
  formatVersion: 1
  engine: string
  incarnation: string
  txid: string
  epoch: number
  pages: number
  pageSize: number
  checksum: string
  dataRef: ObjectRef
}
export interface CloudSegment extends ObjectRef { startTxid: string; endTxid: string; records: number; plainBytes: number; maxDatabaseBytes: number }
export interface CloudLogIndex { formatVersion: 1; incarnation: string; segments: CloudSegment[] }
export interface RestoredDatabase extends BucketRestoreResult { incarnation: string }
export interface RestoreLimits { maxBytes?: number; maxDiskBytes?: number; maxMetadataBytes?: number }

function snapshotDocument(body: Uint8Array, incarnation: string): CloudSnapshot {
  const data = record(decodeJSON(body))
  if (data.formatVersion !== 1 || data.incarnation !== incarnation || data.engine !== sqlite().version) throw new CloudFormatError("Incompatible snapshot engine or incarnation")
  const snapshot: CloudSnapshot = { formatVersion: 1, engine: data.engine, incarnation, txid: decimalU64(data.txid), epoch: nonnegative(data.epoch), pages: nonnegative(data.pages), pageSize: pageSize(data.pageSize), checksum: decimalU64(data.checksum), dataRef: objectRef(data.dataRef) }
  if (snapshot.epoch > 0xffffffff || (snapshot.txid === "0" && (snapshot.pages !== 0 || snapshot.checksum !== "0"))) throw new CloudFormatError("Invalid snapshot position")
  return snapshot
}
export function decodeLogIndex(body: Uint8Array, incarnation: string): CloudLogIndex {
  const data = record(decodeJSON(body))
  if (data.formatVersion !== 1 || data.incarnation !== incarnation || !Array.isArray(data.segments)) throw new CloudFormatError("Incompatible log inventory")
  return { formatVersion: 1, incarnation, segments: data.segments.map(raw => {
    const segment = record(raw)
    return { ...objectRef(segment), startTxid: decimalU64(segment.startTxid), endTxid: decimalU64(segment.endTxid), records: nonnegative(segment.records), plainBytes: nonnegative(segment.plainBytes), maxDatabaseBytes: nonnegative(segment.maxDatabaseBytes) }
  }) }
}

/** Downloads only the committed head's inventory. A unique child of stagingDir
 * is returned only after replay, checksum and SQLite integrity verification;
 * callers atomically install it. Failure removes the child and leaves no cache. */
/** Validate the complete explicit inventory and its recovery resource budgets.
 * Publishers use the same check before acknowledging a new database head. */
export async function inspectCloudDatabase(store: ObjectStore, head: DatabaseHead, signal?: AbortSignal, limits: RestoreLimits = {}) {
  const maxBytes = nonnegative(limits.maxBytes ?? 256 * 1024 * 1024)
  const maxDisk = nonnegative(limits.maxDiskBytes ?? 512 * 1024 * 1024)
  const maxMetadata = nonnegative(limits.maxMetadataBytes ?? 8 * 1024 * 1024)
  const incarnation = identity(head.incarnation)
  const target = BigInt(decimalU64(head.txid))
  const snapshotRef = objectRef(head.snapshotRef)
  const indexRef = objectRef(head.logIndexRef)
  if (snapshotRef.bytes + indexRef.bytes > Math.min(maxBytes, maxMetadata)) throw new CloudFormatError("Restore metadata exceeds byte budget")
  const snapshot = snapshotDocument(await readObject(store, snapshotRef, { maxBytes: maxMetadata, signal }), incarnation)
  const index = decodeLogIndex(await readObject(store, indexRef, { maxBytes: maxMetadata, signal }), incarnation)
  let next = BigInt(snapshot.txid) + 1n
  let bytes = snapshotRef.bytes + indexRef.bytes + snapshot.dataRef.bytes
  const keys = new Set([snapshot.dataRef.key])
  for (const entry of index.segments) {
    if (keys.has(entry.key) || BigInt(entry.startTxid) !== next || BigInt(entry.endTxid) < next || BigInt(entry.records) !== BigInt(entry.endTxid) - next + 1n) throw new CloudFormatError("Noncontiguous or reordered log inventory")
    keys.add(entry.key)
    next = BigInt(entry.endTxid) + 1n
    bytes += Math.max(entry.bytes, entry.plainBytes)
    if (entry.maxDatabaseBytes * 2 > maxDisk) throw new CloudFormatError("Restore exceeds disk budget")
  }
  if (next - 1n !== target) throw new CloudFormatError("Inventory does not reach committed head")
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new CloudFormatError("Restore exceeds byte budget")
  // Reserve room for a full database plus an equally sized WAL. Individual
  // transaction headers are checked before replay for subsequent growth.
  if (snapshot.dataRef.bytes * 2 > maxDisk || snapshot.pages * snapshot.pageSize * 2 > maxDisk) throw new CloudFormatError("Restore exceeds disk budget")
  const segments: SegmentEntry[] = index.segments.map(entry => ({ key: entry.key, generation: incarnation, startTxid: entry.startTxid, endTxid: entry.endTxid, records: entry.records, bytes: entry.bytes, plainBytes: entry.bytes, hash: "0", createdAtMs: 0 }))
  const plan: RestorePlan = {
    generation: incarnation, fromTxid: BigInt(snapshot.txid), reaches: target, segments,
    snapshot: { key: snapshot.dataRef.key, generation: incarnation, txid: snapshot.txid, epoch: snapshot.epoch, pages: snapshot.pages, pageSize: snapshot.pageSize, checksum: snapshot.checksum, bytes: snapshot.dataRef.bytes, plainBytes: snapshot.dataRef.bytes, hash: "0", createdAtMs: 0 },
  }
  const references = new Map(index.segments.map(entry => [entry.key, entry]))
  return { snapshot, index, plan, references, target, incarnation, maxBytes, maxDisk }
}

export async function restoreCloudDatabase(store: ObjectStore, head: DatabaseHead, stagingDir: string, signal?: AbortSignal, limits: RestoreLimits = {}): Promise<RestoredDatabase> {
  const { snapshot, plan, references, target, incarnation, maxBytes, maxDisk } = await inspectCloudDatabase(store, head, signal, limits)
  fs.mkdirSync(stagingDir, { recursive: true })
  const dir = fs.mkdtempSync(path.join(stagingDir, "restore-"))
  try {
    const result = await restoreFromInventory({
      db: incarnation, dir, plan, pageSize: snapshot.pageSize,
      async loadSnapshot() {
        const body = await readObject(store, snapshot.dataRef, { maxBytes, signal })
        if (body.byteLength < 100 || new TextDecoder().decode(body.subarray(0, 16)) !== "SQLite format 3\0") throw new CloudFormatError("Invalid SQLite snapshot")
        // Verify snapshot position before seeding the applier. The pristine txid=0
        // header page is special: its recorder position is deliberately zero.
        const checkPath = path.join(dir, "verify.db")
        fs.writeFileSync(checkPath, body)
        try {
          const full = computeFull(checkPath, { includeWal: false })
          if (full.pageSize !== snapshot.pageSize || (snapshot.txid !== "0" && (full.pages !== snapshot.pages || full.checksum !== BigInt(snapshot.checksum)))) throw new CloudFormatError("Snapshot position checksum mismatch")
        } finally { fs.rmSync(checkPath, { force: true }) }
        return body
      },
      async loadSegment(entry) {
        const reference = references.get(entry.key)!
        const body = await readObject(store, reference, { maxBytes, signal })
        const records: TxnRecord[] = []
        let offset = 0
        let expanded = 0
        let txid = BigInt(reference.startTxid)
        while (offset < body.length) {
          if (signal?.aborted) throw new CloudFormatError("Restore aborted")
          const header = decodeHeader(body, offset)
          if (!header || header.header.pageSize !== snapshot.pageSize || header.header.bodyPlainLength > maxBytes || header.header.commitSizePages * snapshot.pageSize * 2 + header.header.bodyPlainLength > maxDisk) throw new CloudFormatError("Transaction exceeds restore budget or page size")
          expanded += RECORD_HEADER_SIZE + header.header.bodyPlainLength
          if (expanded > reference.plainBytes || header.header.commitSizePages * snapshot.pageSize > reference.maxDatabaseBytes) throw new CloudFormatError("Transaction exceeds advertised restore budget")
          const decoded = decode(body, offset)
          for (const pgno of decoded.record.pages.keys()) {
            if (pgno < 1 || pgno * snapshot.pageSize > reference.maxDatabaseBytes) throw new CloudFormatError("Page exceeds advertised restore budget")
          }
          if (decoded.record.txid !== txid || decoded.record.prevTxid !== txid - 1n) throw new CloudFormatError("Noncontiguous transaction chain")
          records.push(decoded.record)
          offset += decoded.byteLength
          txid++
        }
        if (expanded !== reference.plainBytes || records.length !== reference.records || txid - 1n !== BigInt(reference.endTxid)) throw new CloudFormatError("Transaction count does not match inventory")
        return records
      },
    })
    if (signal?.aborted) throw new CloudFormatError("Restore aborted")
    const db = Database.open(result.path, { readonly: true, wal: false })
    try {
      const rows = db.prepare("pragma integrity_check").values()
      if (rows.length !== 1 || rows[0]?.[0] !== "ok") throw new CloudFormatError("Restored database failed integrity check")
      if (target === 0n && db.prepare("select name from sqlite_schema").all().length !== 0) throw new CloudFormatError("Nonempty zero-position snapshot")
    } finally { db.close() }
    // The pristine SQLite header is not a committed transaction. Preserve the
    // recorder's zero position so the first write does not XOR out that page.
    return { ...result, incarnation, ...(target === 0n ? { checksum: 0n, pages: 0 } : {}) }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
