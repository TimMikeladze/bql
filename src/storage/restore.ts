// Point-in-time restore from a bucket (design §4.4, §6.5): the newest snapshot at or before the
// target, then the segments after it replayed through the same `WalApplier` a replica uses.
//
// Invariant: a restore either reproduces the target txid exactly or it fails. Every object's
// `hash` is checked against the manifest before a byte of it is used, every record is applied
// through the applier — which verifies `preChecksum` against the restored database's own
// pre-images and `postChecksum` against its own fold — and a missing object, a gap in the
// inventory or a checksum disagreement aborts the whole thing. There is no path here that
// produces a database with a hole in it.
//
// Second invariant: nothing here trusts an object the manifest does not name. The manifest is
// written last precisely so that this holds.

import fs from "node:fs"
import path from "node:path"
import { Database } from "../sqlite/index.ts"
import type { Catalog } from "../tenant/catalog.ts"
import { assertValidName, tenantDir } from "../tenant/tenant.ts"
import { WalApplier } from "../wal/applier.ts"
import { WAL_HEADER_SIZE } from "../wal/codec.ts"
import { computeFull, decode, type TxnRecord } from "../wal/record.ts"
import {
  decodeManifest,
  type GenerationRef,
  latestTxid,
  type Manifest,
  manifestKey,
  planRestore,
  type RestorePlan,
  RestorePlanError,
  type SegmentEntry,
} from "./layout.ts"
import { S3NotFound, type S3Store } from "./s3.ts"

/** A restore that cannot be done, with the code the HTTP layer answers. */
export class RestoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "RestoreError"
    this.code = code
  }
}

/** Where in the timeline to land: a txid, or a wall-clock moment. */
export type RestoreTarget = { txid: bigint } | { timestamp: number } | { latest: true }

export interface BucketRestoreOptions {
  store: S3Store
  prefix: string
  /** The database in the bucket. */
  db: string
  at?: RestoreTarget
  /** Restrict to one generation; without it the newest one that reaches the target wins. */
  generation?: string
}

export interface BucketRestoreResult {
  /** The database file that was written. */
  path: string
  /** Directory holding it. */
  dir: string
  txid: bigint
  /** The snapshot the restore started from, or null when it started from an empty database. */
  fromTxid: bigint
  checksum: bigint
  pages: number
  pageSize: number
  epoch: number
  generation: string
  /** Records replayed on top of the base. */
  applied: number
  /** Objects downloaded. */
  objects: number
  bytes: number
}

/** Reads and validates the manifest, or says plainly that there is nothing to restore from. */
export async function readManifest(
  store: S3Store,
  prefix: string,
  db: string,
): Promise<Manifest> {
  const key = manifestKey(prefix, db)
  let body: Uint8Array | null
  try {
    body = await store.getOrNull(key)
  } catch (err) {
    throw new RestoreError("S3_UNREACHABLE", `cannot read ${key}: ${messageOf(err)}`)
  }
  if (body === null) {
    throw new RestoreError(
      "S3_NO_MANIFEST",
      `no backup manifest for ${db} at ${store.describe().bucket}/${key}`,
    )
  }
  const manifest = decodeManifest(body)
  if (manifest === null) {
    // A torn manifest — a PUT that did not complete — parses as nothing, and "nothing" is the
    // only safe reading: half a manifest describes half a timeline.
    throw new RestoreError(
      "S3_NO_MANIFEST",
      `the backup manifest for ${db} at ${store.describe().bucket}/${key} is not readable`,
    )
  }
  return manifest
}

/** The generations the bucket knows about, newest first. */
export async function listGenerations(
  store: S3Store,
  prefix: string,
  db: string,
): Promise<GenerationRef[]> {
  const manifest = await readManifest(store, prefix, db)
  return [...manifest.generations].reverse()
}

/**
 * Resolves a target against the inventory. A timestamp lands on the newest *record* committed at
 * or before it: snapshots carry only the wall clock of the copy, so the segments are scanned for
 * the real answer, which is what makes `--at 2026-09-11T10:00Z` mean the same thing it means for
 * a local PITR restore.
 */
export async function resolveTarget(
  store: S3Store,
  manifest: Manifest,
  at: RestoreTarget | undefined,
  generation?: string,
): Promise<bigint> {
  if (at === undefined || "latest" in at) {
    const latest = latestTxid(manifest, generation)
    if (latest === 0n && manifest.snapshots.length === 0) {
      throw new RestoreError("S3_INCOMPLETE", `${manifest.db} has nothing shipped to restore`)
    }
    return latest
  }
  if ("txid" in at) return at.txid

  const targetUs = BigInt(Math.floor(at.timestamp)) * 1000n
  const segments = manifest.segments.filter(
    (one) => generation === undefined || one.generation === generation,
  )
  let best = 0n
  // Segments are ordered, so the answer is in the first one whose records run past the target;
  // everything before it is wholly at or before the target and everything after is wholly past.
  for (const segment of segments) {
    const records = await downloadSegment(store, segment)
    let crossed = false
    for (const record of records) {
      if (record.timestampUs <= targetUs) best = record.txid
      else {
        crossed = true
        break
      }
    }
    if (crossed) break
  }
  if (best === 0n) {
    // Nothing in the log is that old, but a snapshot might be: a database restored to a moment
    // before its first shipped record is that snapshot and nothing more.
    for (const snapshot of manifest.snapshots) {
      if (snapshot.createdAtMs <= at.timestamp) best = BigInt(snapshot.txid)
    }
  }
  if (best === 0n) {
    throw new RestoreError(
      "S3_INCOMPLETE",
      `${manifest.db} has nothing in the bucket at or before ${new Date(at.timestamp).toISOString()}`,
    )
  }
  return best
}

export interface VerifyResult {
  ok: boolean
  db: string
  generation: string
  at: number
  /** The newest txid the bucket can restore to. */
  latest: number
  fromSnapshotTxid: number | null
  segments: number
  records: number
  bytes: number
  /** Objects the manifest names that are not in the bucket. Non-empty means `ok: false`. */
  missing: string[]
  generations: GenerationRef[]
}

/**
 * Checks the bucket is restorable to `at` without downloading a page or writing a byte: the
 * manifest must describe a contiguous timeline, and every object on the path must exist with the
 * size the manifest recorded.
 */
export async function verifyBucket(
  options: BucketRestoreOptions,
): Promise<VerifyResult> {
  const { store, prefix, db } = options
  const manifest = await readManifest(store, prefix, db)
  const at = await resolveTarget(store, manifest, options.at, options.generation)
  const plan = planFor(manifest, at, options.generation)

  const wanted: Array<{ key: string; bytes: number }> = []
  if (plan.snapshot) wanted.push({ key: plan.snapshot.key, bytes: plan.snapshot.bytes })
  for (const segment of plan.segments) wanted.push({ key: segment.key, bytes: segment.bytes })

  const missing: string[] = []
  let bytes = 0
  for (const object of wanted) {
    const head = await store.head(object.key)
    if (head === null) {
      missing.push(object.key)
      continue
    }
    if (head.size !== object.bytes) {
      missing.push(`${object.key} (is ${head.size} bytes, manifest says ${object.bytes})`)
      continue
    }
    bytes += head.size
  }

  return {
    ok: missing.length === 0,
    db,
    generation: plan.generation,
    at: Number(at),
    latest: Number(latestTxid(manifest, plan.generation)),
    fromSnapshotTxid: plan.snapshot ? Number(plan.snapshot.txid) : null,
    segments: plan.segments.length,
    records: plan.segments.reduce((total, one) => total + one.records, 0),
    bytes,
    missing,
    generations: [...manifest.generations].reverse(),
  }
}

/**
 * Rebuilds the database into `into` (a directory), leaving a file the registry opens as a normal
 * primary. `catalog` and `dataDir` together also write the catalog row, which is what makes the
 * result a database the server can serve rather than a loose file.
 */
export async function restoreFromBucket(
  options: BucketRestoreOptions & {
    /** Destination directory. Defaults to `<dataDir>/dbs/<hh>/<into>`. */
    into?: string
    dir?: string
  },
): Promise<BucketRestoreResult> {
  const { store, prefix, db } = options
  const manifest = await readManifest(store, prefix, db)
  const at = await resolveTarget(store, manifest, options.at, options.generation)
  const plan = planFor(manifest, at, options.generation)

  const dir = options.dir ?? options.into
  if (!dir) throw new RestoreError("BAD_REQUEST", "a bucket restore needs a destination directory")
  const targetPath = path.join(dir, "main.db")
  fs.mkdirSync(dir, { recursive: true })
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${targetPath}${suffix}`, { force: true })
  fs.rmSync(path.join(dir, "meta.json"), { force: true })
  fs.rmSync(path.join(dir, "log"), { recursive: true, force: true })

  let objects = 0
  let bytes = 0
  const pageSize = plan.snapshot?.pageSize || manifest.pageSize || 4096

  if (plan.snapshot) {
    const body = await download(store, plan.snapshot.key, plan.snapshot.hash)
    fs.writeFileSync(targetPath, body)
    objects += 1
    bytes += body.byteLength
    if (body.byteLength !== plan.snapshot.plainBytes) {
      throw new RestoreError(
        "S3_CORRUPT",
        `${plan.snapshot.key} decompressed to ${body.byteLength} bytes, manifest says ` +
          `${plan.snapshot.plainBytes}`,
      )
    }
  } else {
    createEmptyDatabase(targetPath, pageSize)
  }

  const applier = new WalApplier({ dbPath: targetPath, dir, fsync: "rename" })
  let applied = 0
  let reached = plan.fromTxid
  let epoch = plan.snapshot?.epoch ?? 0
  try {
    applier.seed({
      txid: plan.fromTxid,
      epoch,
      // The trap `plan-phase1.md` names: a database nothing has ever written to holds the header
      // page SQLite writes when the file is first opened in WAL mode, while its tenant stands at
      // zero pages and checksum zero. Seeding from the file there fails on record 1.
      postChecksum: plan.fromTxid === 0n ? 0n : BigInt(plan.snapshot?.checksum ?? "0"),
      dbSizePages: plan.fromTxid === 0n ? 0 : (plan.snapshot?.pages ?? 0),
      pageSize,
    })

    for (const segment of plan.segments) {
      const records = await downloadSegment(store, segment)
      objects += 1
      bytes += segment.plainBytes
      for (const record of records) {
        if (record.txid <= reached) continue
        if (record.txid > at) break
        applier.apply(record)
        reached = record.txid
        epoch = record.epoch
        applied += 1
      }
      if (reached >= at) break
    }

    if (reached !== at) {
      throw new RestoreError(
        "S3_INCOMPLETE",
        `${db} restored to txid ${reached}, which is short of the requested ${at}`,
      )
    }
    const position = applier.position
    applier.close()

    // The applier left its frames in the new `-wal`. Folding them into the file is what makes the
    // result a plain SQLite database with an empty WAL, which is the only thing a fresh recorder
    // can start tailing without counting them twice.
    foldWal(targetPath)
    fs.rmSync(path.join(dir, "meta.json"), { force: true })
    const full = computeFull(targetPath, { includeWal: false })

    return {
      path: targetPath,
      dir,
      txid: reached,
      fromTxid: plan.fromTxid,
      checksum: full.checksum,
      pages: full.pages,
      pageSize: full.pageSize || position.pageSize || pageSize,
      epoch,
      generation: plan.generation,
      applied,
      objects,
      bytes,
    }
  } finally {
    try {
      applier.close()
    } catch {
      // Already closed on the happy path; closing twice must not mask the real failure.
    }
  }
}

/**
 * The whole operator-facing restore: rebuild from the bucket into a new tenant directory and file
 * the catalog row, so the registry can open it as a primary. The caller opens it.
 */
export async function restoreIntoCatalog(
  options: BucketRestoreOptions & {
    dataDir: string
    catalog: Catalog
    /** Name of the new database. */
    into: string
    quotaBytes?: number
  },
): Promise<BucketRestoreResult & { name: string }> {
  assertValidName(options.into)
  if (options.catalog.getTenant(options.into)) {
    throw new RestoreError("CONFLICT", `database ${options.into} already exists`)
  }
  const dir = tenantDir(options.dataDir, options.into)
  if (fs.existsSync(path.join(dir, "main.db"))) {
    throw new RestoreError("CONFLICT", `${dir} already holds a database`)
  }
  const result = await restoreFromBucket({ ...options, dir })
  options.catalog.createTenant({
    name: options.into,
    pageSize: result.pageSize,
    quotaBytes: options.quotaBytes ?? 0,
    epoch: result.epoch,
    position: {
      txid: result.txid,
      checksum: result.checksum,
      dbSizePages: result.pages,
      wal: { salt1: 0, salt2: 0, frame: 0 },
    },
  })
  return { ...result, name: options.into }
}

// -------------------------------------------------------------------------

function planFor(manifest: Manifest, at: bigint, generation?: string): RestorePlan {
  try {
    return planRestore(manifest, at, generation)
  } catch (err) {
    if (err instanceof RestorePlanError) throw new RestoreError(err.code, err.message)
    throw err
  }
}

/** Downloads an object, verifies its hash against the manifest, and decompresses it. */
async function download(store: S3Store, key: string, hash: string): Promise<Uint8Array> {
  let body: Uint8Array
  try {
    body = await store.get(key)
  } catch (err) {
    if (err instanceof S3NotFound) {
      throw new RestoreError(
        "S3_INCOMPLETE",
        `${store.describe().bucket}/${key} is named by the manifest but is not in the bucket`,
      )
    }
    throw new RestoreError("S3_UNREACHABLE", `cannot read ${key}: ${messageOf(err)}`)
  }
  let plain: Uint8Array
  try {
    plain = new Uint8Array(Bun.zstdDecompressSync(body))
  } catch (err) {
    throw new RestoreError("S3_CORRUPT", `${key} is not readable zstd: ${messageOf(err)}`)
  }
  const actual = Bun.hash.xxHash3(plain).toString()
  if (actual !== hash) {
    throw new RestoreError(
      "S3_CORRUPT",
      `${key} hashes to ${actual}, the manifest says ${hash}`,
    )
  }
  return plain
}

/** One segment object's records, in order, each already verified by `decode`. */
async function downloadSegment(store: S3Store, segment: SegmentEntry): Promise<TxnRecord[]> {
  const plain = await download(store, segment.key, segment.hash)
  const records: TxnRecord[] = []
  let at = 0
  while (at < plain.byteLength) {
    const { record, byteLength } = decode(plain, at)
    records.push(record)
    at += byteLength
  }
  const start = BigInt(segment.startTxid)
  const end = BigInt(segment.endTxid)
  const first = records[0]
  const last = records.at(-1)
  if (!first || !last || first.txid !== start || last.txid !== end) {
    throw new RestoreError(
      "S3_CORRUPT",
      `${segment.key} holds txid ${first?.txid ?? "nothing"}..${last?.txid ?? "nothing"}, ` +
        `its key says ${start}..${end}`,
    )
  }
  return records
}

/**
 * A database with nothing in it but a header, in WAL mode — the base a generation whose log
 * reaches back to txid 1 replays onto. A zero-length file would not do: with no header SQLite
 * cannot know the file is in WAL mode and would ignore the `-wal` the applier writes.
 */
function createEmptyDatabase(dbPath: string, pageSize: number): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true })
  const db = Database.open(dbPath, { wal: false })
  try {
    db.exec(`pragma page_size = ${pageSize}`)
    db.exec("pragma journal_mode = wal")
  } finally {
    db.close()
  }
}

/** Moves everything in the WAL into the database file and leaves the WAL empty. */
function foldWal(dbPath: string): void {
  const db = Database.open(dbPath, { wal: false })
  try {
    db.exec("pragma journal_mode = wal")
    db.prepare("select 1 from sqlite_schema limit 1").get()
    const result = db.walCheckpoint("TRUNCATE")
    if (result.busy) {
      throw new RestoreError("BUSY", `checkpoint of ${dbPath} was blocked by another connection`)
    }
  } finally {
    db.close()
  }
  const walPath = `${dbPath}-wal`
  const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
  if (walBytes > WAL_HEADER_SIZE) {
    throw new RestoreError(
      "S3_CORRUPT",
      `${walBytes} bytes of WAL survived the checkpoint of ${dbPath}`,
    )
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
