// Physical snapshots and point-in-time restore (design §4.4).
//
// Invariant: a snapshot file is the database at exactly one txid. That only holds if nothing
// commits between the TRUNCATE checkpoint and the copy, and only the owner of the write path
// knows which txid that is — so the caller passes it, and this module verifies what it can: the
// checkpoint must not have come back busy, and the WAL must be empty on disk afterwards. The
// tenant owner (M4) satisfies the contract by holding the single writer across both steps.
//
// `Bun.write(dst, Bun.file(src))` is a reflink on APFS/XFS/btrfs *only when the destination does
// not exist*, which is why every snapshot gets a fresh path and nothing is ever overwritten.
//
// Second invariant: pruning never leaves a restorable point without a base. `planSnapshotPrune`
// keeps everything newer than the cutoff, the newest snapshot at or before it, and the newest
// snapshot there is — so "restore to exactly `retention` ago" and "restore a database nobody has
// written to in a month" both still find a file to start from. See `docs/r6-retention.md`.

import fs from "node:fs"
import path from "node:path"
import type { Database } from "../sqlite/index.ts"
import { WAL_HEADER_SIZE } from "./codec.ts"
import { WalError } from "./errors.ts"
import { computeFull } from "./record.ts"
import { TxnLog } from "./log.ts"
import { WalApplier } from "./applier.ts"

export interface SnapshotRef {
  /** Absolute path of the snapshot file. */
  path: string
  /** The txid the snapshot holds, as a decimal string so the index stays plain JSON. */
  txid: string
  epoch: number
  bytes: number
  pageSize: number
  /**
   * Database size in pages at `txid`, as the *owner of the write path* counts it — which is not
   * always the number of pages in the file. Seeding an applier from anything else diverges it.
   */
  pages: number
  /** Rolling database checksum at `txid`, decimal, from the same source as `pages`. */
  checksum: string
  createdAtMs: number
}

export interface SnapshotTarget {
  /** The live database. Used only for the checkpoint. */
  db: Database
  /** Path of that database file. */
  dbPath: string
  /** Tenant directory; snapshots go in `<dir>/snapshots`. */
  dir: string
}

export interface SnapshotOptions {
  /** Leadership term to stamp on the snapshot. */
  epoch?: number
  /**
   * The tenant's own position at `txid`, which is what an applier seeded from this snapshot has to
   * start at. Without it the position is computed from the file, and the two disagree in exactly
   * one case: a database nothing has ever written to holds the header page SQLite creates when the
   * file is first opened in WAL mode, while its tenant stands at "0 pages, checksum 0" because
   * that page belongs to no transaction. An applier seeded from the file there XORs that page out
   * of its first apply and fails `ChecksumMismatch` on record 1.
   */
  position?: { checksum: bigint; pages: number }
}

function snapshotDir(dir: string): string {
  return path.join(dir, "snapshots")
}

function indexPath(dir: string): string {
  return path.join(snapshotDir(dir), "index.json")
}

function writeAtomic(file: string, body: string): void {
  const temp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(temp, "w")
  try {
    fs.writeFileSync(fd, body)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
}

/** Every snapshot recorded for `dir`, oldest first. */
export function listSnapshots(dir: string): SnapshotRef[] {
  let raw: string
  try {
    raw = fs.readFileSync(indexPath(dir), "utf8")
  } catch {
    return []
  }
  const parsed = JSON.parse(raw) as { version?: number; snapshots?: SnapshotRef[] }
  const snapshots = parsed.snapshots ?? []
  return snapshots
    .filter((s) => fs.existsSync(s.path))
    .sort((a, b) => (BigInt(a.txid) < BigInt(b.txid) ? -1 : 1))
}

/**
 * Checkpoints the database into its own file and copies it to `<dir>/snapshots/<txid>.db`.
 *
 * `txid` is the txid of the last transaction whose frames the checkpoint moved into the file.
 * The caller must hold the writer across this call; a commit that lands between the checkpoint
 * and the copy would silently make the snapshot newer than the txid it is filed under.
 */
export async function snapshot(
  target: SnapshotTarget,
  txid: bigint,
  options: SnapshotOptions = {},
): Promise<SnapshotRef> {
  const result = target.db.walCheckpoint("TRUNCATE")
  if (result.busy) {
    throw new WalError(`cannot snapshot ${target.dbPath}: the checkpoint was blocked by a reader`)
  }
  const walPath = `${target.dbPath}-wal`
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
  if (walSize >= WAL_HEADER_SIZE) {
    throw new WalError(
      `cannot snapshot ${target.dbPath}: ${walSize} bytes of WAL survived the checkpoint`,
    )
  }

  const dir = snapshotDir(target.dir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${txid.toString().padStart(20, "0")}.db`)
  if (fs.existsSync(file)) {
    throw new WalError(`snapshot ${file} already exists`)
  }

  try {
    await Bun.write(file, Bun.file(target.dbPath))
  } catch {
    // Reflink unavailable or refused: a plain copy is correct, just slower.
    fs.copyFileSync(target.dbPath, file)
  }

  const full = computeFull(file, { includeWal: false })
  const position = options.position ?? { checksum: full.checksum, pages: full.pages }
  const ref: SnapshotRef = {
    path: file,
    txid: txid.toString(),
    epoch: options.epoch ?? 0,
    bytes: fs.statSync(file).size,
    pageSize: full.pageSize,
    pages: position.pages,
    checksum: position.checksum.toString(),
    createdAtMs: Date.now(),
  }

  const all = listSnapshots(target.dir).filter((s) => s.path !== file)
  all.push(ref)
  writeAtomic(indexPath(target.dir), JSON.stringify({ version: 1, snapshots: all }, null, 2))
  return ref
}

/** Deletes a snapshot file and its index entry. */
export function removeSnapshot(dir: string, txid: bigint): boolean {
  const all = listSnapshots(dir)
  const keep = all.filter((s) => BigInt(s.txid) !== txid)
  if (keep.length === all.length) return false
  for (const ref of all) {
    if (BigInt(ref.txid) === txid) fs.rmSync(ref.path, { force: true })
  }
  writeAtomic(indexPath(dir), JSON.stringify({ version: 1, snapshots: keep }, null, 2))
  return true
}

export interface SnapshotPrunePlan {
  /** Oldest first, as `listSnapshots` returns them. */
  keep: SnapshotRef[]
  remove: SnapshotRef[]
}

/**
 * Which snapshots a retention cutoff may remove, and which it may not. Pure, so the rule can be
 * stated without a disk.
 *
 * Everything newer than `cutoffMs` is kept, and then two exceptions keep point-in-time restore
 * whole. **The most recent snapshot at or before the cutoff is kept**, because a restore to
 * exactly `retention` ago needs a base at or before that point to replay from; keeping only what
 * is newer than the cutoff would leave the oldest restorable point sitting an arbitrary distance
 * inside the window. **The newest snapshot overall is kept whatever its age**, so a database that
 * has not been written to in a month is still restorable.
 *
 * The order is by txid rather than by age — that is the order a restore searches — but the cutoff
 * is compared against `createdAtMs`, so a snapshot index that somehow disagrees about which is
 * older cannot make the rule drop a base it should have kept.
 */
export function planSnapshotPrune(refs: SnapshotRef[], cutoffMs: number): SnapshotPrunePlan {
  const sorted = [...refs].sort((a, b) => (BigInt(a.txid) < BigInt(b.txid) ? -1 : 1))
  if (sorted.length <= 1) return { keep: sorted, remove: [] }

  const newest = sorted.at(-1) as SnapshotRef
  // The base a restore to the oldest point still in the window would start from.
  let base: SnapshotRef | null = null
  for (const ref of sorted) {
    if (ref.createdAtMs <= cutoffMs) base = ref
  }

  const keep: SnapshotRef[] = []
  const remove: SnapshotRef[] = []
  for (const ref of sorted) {
    if (ref.createdAtMs > cutoffMs || ref === base || ref === newest) keep.push(ref)
    else remove.push(ref)
  }
  return { keep, remove }
}

/**
 * Applies `planSnapshotPrune` to `<dir>/snapshots`. Returns what survived, oldest first — the
 * first of those is the floor the log is then held to, because it is the oldest base a restore can
 * still start from.
 *
 * A removal that throws (a file still mapped, a permissions error) is handed to `onError` and the
 * prune carries on; that snapshot is reported as kept, which is the safe direction, since the log
 * floor then still protects the records it needs.
 */
export function pruneSnapshots(
  dir: string,
  cutoffMs: number,
  onError?: (err: unknown) => void,
): { removed: SnapshotRef[]; kept: SnapshotRef[] } {
  const plan = planSnapshotPrune(listSnapshots(dir), cutoffMs)
  const removed: SnapshotRef[] = []
  const kept = [...plan.keep]
  for (const ref of plan.remove) {
    try {
      removeSnapshot(dir, BigInt(ref.txid))
      removed.push(ref)
    } catch (err) {
      onError?.(err)
      kept.push(ref)
    }
  }
  kept.sort((a, b) => (BigInt(a.txid) < BigInt(b.txid) ? -1 : 1))
  return { removed, kept }
}

export interface RestoreOptions {
  /** Tenant directory holding `snapshots/` and `log/`. */
  dir: string
  /** Restore the database as it was after this txid. */
  at: bigint
  /** Destination: a `.db` file path, or a directory that will hold `main.db`. */
  into: string
}

export interface RestoreResult {
  path: string
  /** The txid actually reached, which equals `at` unless the log ends earlier. */
  txid: bigint
  /** The snapshot the restore started from. */
  fromTxid: bigint
  checksum: bigint
  /** Records replayed on top of the snapshot. */
  applied: number
}

/**
 * Rebuilds the database as of `at`: newest snapshot at or before `at`, then the log records in
 * `(snapshotTxid, at]` applied through the replica applier, which verifies every one against its
 * rolling checksum.
 */
export async function restore(options: RestoreOptions): Promise<RestoreResult> {
  const snapshots = listSnapshots(options.dir)
  let chosen: SnapshotRef | null = null
  for (const ref of snapshots) {
    if (BigInt(ref.txid) <= options.at) chosen = ref
  }
  if (!chosen) {
    throw new WalError(`no snapshot at or before txid ${options.at} in ${options.dir}`)
  }

  const isDirectory = path.extname(options.into) === ""
  const targetPath = isDirectory ? path.join(options.into, "main.db") : options.into
  const targetDir = path.dirname(targetPath)
  fs.mkdirSync(targetDir, { recursive: true })
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${targetPath}${suffix}`, { force: true })
  }
  fs.rmSync(path.join(targetDir, "meta.json"), { force: true })

  try {
    await Bun.write(targetPath, Bun.file(chosen.path))
  } catch {
    fs.copyFileSync(chosen.path, targetPath)
  }

  const fromTxid = BigInt(chosen.txid)
  const applier = new WalApplier({ dbPath: targetPath, dir: targetDir })
  applier.seed({
    txid: fromTxid,
    epoch: chosen.epoch,
    // A snapshot at txid 0 is a database no transaction has ever touched, whatever its file says:
    // the header page in it was written when SQLite first opened the file in WAL mode, outside
    // any transaction, so record 1's `preChecksum` is 0 over 0 pages. Snapshots taken from R2 on
    // carry the tenant's position and already agree; this keeps an older index honest.
    postChecksum: fromTxid === 0n ? 0n : BigInt(chosen.checksum),
    dbSizePages: fromTxid === 0n ? 0 : chosen.pages,
    pageSize: chosen.pageSize,
  })

  let applied = 0
  let reached = fromTxid
  const log = TxnLog.open({ dir: options.dir, fsync: "never" })
  try {
    if (options.at > fromTxid) {
      for (const record of log.iterate(fromTxid + 1n)) {
        if (record.txid > options.at) break
        applier.apply(record)
        reached = record.txid
        applied += 1
      }
    }
    const checksum = applier.position.postChecksum
    return { path: targetPath, txid: reached, fromTxid, checksum, applied }
  } finally {
    log.close()
    applier.close()
  }
}
