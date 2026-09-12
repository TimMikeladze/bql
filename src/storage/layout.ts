// The bucket layout, which is the contract a restore depends on. Documented in full in
// `docs/r3-storage.md` §1; this module is its only implementation.
//
//   <prefix>db/<name>/manifest.json
//   <prefix>db/<name>/snapshots/<20-digit txid>.db.zst
//   <prefix>db/<name>/segments/<20-digit startTxid>-<20-digit endTxid>.seg.zst
//
// Invariant: keys sort lexicographically in txid order. That is what makes a plain
// `ListObjectsV2` return an ordered inventory with nothing to sort, and it is why every txid is
// zero-padded to twenty digits — the width of `2^64 - 1`, and the same padding `TxnLog` uses for
// its own segment files.
//
// Second invariant: every txid, checksum and hash in the manifest is a **decimal string**. They
// are 64-bit and JSON numbers are doubles, so a number here would silently lose a database.
//
// Third invariant: the manifest is written last, after every object it names is durable. A reader
// that meets an object the manifest does not describe ignores it; a reader that meets a manifest
// naming an object that is not there fails loudly rather than restoring a hole.

/** Width of every txid in a key: `2^64 - 1` is twenty digits. */
export const TXID_WIDTH = 20

export const MANIFEST_VERSION = 1

export function padTxid(txid: bigint): string {
  return txid.toString().padStart(TXID_WIDTH, "0")
}

/** `s3.prefix` as the key builders want it: no leading slash, exactly one trailing slash. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "")
  return trimmed.length === 0 ? "" : `${trimmed}/`
}

/** Where one database's objects live. Everything else here is relative to this. */
export function dbPrefix(prefix: string, db: string): string {
  return `${normalizePrefix(prefix)}db/${db}/`
}

export function manifestKey(prefix: string, db: string): string {
  return `${dbPrefix(prefix, db)}manifest.json`
}

export function snapshotPrefix(prefix: string, db: string): string {
  return `${dbPrefix(prefix, db)}snapshots/`
}

export function segmentPrefix(prefix: string, db: string): string {
  return `${dbPrefix(prefix, db)}segments/`
}

export function snapshotKey(prefix: string, db: string, txid: bigint): string {
  return `${snapshotPrefix(prefix, db)}${padTxid(txid)}.db.zst`
}

export function segmentKey(
  prefix: string,
  db: string,
  startTxid: bigint,
  endTxid: bigint,
): string {
  return `${segmentPrefix(prefix, db)}${padTxid(startTxid)}-${padTxid(endTxid)}.seg.zst`
}

/** The txid a snapshot key names, or null when the key is not one of ours. */
export function parseSnapshotKey(key: string): bigint | null {
  const match = /\/snapshots\/(\d{20})\.db\.zst$/.exec(key)
  return match ? BigInt(match[1] as string) : null
}

/** The `(start, end)` a segment key names, or null when the key is not one of ours. */
export function parseSegmentKey(key: string): { startTxid: bigint; endTxid: bigint } | null {
  const match = /\/segments\/(\d{20})-(\d{20})\.seg\.zst$/.exec(key)
  if (!match) return null
  return { startTxid: BigInt(match[1] as string), endTxid: BigInt(match[2] as string) }
}

// ── manifest ───────────────────────────────────────────────────────────────────────────────────

/** One continuous timeline. A restore resolves its target inside one of these. */
export interface GenerationRef {
  id: string
  startedAtMs: number
  /** Lowest txid this generation's inventory covers, decimal. */
  firstTxid: string
  /** Highest txid this generation's inventory covers, decimal. */
  lastTxid: string
}

export interface SnapshotEntry {
  key: string
  generation: string
  /** Decimal. */
  txid: string
  epoch: number
  /** The *tenant's* page count at `txid`, which is not always the file's own (design §4.3). */
  pages: number
  pageSize: number
  /** The tenant's rolling database checksum at `txid`, decimal. */
  checksum: string
  /** Bytes of the stored (zstd) object. */
  bytes: number
  /** Bytes of the plain SQLite file. */
  plainBytes: number
  /** `xxHash3` of the plain file, decimal. */
  hash: string
  createdAtMs: number
}

export interface SegmentEntry {
  key: string
  generation: string
  /** Decimal, inclusive. */
  startTxid: string
  /** Decimal, inclusive. */
  endTxid: string
  records: number
  bytes: number
  plainBytes: number
  /** `xxHash3` of the plain record stream, decimal. */
  hash: string
  createdAtMs: number
}

export interface Manifest {
  version: number
  db: string
  /** The generation new objects are written under. */
  generation: string
  pageSize: number
  /** Highest txid the inventory covers, decimal. */
  shippedTxid: string
  updatedAtMs: number
  generations: GenerationRef[]
  snapshots: SnapshotEntry[]
  segments: SegmentEntry[]
}

/** A manifest for a database nothing has been shipped for yet. */
export function emptyManifest(db: string, pageSize: number, generation: string): Manifest {
  const now = Date.now()
  return {
    version: MANIFEST_VERSION,
    db,
    generation,
    pageSize,
    shippedTxid: "0",
    updatedAtMs: now,
    generations: [
      { id: generation, startedAtMs: now, firstTxid: "0", lastTxid: "0" },
    ],
    snapshots: [],
    segments: [],
  }
}

/** 64 random bits as hex: a generation id nothing else in the bucket reuses. */
export function newGenerationId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

export function encodeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Parses a manifest and refuses anything that is not one. A half-written body — which is what a
 * torn `PUT` leaves behind on a bucket without atomic writes — fails `JSON.parse` and is reported
 * as a missing manifest rather than an empty one, so a restore never silently finds nothing.
 */
export function decodeManifest(body: Uint8Array | string): Manifest | null {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const manifest = parsed as Partial<Manifest>
  if (manifest.version !== MANIFEST_VERSION) return null
  if (typeof manifest.db !== "string") return null
  if (!Array.isArray(manifest.snapshots) || !Array.isArray(manifest.segments)) return null
  return {
    version: MANIFEST_VERSION,
    db: manifest.db,
    generation: manifest.generation ?? "",
    pageSize: manifest.pageSize ?? 0,
    shippedTxid: manifest.shippedTxid ?? "0",
    updatedAtMs: manifest.updatedAtMs ?? 0,
    generations: manifest.generations ?? [],
    snapshots: manifest.snapshots,
    segments: manifest.segments,
  }
}

/** Sorts the inventory and recomputes `shippedTxid` and the generation bounds. */
export function normalizeManifest(manifest: Manifest): Manifest {
  const snapshots = [...manifest.snapshots].sort(byTxid((s) => BigInt(s.txid)))
  const segments = [...manifest.segments].sort(byTxid((s) => BigInt(s.startTxid)))
  let shipped = 0n
  for (const snapshot of snapshots) {
    const txid = BigInt(snapshot.txid)
    if (txid > shipped) shipped = txid
  }
  for (const segment of segments) {
    const txid = BigInt(segment.endTxid)
    if (txid > shipped) shipped = txid
  }

  const bounds = new Map<string, { first: bigint; last: bigint }>()
  const note = (generation: string, low: bigint, high: bigint): void => {
    const seen = bounds.get(generation)
    if (!seen) {
      bounds.set(generation, { first: low, last: high })
      return
    }
    if (low < seen.first) seen.first = low
    if (high > seen.last) seen.last = high
  }
  for (const snapshot of snapshots) note(snapshot.generation, BigInt(snapshot.txid), BigInt(snapshot.txid))
  for (const segment of segments) {
    note(segment.generation, BigInt(segment.startTxid), BigInt(segment.endTxid))
  }

  const generations = manifest.generations.map((generation) => {
    const seen = bounds.get(generation.id)
    return seen
      ? { ...generation, firstTxid: seen.first.toString(), lastTxid: seen.last.toString() }
      : generation
  })

  return {
    ...manifest,
    shippedTxid: shipped.toString(),
    snapshots,
    segments,
    generations,
  }
}

function byTxid<T>(of: (item: T) => bigint): (a: T, b: T) => number {
  return (a, b) => {
    const left = of(a)
    const right = of(b)
    return left < right ? -1 : left > right ? 1 : 0
  }
}

/**
 * Checks the inventory is a timeline a restore to `at` can actually walk: a snapshot at or before
 * the target, and contiguous segments from that snapshot's txid up to the target. Returns the
 * plan, or the reason there is none.
 */
export interface RestorePlan {
  generation: string
  /**
   * Null means "start from an empty database at txid 0": a generation whose segments reach back
   * to txid 1 is its own base, exactly as the local PITR path rebuilds a young database from its
   * log alone. Every other plan names the snapshot to start from.
   */
  snapshot: SnapshotEntry | null
  /** Where the replay starts, which is the snapshot's txid or 0. */
  fromTxid: bigint
  /** In order, covering `(fromTxid, at]`. Empty when the base is already the target. */
  segments: SegmentEntry[]
  /** The txid the plan reaches, which is `at` unless the inventory ends earlier. */
  reaches: bigint
}

export class RestorePlanError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "RestorePlanError"
    this.code = code
  }
}

/**
 * The plan to reach `at`. `generation` restricts the search; without it the newest generation
 * that can reach the target wins, so a bucket that has been restored into keeps its old timeline
 * restorable for as long as retention holds the objects.
 */
export function planRestore(
  manifest: Manifest,
  at: bigint,
  generation?: string,
): RestorePlan {
  const candidates = generation
    ? [generation]
    : [...new Set([...manifest.generations].reverse().map((one) => one.id))]
  if (candidates.length === 0 && manifest.generation) candidates.push(manifest.generation)

  const reasons: string[] = []
  for (const id of candidates) {
    const mine = manifest.segments.filter((one) => one.generation === id)
    const snapshots = manifest.snapshots.filter(
      (one) => one.generation === id && BigInt(one.txid) <= at,
    )
    let snapshot: SnapshotEntry | null = snapshots.at(-1) ?? null
    if (!snapshot && !(mine[0] && BigInt(mine[0].startTxid) === 1n)) {
      reasons.push(
        `generation ${id} has no snapshot at or before txid ${at} and no segment starting at txid 1`,
      )
      continue
    }
    // A snapshot that is older than the start of a log reaching back to txid 1 buys nothing and
    // costs a download, so the empty base wins whenever both are available.
    if (snapshot && mine[0] && BigInt(mine[0].startTxid) === 1n && BigInt(snapshot.txid) === 0n) {
      snapshot = null
    }
    const from = snapshot ? BigInt(snapshot.txid) : 0n
    if (from === at) return { generation: id, snapshot, fromTxid: from, segments: [], reaches: at }

    const segments: SegmentEntry[] = []
    let next = from + 1n
    for (const segment of mine) {
      const start = BigInt(segment.startTxid)
      const end = BigInt(segment.endTxid)
      if (end < next) continue
      if (start > next) break
      segments.push(segment)
      next = end + 1n
      if (end >= at) break
    }
    const reaches = next - 1n
    if (reaches < at) {
      reasons.push(
        `generation ${id} covers txid ${from} to ${reaches}, which is short of ${at}`,
      )
      continue
    }
    return { generation: id, snapshot, fromTxid: from, segments, reaches: at }
  }

  throw new RestorePlanError(
    "S3_INCOMPLETE",
    `cannot restore ${manifest.db} to txid ${at}: ${reasons.join("; ") || "the bucket holds nothing"}`,
  )
}

/**
 * The highest txid the inventory covers in `generation` (or anywhere). What `at` defaults to,
 * and what `verify` reports as the latest restorable point.
 */
export function latestTxid(manifest: Manifest, generation?: string): bigint {
  let best = 0n
  for (const snapshot of manifest.snapshots) {
    if (generation && snapshot.generation !== generation) continue
    const txid = BigInt(snapshot.txid)
    if (txid > best) best = txid
  }
  for (const segment of manifest.segments) {
    if (generation && segment.generation !== generation) continue
    const txid = BigInt(segment.endTxid)
    if (txid > best) best = txid
  }
  return best
}
