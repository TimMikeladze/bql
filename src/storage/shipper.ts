// Continuous backup of one tenant's log and snapshots to a bucket — the Litestream role, built
// in (design §4.4). One `Shipper` per database, driven by `tenant.onCommit`.
//
// Invariant: the bucket can never block a commit. `onCommit` pushes bytes onto a bounded queue,
// arms a timer, and returns; a single in-flight drain loop does every upload. A bucket that is
// slow, unreachable or answering 500s makes `behind` true and `bunql_s3_errors_total` climb, and
// changes nothing at all about how long a write takes.
//
// Second invariant: the local log is the source of truth and the queue is only a fast path. When
// the queue passes `maxPendingBytes` it is *dropped*, not grown — the next drain re-reads the same
// records from `TxnLog.iterateEncoded`, which is where they are durable anyway. Nothing is lost by
// dropping memory; the only cost is a file read.
//
// Third invariant: the manifest is written last, after every object it names is durable, and it is
// the only thing a restore trusts. A crash between two uploads leaves objects the manifest does
// not name; the next drain re-lists them and adopts them, and a reader ignores them until then.

import fs from "node:fs"
import type { CommitEvent, Tenant } from "../tenant/index.ts"
import { listSnapshots, type SnapshotRef } from "../wal/snapshot.ts"
import { LogGap } from "../wal/errors.ts"
import {
  decodeManifest,
  emptyManifest,
  encodeIndexChunk,
  encodeManifest,
  INDEX_CHUNK,
  indexChunkKey,
  indexPrefix,
  type Manifest,
  manifestKey,
  newGenerationId,
  normalizeManifest,
  parseIndexChunkKey,
  parseSegmentKey,
  parseSnapshotKey,
  type SegmentEntry,
  segmentKey,
  segmentPrefix,
  type SnapshotEntry,
  snapshotKey,
  snapshotPrefix,
} from "./layout.ts"
import { type IndexChunkRef, loadIndex } from "./restore.ts"
import { S3Store } from "./s3.ts"

/** `30d`, `7d`, `12h`, `90m`, a bare number of seconds, or `0`/`""` for "never expire". */
export function parseRetentionMs(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i.exec(trimmed)
  if (!match) throw new TypeError(`retention must look like 30d, 12h or 3600, got ${text}`)
  const value = Number(match[1])
  switch ((match[2] ?? "s").toLowerCase()) {
    case "ms":
      return value
    case "m":
      return value * 60_000
    case "h":
      return value * 3_600_000
    case "d":
      return value * 86_400_000
    case "w":
      return value * 604_800_000
    default:
      return value * 1000
  }
}

/** The smaller of two bounds, either of which may be absent. */
function minTxid(a: bigint | null, b: bigint | null): bigint {
  if (a === null) return b ?? 0n
  if (b === null) return a
  return a < b ? a : b
}

export interface ShipperOptions {
  store: S3Store
  /** `s3.prefix`; the layout module normalises it. */
  prefix: string
  db: string
  /** Ship an accumulated batch after this long. Default 1000 ms. */
  shipIntervalMs?: number
  /** Take and ship a snapshot this often. 0 disables the timer. Default 1 h. */
  snapshotIntervalMs?: number
  /** Take and ship a snapshot after this many record bytes. 0 disables it. Default 64 MB. */
  snapshotEveryBytes?: number
  /** Queue ceiling before the buffer is dropped and `behind` goes true. Default 64 MB. */
  maxPendingBytes?: number
  /** Largest plain body of one segment object. Default 16 MB. */
  maxBatchBytes?: number
  /** Delete objects older than this. 0 keeps everything. Default 30 d. */
  retentionMs?: number
  /** Run the retention sweep at most this often. Default 60 s. */
  retentionSweepMs?: number
  onError?: (err: unknown) => void
}

/** What `/v1/db/:db/backup`, `/v1/db/:db/replication` and `/metrics` report. */
export interface ShipperState {
  db: string
  bucket: string
  prefix: string
  endpoint: string | null
  generation: string | null
  /** Highest txid in the bucket. */
  shippedTxid: number
  /** Records committed since `shippedTxid`. */
  pendingRecords: number
  pendingBytes: number
  /** True once the queue overflowed or an upload failed and the bucket is behind the tenant. */
  behind: boolean
  lastError: string | null
  /** How long the last successful drain took, in milliseconds. */
  lastShipMs: number
  lastShipAtMs: number | null
  bytesShipped: number
  errors: number
  snapshots: number
  segments: number
  lastSnapshotTxid: number | null
}

/** One tenant's continuous backup. */
export class Shipper {
  readonly db: string
  readonly store: S3Store
  readonly prefix: string
  readonly shipIntervalMs: number
  readonly snapshotIntervalMs: number
  readonly snapshotEveryBytes: number
  readonly maxPendingBytes: number
  readonly maxBatchBytes: number
  readonly retentionMs: number
  readonly retentionSweepMs: number

  #tenant: Tenant | null = null
  #unhook: (() => void) | null = null
  #manifest: Manifest | null = null
  #shippedTxid = 0n
  /**
   * The frozen part of the segment inventory (`docs/r9-segment-index.md`). `#manifest.segments`
   * is always the *whole* inventory — every reader of it, from `planRestore` to retention, wants
   * it whole — and these say which of those entries are already in a chunk object and therefore
   * do not belong in the manifest body.
   */
  #chunks: IndexChunkRef[] = []
  #frozen = new Set<string>()

  /** Encoded records since `#shippedTxid`, oldest first. Dropped whole when it gets too big. */
  #queue: Uint8Array[] = []
  #queueFrom = 0n
  #queueBytes = 0
  /** Records committed since `#shippedTxid`, whether or not the queue still holds them. */
  #pendingRecords = 0
  #pendingBytes = 0

  #timer: ReturnType<typeof setTimeout> | null = null
  #draining: Promise<void> | null = null
  #again = false
  #closed = false

  #behind = false
  #lastError: string | null = null
  #lastShipMs = 0
  #lastShipAtMs: number | null = null
  #bytesShipped = 0
  #errors = 0
  #lastSegmentCount = 0
  #lastSnapshotAtMs = 0
  #bytesSinceSnapshot = 0
  #lastRetentionMs = 0
  #onError: (err: unknown) => void

  constructor(options: ShipperOptions) {
    this.db = options.db
    this.store = options.store
    this.prefix = options.prefix
    this.shipIntervalMs = options.shipIntervalMs ?? 1000
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 3_600_000
    this.snapshotEveryBytes = options.snapshotEveryBytes ?? 64 * 1024 * 1024
    this.maxPendingBytes = options.maxPendingBytes ?? 64 * 1024 * 1024
    this.maxBatchBytes = options.maxBatchBytes ?? 16 * 1024 * 1024
    this.retentionMs = options.retentionMs ?? 30 * 86_400_000
    this.retentionSweepMs = options.retentionSweepMs ?? 60_000
    this.#onError = options.onError ?? (() => {})
  }

  get tenant(): Tenant | null {
    return this.#tenant
  }

  get bound(): boolean {
    return this.#tenant !== null && !this.#tenant.closed
  }

  get shippedTxid(): bigint {
    return this.#shippedTxid
  }

  get behind(): boolean {
    return this.#behind
  }

  get errors(): number {
    return this.#errors
  }

  get bytesShipped(): number {
    return this.#bytesShipped
  }

  /** True when the tenant has committed past what the bucket holds. */
  get hasWork(): boolean {
    const tenant = this.#tenant
    if (!tenant || tenant.closed) return this.#pendingRecords > 0
    return tenant.txid > this.#shippedTxid
  }

  state(): ShipperState {
    const described = this.store.describe()
    const manifest = this.#manifest
    const snapshots = manifest?.snapshots ?? []
    return {
      db: this.db,
      bucket: described.bucket,
      prefix: this.prefix,
      endpoint: described.endpoint,
      generation: manifest?.generation ?? null,
      shippedTxid: Number(this.#shippedTxid),
      pendingRecords: this.#pendingRecords,
      pendingBytes: this.#pendingBytes,
      behind: this.#behind,
      lastError: this.#lastError,
      lastShipMs: this.#lastShipMs,
      lastShipAtMs: this.#lastShipAtMs,
      bytesShipped: this.#bytesShipped,
      errors: this.#errors,
      snapshots: snapshots.length,
      segments: manifest?.segments.length ?? 0,
      lastSnapshotTxid: snapshots.length > 0 ? Number(snapshots[snapshots.length - 1]?.txid) : null,
    }
  }

  // ── binding ──────────────────────────────────────────────────────────────────────────────────

  /** Subscribes to a tenant's commits. Rebinding to a reopened tenant keeps the bucket position. */
  bind(tenant: Tenant): void {
    if (this.#closed) return
    if (this.#tenant === tenant && this.#unhook) return
    this.unbind()
    this.#tenant = tenant
    this.#lastSegmentCount = tenant.log.segmentCount
    this.#unhook = tenant.onCommit((event) => this.#onCommit(event))
    // A tenant that was evicted and reopened may have committed while nothing was listening; the
    // pending counters are rebuilt from the gap rather than assumed to be zero.
    this.#syncPending(tenant)
    if (this.hasWork) this.#arm(0)
  }

  unbind(): void {
    this.#unhook?.()
    this.#unhook = null
    this.#tenant = null
  }

  /** Stops the timer, drains what is left, and detaches. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#disarm()
    try {
      if (this.#draining) await this.#draining
      // `#closed` short-circuits `#arm`, not `#drain`, so a last pass still runs.
      if (this.#tenant && !this.#tenant.closed && this.hasWork) await this.#drainOnce()
    } catch (err) {
      this.#onError(err)
    }
    this.unbind()
  }

  /** Ships everything outstanding now and waits for it. What the tests and `close` use. */
  async flush(): Promise<void> {
    this.#disarm()
    await this.#kick()
    // A drain that was already running may have started before the newest commit; one more pass
    // is what makes `flush()` mean "the bucket is caught up", which is what a caller wants.
    if (this.hasWork) await this.#kick()
  }

  // -------------------------------------------------------------------------

  #onCommit(event: CommitEvent): void {
    this.#pendingRecords += 1
    this.#pendingBytes += event.bytes.byteLength

    if (this.#queue.length === 0) this.#queueFrom = event.txid
    this.#queue.push(event.bytes)
    this.#queueBytes += event.bytes.byteLength
    if (this.#queueBytes > this.maxPendingBytes) {
      // The bucket is not keeping up. Drop the buffer rather than grow it: every one of these
      // records is already in the log, and the next drain reads them from there.
      this.#dropQueue()
      this.#behind = true
    }

    const tenant = this.#tenant
    if (tenant) {
      const segments = tenant.log.segmentCount
      if (segments !== this.#lastSegmentCount) {
        this.#lastSegmentCount = segments
        // A segment that has closed is final; shipping it now is what keeps the bucket's segment
        // boundaries the same as the log's whenever the log is setting the pace.
        this.#arm(0)
        return
      }
    }
    if (this.#queueBytes >= this.maxBatchBytes) {
      this.#arm(0)
      return
    }
    this.#arm(this.shipIntervalMs)
  }

  #dropQueue(): void {
    this.#queue = []
    this.#queueBytes = 0
    this.#queueFrom = 0n
  }

  /** Rebuilds the pending counters from the gap between the bucket and the tenant. */
  #syncPending(tenant: Tenant): void {
    if (tenant.txid <= this.#shippedTxid) {
      this.#pendingRecords = 0
      this.#pendingBytes = 0
      return
    }
    const gap = tenant.txid - this.#shippedTxid
    if (BigInt(this.#pendingRecords) >= gap) return
    this.#pendingRecords = Number(gap)
  }

  #arm(delayMs: number): void {
    if (this.#closed || this.#timer !== null) return
    const timer = setTimeout(() => {
      this.#timer = null
      void this.#kick().catch((err) => this.#onError(err))
    }, delayMs)
    timer.unref?.()
    this.#timer = timer
  }

  #disarm(): void {
    if (this.#timer === null) return
    clearTimeout(this.#timer)
    this.#timer = null
  }

  /** One drain at a time. A kick during a drain sets a flag rather than starting a second. */
  async #kick(): Promise<void> {
    if (this.#draining) {
      this.#again = true
      await this.#draining
      return
    }
    this.#draining = this.#drainOnce().finally(() => {
      this.#draining = null
    })
    await this.#draining
    while (this.#again) {
      this.#again = false
      if (!this.hasWork) break
      await this.#kick()
    }
  }

  async #drainOnce(): Promise<void> {
    const tenant = this.#tenant
    if (!tenant || tenant.closed) return
    const startedMs = Date.now()
    try {
      const manifest = await this.#load(tenant)
      await this.#ensureBase(tenant, manifest)
      await this.#shipLocalSnapshots(tenant, manifest)
      await this.#shipSegments(tenant, manifest)
      await this.#maybeSnapshot(tenant, manifest)
      await this.#writeManifest(manifest)
      await this.#maybeRetain(manifest)

      this.#lastError = null
      this.#lastShipMs = Date.now() - startedMs
      this.#lastShipAtMs = Date.now()
      this.#behind = tenant.txid > this.#shippedTxid
      if (!this.#behind) {
        this.#pendingRecords = 0
        this.#pendingBytes = 0
      }
    } catch (err) {
      this.#errors += 1
      this.#behind = true
      this.#lastError = err instanceof Error ? err.message : String(err)
      this.#onError(err)
      // A failed upload is retried on the next interval, not in a tight loop: the bucket is
      // already telling us it is unhappy.
      this.#arm(this.shipIntervalMs)
    }
  }

  // ── the pieces of a drain ────────────────────────────────────────────────────────────────────

  async #load(tenant: Tenant): Promise<Manifest> {
    if (this.#manifest) return this.#manifest
    const key = manifestKey(this.prefix, this.db)
    const body = await this.store.getOrNull(key)
    let manifest = body === null ? null : decodeManifest(body)
    if (manifest === null) {
      manifest = emptyManifest(this.db, tenant.pageSize, newGenerationId())
    } else {
      // A version-1 manifest carries its whole inventory and has no chunks; a version-2 one
      // carries the tail, and the rest is under `index/`. Either way what comes back here is the
      // whole thing, which is what every reader below expects.
      if (manifest.version >= 2) {
        const index = await loadIndex(this.store, this.prefix, this.db, manifest.segments)
        manifest.segments = index.segments
        this.#chunks = index.chunks
        this.#frozen = new Set(
          index.chunks.flatMap((chunk) => chunk.entries.map((one) => one.key)),
        )
      }
      manifest = normalizeManifest(manifest)
    }

    let shipped = BigInt(manifest.shippedTxid)
    if (shipped > tenant.txid) {
      // The bucket is ahead of this database, which means it is not the same timeline any more —
      // a restore shipped back into the same prefix, or a fork. Start a generation rather than
      // interleave two histories under one.
      const generation = newGenerationId()
      manifest.generations.push({
        id: generation,
        startedAtMs: Date.now(),
        firstTxid: tenant.txid.toString(),
        lastTxid: tenant.txid.toString(),
      })
      manifest.generation = generation
      shipped = 0n
    }
    this.#shippedTxid = shipped
    this.#manifest = manifest
    this.#syncPending(tenant)
    return manifest
  }

  /**
   * A restore has to start somewhere. A log that still reaches back to txid 1 is its own base —
   * the records replay onto an empty database, which is what the local PITR path already does —
   * so the usual young database never pays for a snapshot at all. Only a log whose first record
   * has aged out needs one, and taking it is the one thing here that makes the tenant exclusive
   * for the length of a file copy.
   */
  async #ensureBase(tenant: Tenant, manifest: Manifest): Promise<void> {
    const mine = manifest.snapshots.filter((one) => one.generation === manifest.generation)
    if (mine.length > 0) return
    // "Covered from txid 1" is a property of what is already in the bucket once anything is, and
    // only of the local log before that. Asking the log after the first drain would take a
    // snapshot on every pass and leave the segment inventory with a hole where it jumped to it.
    const shipped = manifest.segments.filter((one) => one.generation === manifest.generation)
    const covered =
      shipped.length > 0
        ? BigInt(shipped[0]?.startTxid ?? "0") === 1n
        : tenant.log.firstTxid === 1n
    if (covered) return
    const ref = await tenant.snapshot()
    await this.#shipSnapshot(manifest, ref)
    const txid = BigInt(ref.txid)
    if (txid > this.#shippedTxid) this.#shippedTxid = txid
    this.#lastSnapshotAtMs = Date.now()
    this.#bytesSinceSnapshot = 0
  }

  /**
   * Ships any snapshot the tenant has taken that the bucket does not hold. A snapshot *at* the
   * txid the bucket has already reached is the valuable one, not a redundant one: it is what lets
   * retention drop the segments below it.
   */
  async #shipLocalSnapshots(tenant: Tenant, manifest: Manifest): Promise<void> {
    const mine = manifest.snapshots.filter((one) => one.generation === manifest.generation)
    const have = new Set(mine.map((one) => one.txid))
    const segments = manifest.segments.filter((one) => one.generation === manifest.generation)
    // The oldest point this generation can restore to. A snapshot below it could never be the
    // base for anything in range, so shipping it would be bytes for nothing.
    const floor =
      segments.length > 0 || mine.length > 0
        ? minTxid(
            segments.length > 0 ? BigInt(segments[0]?.startTxid ?? "1") - 1n : null,
            mine.length > 0 ? BigInt(mine[0]?.txid ?? "0") : null,
          )
        : 0n

    for (const ref of listSnapshots(tenant.dir)) {
      if (have.has(ref.txid)) continue
      const txid = BigInt(ref.txid)
      if (txid < floor) continue
      await this.#shipSnapshot(manifest, ref)
      this.#lastSnapshotAtMs = Date.now()
      this.#bytesSinceSnapshot = 0
    }
  }

  async #shipSnapshot(manifest: Manifest, ref: SnapshotRef): Promise<void> {
    const txid = BigInt(ref.txid)
    const plain = new Uint8Array(fs.readFileSync(ref.path))
    const body = new Uint8Array(Bun.zstdCompressSync(plain, { level: 3 }))
    const key = snapshotKey(this.prefix, this.db, txid)
    await this.store.put(key, body, "application/zstd")
    this.#bytesShipped += body.byteLength

    const entry: SnapshotEntry = {
      key,
      generation: manifest.generation,
      txid: ref.txid,
      epoch: ref.epoch,
      pages: ref.pages,
      pageSize: ref.pageSize,
      checksum: ref.checksum,
      bytes: body.byteLength,
      plainBytes: plain.byteLength,
      hash: Bun.hash.xxHash3(plain).toString(),
      createdAtMs: ref.createdAtMs,
    }
    manifest.snapshots = [
      ...manifest.snapshots.filter(
        (one) => !(one.generation === manifest.generation && one.txid === entry.txid),
      ),
      entry,
    ]
    if (manifest.pageSize === 0) manifest.pageSize = ref.pageSize
  }

  /** Uploads everything from `shippedTxid + 1` to the tenant's txid, in `maxBatchBytes` batches. */
  async #shipSegments(tenant: Tenant, manifest: Manifest): Promise<void> {
    const target = tenant.txid
    if (target <= this.#shippedTxid) return

    for (;;) {
      const from = this.#shippedTxid + 1n
      if (from > target) return
      const batch = this.#collect(tenant, from, target)
      if (batch === null) return
      if (batch.records === 0) return

      const key = segmentKey(this.prefix, this.db, batch.startTxid, batch.endTxid)
      const body = new Uint8Array(Bun.zstdCompressSync(batch.plain, { level: 3 }))
      await this.store.put(key, body, "application/zstd")
      this.#bytesShipped += body.byteLength
      this.#bytesSinceSnapshot += batch.plain.byteLength

      const entry: SegmentEntry = {
        key,
        generation: manifest.generation,
        startTxid: batch.startTxid.toString(),
        endTxid: batch.endTxid.toString(),
        records: batch.records,
        bytes: body.byteLength,
        plainBytes: batch.plain.byteLength,
        hash: Bun.hash.xxHash3(batch.plain).toString(),
        createdAtMs: Date.now(),
      }
      manifest.segments = [
        ...manifest.segments.filter((one) => one.key !== key),
        entry,
      ]
      this.#shippedTxid = batch.endTxid
      this.#consume(batch.endTxid)
    }
  }

  /**
   * The records for one segment object. The queue is used when it starts exactly where the bucket
   * stops; otherwise the log is read, which is the path a dropped queue, a restart or a rebind
   * takes. A `LogGap` here means the log aged out records the bucket never got: the only honest
   * answer is a fresh snapshot, which the caller's next pass takes.
   */
  #collect(
    tenant: Tenant,
    from: bigint,
    target: bigint,
  ): { plain: Uint8Array; startTxid: bigint; endTxid: bigint; records: number } | null {
    const parts: Uint8Array[] = []
    let total = 0
    let records = 0
    let endTxid = from - 1n

    const take = (txid: bigint, bytes: Uint8Array): boolean => {
      if (total > 0 && total + bytes.byteLength > this.maxBatchBytes) return false
      parts.push(bytes)
      total += bytes.byteLength
      records += 1
      endTxid = txid
      return txid < target
    }

    if (this.#queue.length > 0 && this.#queueFrom === from) {
      let txid = this.#queueFrom
      for (const bytes of this.#queue) {
        if (txid > target) break
        if (!take(txid, bytes)) break
        txid += 1n
      }
    } else {
      let iterator: IterableIterator<{ txid: bigint; bytes: Uint8Array }>
      try {
        iterator = tenant.log.iterateEncoded(from)
      } catch (err) {
        if (err instanceof LogGap) {
          // The records are gone. Reset to a snapshot-only base: `#maybeSnapshot` takes one on
          // this pass and the generation continues from it, with the gap visible in the manifest
          // so a restore into it fails loudly rather than quietly skipping transactions.
          this.#behind = true
          this.#lastError = err.message
          this.#bytesSinceSnapshot = this.snapshotEveryBytes
          this.#lastSnapshotAtMs = 0
          this.#dropQueue()
          return null
        }
        throw err
      }
      for (const record of iterator) {
        if (record.txid < from) continue
        if (record.txid > target) break
        // The iterator's slices are views into a buffer it reuses per segment, so a copy is what
        // keeps a batch that spans two segments correct.
        if (!take(record.txid, new Uint8Array(record.bytes))) break
      }
    }

    if (records === 0) return null
    const plain = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      plain.set(part, at)
      at += part.byteLength
    }
    return { plain, startTxid: from, endTxid, records }
  }

  /** Drops everything the bucket now holds off the front of the queue. */
  #consume(throughTxid: bigint): void {
    if (this.#queue.length === 0) return
    if (this.#queueFrom > throughTxid) return
    const drop = Number(throughTxid - this.#queueFrom) + 1
    if (drop >= this.#queue.length) {
      this.#dropQueue()
      return
    }
    for (let i = 0; i < drop; i++) {
      this.#queueBytes -= (this.#queue[i] as Uint8Array).byteLength
    }
    this.#queue = this.#queue.slice(drop)
    this.#queueFrom = throughTxid + 1n
  }

  /** The `snapshotIntervalMs` / `snapshotEveryBytes` policy. */
  async #maybeSnapshot(tenant: Tenant, manifest: Manifest): Promise<void> {
    const byTime =
      this.snapshotIntervalMs > 0 &&
      this.#lastSnapshotAtMs > 0 &&
      Date.now() - this.#lastSnapshotAtMs >= this.snapshotIntervalMs
    const byBytes =
      this.snapshotEveryBytes > 0 && this.#bytesSinceSnapshot >= this.snapshotEveryBytes
    if (!byTime && !byBytes) return
    if (
      manifest.snapshots.some(
        (one) => one.generation === manifest.generation && BigInt(one.txid) === tenant.txid,
      )
    ) {
      this.#lastSnapshotAtMs = Date.now()
      this.#bytesSinceSnapshot = 0
      return
    }
    const ref = await tenant.snapshot()
    await this.#shipSnapshot(manifest, ref)
    const txid = BigInt(ref.txid)
    if (txid > this.#shippedTxid) this.#shippedTxid = txid
    this.#lastSnapshotAtMs = Date.now()
    this.#bytesSinceSnapshot = 0
  }

  /** Last of all, and only once everything it names is durable. */
  async #writeManifest(manifest: Manifest): Promise<void> {
    const next = normalizeManifest({ ...manifest, updatedAtMs: Date.now() })
    manifest.snapshots = next.snapshots
    manifest.segments = next.segments
    manifest.generations = next.generations
    manifest.shippedTxid = next.shippedTxid
    manifest.updatedAtMs = next.updatedAtMs
    await this.#freeze(next)
    await this.#putManifest(next)
  }

  /** The manifest body: everything, with only the unfrozen tail of the segment inventory. */
  async #putManifest(manifest: Manifest): Promise<void> {
    const body = encodeManifest({ ...manifest, segments: this.#tailOf(manifest.segments) })
    await this.store.put(manifestKey(this.prefix, this.db), body, "application/json")
    this.#bytesShipped += body.length
  }

  #tailOf(segments: SegmentEntry[]): SegmentEntry[] {
    if (this.#frozen.size === 0) return segments
    return segments.filter((one) => !this.#frozen.has(one.key))
  }

  /**
   * Moves the oldest of the tail into immutable chunk objects, so the manifest body stops growing
   * with the age of the database (`docs/r9-segment-index.md`).
   *
   * Written **before** the manifest that drops them from the tail, which leaves one crash window:
   * the entries are then in both the chunk and the tail, and `mergeInventory` resolves that to one
   * entry. The other order would lose them.
   */
  async #freeze(manifest: Manifest): Promise<void> {
    let tail = this.#tailOf(manifest.segments)
    // `>=`, not `>`: a chunk is only ever written full, so the number of chunk objects a restore
    // has to enumerate is exactly `segments / INDEX_CHUNK` rather than one per drain.
    while (tail.length >= INDEX_CHUNK) {
      const take = tail.slice(0, INDEX_CHUNK)
      const first = take[0] as SegmentEntry
      const last = take.at(-1) as SegmentEntry
      const key = indexChunkKey(
        this.prefix,
        this.db,
        BigInt(first.startTxid),
        BigInt(last.endTxid),
      )
      const body = encodeIndexChunk(this.db, take)
      await this.store.put(key, body, "application/json")
      this.#bytesShipped += body.length
      this.#chunks.push({ key, entries: take })
      for (const entry of take) this.#frozen.add(entry.key)
      tail = tail.slice(INDEX_CHUNK)
    }
  }

  /**
   * Retention in the bucket. Snapshots past `retentionMs` go, and with them every segment below
   * the oldest snapshot that survives — never a segment a surviving snapshot would need to replay
   * from, whatever its age. The newest snapshot is always kept.
   */
  async #maybeRetain(manifest: Manifest): Promise<void> {
    if (this.retentionMs <= 0) return
    const now = Date.now()
    if (now - this.#lastRetentionMs < this.retentionSweepMs) return
    this.#lastRetentionMs = now

    const cutoff = now - this.retentionMs
    const keptSnapshots: SnapshotEntry[] = []
    const doomed: string[] = []
    for (let i = 0; i < manifest.snapshots.length; i++) {
      const snapshot = manifest.snapshots[i] as SnapshotEntry
      const newest = i === manifest.snapshots.length - 1
      if (!newest && snapshot.createdAtMs < cutoff) {
        doomed.push(snapshot.key)
        continue
      }
      keptSnapshots.push(snapshot)
    }

    const oldestKept = keptSnapshots[0]
    const floor = oldestKept ? BigInt(oldestKept.txid) : 0n
    const keptSegments: SegmentEntry[] = []
    for (const segment of manifest.segments) {
      // A segment that straddles the oldest surviving snapshot is what that snapshot replays
      // from; only one wholly below it can go.
      if (BigInt(segment.endTxid) < floor) {
        doomed.push(segment.key)
        continue
      }
      keptSegments.push(segment)
    }

    if (doomed.length === 0) return
    // The manifest is narrowed *first*, so a reader never sees it naming an object that is gone.
    manifest.snapshots = keptSnapshots
    manifest.segments = keptSegments
    const superseded = await this.#pruneChunks(new Set(keptSegments.map((one) => one.key)))
    const narrowed = normalizeManifest({ ...manifest, updatedAtMs: now })
    manifest.shippedTxid = narrowed.shippedTxid
    manifest.generations = narrowed.generations
    await this.#putManifest(narrowed)
    await this.store.deleteMany([...doomed, ...superseded])
  }

  /**
   * Retention prunes from the front, so this is bounded rather than a rewrite of the index: a
   * chunk wholly below the floor goes, the one chunk that straddles it is rewritten under a new
   * key covering only its survivors, and everything above is untouched.
   *
   * Returns the keys of the chunks the caller should delete — after the manifest has been
   * narrowed, like every other deletion here.
   */
  async #pruneChunks(kept: Set<string>): Promise<string[]> {
    const superseded: string[] = []
    const next: IndexChunkRef[] = []
    for (const chunk of this.#chunks) {
      const survivors = chunk.entries.filter((one) => kept.has(one.key))
      if (survivors.length === chunk.entries.length) {
        next.push(chunk)
        continue
      }
      superseded.push(chunk.key)
      if (survivors.length === 0) continue
      const first = survivors[0] as SegmentEntry
      const last = survivors.at(-1) as SegmentEntry
      const key = indexChunkKey(
        this.prefix,
        this.db,
        BigInt(first.startTxid),
        BigInt(last.endTxid),
      )
      const body = encodeIndexChunk(this.db, survivors)
      await this.store.put(key, body, "application/json")
      this.#bytesShipped += body.length
      next.push({ key, entries: survivors })
    }
    if (superseded.length === 0) return []
    this.#chunks = next
    this.#frozen = new Set(next.flatMap((chunk) => chunk.entries.map((one) => one.key)))
    return superseded
  }

  /**
   * Removes objects the manifest does not name and the bucket no longer needs — what a crash
   * between an upload and the manifest write leaves behind. Only keys wholly at or below
   * `shippedTxid` are touched: those txids are already described by an object the manifest *does*
   * name, so nothing can ever want them. Anything above is left alone, because a shipper on
   * another node could be mid-upload. Returns the keys removed.
   */
  async sweepStrays(): Promise<string[]> {
    const manifest = this.#manifest
    if (!manifest) return []
    const known = new Set([
      ...manifest.snapshots.map((one) => one.key),
      ...manifest.segments.map((one) => one.key),
    ])
    const strays: string[] = []
    for (const prefix of [
      snapshotPrefix(this.prefix, this.db),
      segmentPrefix(this.prefix, this.db),
    ]) {
      for (const object of await this.store.list({ prefix })) {
        if (known.has(object.key)) continue
        const snapshot = parseSnapshotKey(object.key)
        const segment = parseSegmentKey(object.key)
        const high = snapshot ?? segment?.endTxid ?? null
        if (high === null || high > this.#shippedTxid) continue
        strays.push(object.key)
      }
    }
    // An index chunk this shipper does not hold is what a crash between freezing one and writing
    // the manifest leaves behind. Harmless while its segments are alive — `mergeInventory` folds
    // the duplicate away — but once retention has removed those segments it names objects that
    // are gone, which is the one thing a reader is promised never to meet.
    const mine = new Set(this.#chunks.map((one) => one.key))
    for (const object of await this.store.list({ prefix: indexPrefix(this.prefix, this.db) })) {
      if (mine.has(object.key)) continue
      const range = parseIndexChunkKey(object.key)
      if (range === null || range.endTxid > this.#shippedTxid) continue
      strays.push(object.key)
    }
    if (strays.length > 0) await this.store.deleteMany(strays)
    return strays
  }
}
