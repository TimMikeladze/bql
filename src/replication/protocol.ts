// The node-to-node wire format of design §8, made exact by `docs/plan-phase1.md`. One WebSocket
// per node pair, opened by the replica, carrying every database that replica follows.
//
//   frame := type u8 | len u32 BE | body[len]
//
// Invariant: a frame is complete or it does not exist. `FrameReader` hands out whole bodies only,
// so nothing downstream ever sees a partial record — a WebSocket message boundary has no meaning
// here, and a 4 MiB `TXN` may well arrive as six of them.
//
// Second invariant: this module does no I/O and holds no sockets. Everything here is a pure
// function of bytes, which is what makes the codec testable without a server on either end.

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

/** Bun's default `maxPayloadLength`, and the cap this codec refuses to encode or decode past. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024

export const FRAME_HEADER_SIZE = 5

/**
 * Protocol version carried in every `HELLO`. Still 1 after R7 added `generations` to `HELLO` and
 * `HEARTBEAT` and `generation` to `SUBSCRIBE`/`SUBSCRIBED`: every one of those fields is optional
 * and additive, so a peer that sends none of them behaves exactly as version 1 always did. That
 * is the same call `docs/r1-replication.md` deviation 2 made when `HEARTBEAT` gained `databases`.
 */
export const PROTO_VERSION = 1

export const FRAME = {
  HELLO: 0x01,
  SUBSCRIBE: 0x02,
  SUBSCRIBED: 0x03,
  SNAPSHOT_BEGIN: 0x04,
  SNAPSHOT_CHUNK: 0x05,
  SNAPSHOT_END: 0x06,
  TXN: 0x07,
  ACK: 0x08,
  HEARTBEAT: 0x09,
  FORWARD: 0x0a,
  RESULT: 0x0b,
  UNSUBSCRIBE: 0x0c,
  ERROR: 0x0d,
} as const

export type FrameType = (typeof FRAME)[keyof typeof FRAME]

const FRAME_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(FRAME).map(([name, type]) => [type, name]),
)

/** Human-readable name of a frame type, for errors and logs. */
export function frameName(type: number): string {
  return FRAME_NAMES[type] ?? `0x${type.toString(16).padStart(2, "0")}`
}

/** Design §8's error codes, plus the two `plan-phase1.md` adds for bootstrap decisions. */
export type ReplicationErrorCode =
  | "AUTH_FAILED"
  | "PROTO"
  | "UNKNOWN_DB"
  | "EPOCH_AHEAD"
  | "DIVERGED"
  | "RETENTION"
  | "BUSY"
  | "INTERNAL"

/** Codes that end the connection rather than one stream. */
export const FATAL_CODES: ReadonlySet<string> = new Set(["AUTH_FAILED", "PROTO", "BUSY"])

// ── JSON bodies ────────────────────────────────────────────────────────────────────────────────

/**
 * `HELLO`. The primary sends it first with a `nonce`; the replica answers with a `proof`; the
 * primary then sends a third one with `ok` and the databases it holds — see
 * `docs/r1-replication.md` deviation 1 for why the database list cannot ride on the first frame.
 */
export interface HelloBody {
  proto: number
  node: string
  /** Primary's first frame: 32 random bytes, base64. */
  nonce?: string
  /** Replica's answer: `base64(HMAC-SHA256(clusterSecret, nonce))`. */
  proof?: string
  /** Primary's third frame: the handshake succeeded. */
  ok?: boolean
  /** Primary's third frame: every live database, so `follow: ["*"]` can be resolved. */
  databases?: string[]
  /**
   * Primary's third frame: `name -> generation id` for every name in `databases`. A name is not an
   * identity — one `beta` is not the next `beta` — and this is what tells them apart. Absent from a
   * peer that predates R7, which a replica reads as "no identity to check" (`docs/r7-unfollow.md`).
   */
  generations?: Record<string, string>
}

export interface SubscribeBody {
  /** Replica-chosen u32, unique per connection; addresses the database on every binary frame. */
  stream: number
  db: string
  /** Last txid the replica holds, as a decimal string (u64 does not survive JSON as a number). */
  fromTxid: string
  epoch: number
  /** The replica's rolling database checksum at `fromTxid`, decimal. */
  checksum: string
  /**
   * "My local file cannot be trusted at `fromTxid`; send a snapshot even at txid 0." Set by a
   * replica that is re-subscribing after an apply it could not verify, which is the one case
   * where `fromTxid: 0` does not mean "I am a pristine database".
   */
  reset?: boolean
  /**
   * The generation id the replica's local copy was bootstrapped under, when it knows one. A
   * primary that holds a different id for this name is holding a different database, and answers
   * with a snapshot however well the txid and the checksum line up.
   */
  generation?: string
}

export interface SubscribedBody {
  stream: number
  db: string
  /** `"stream"`: records follow directly. `"snapshot"`: a snapshot comes first. */
  mode: "stream" | "snapshot"
  /** The txid records will start after. */
  txid: string
  epoch: number
  pageSize: number
  /** This node's generation id for `db`; the replica records it against the copy it ends up with. */
  generation?: string
}

export interface SnapshotBeginBody {
  stream: number
  txid: string
  epoch: number
  /** Rolling database checksum of the snapshot file, decimal. */
  checksum: string
  bytes: number
  pageSize: number
  /** Database size in pages at `txid`; the applier needs it to seed its page source. */
  pages: number
}

export interface SnapshotEndBody {
  stream: number
  txid: string
  /** xxHash3 of the plain (uncompressed) file, decimal. */
  hash: string
}

export interface HeartbeatBody {
  ts: number
  streams: { stream: number; txid: string }[]
  /** Primary only: the live databases, so a `follow: ["*"]` replica sees new ones (deviation 2). */
  databases?: string[]
  /** Primary only: `name -> generation id` for every name in `databases`. See `HelloBody`. */
  generations?: Record<string, string>
}

/** R2. Defined here so both halves agree on the shape before either implements it. */
export interface ForwardBody {
  id: number
  db: string
  op: string
  body: unknown
}

/**
 * R2. `error` is the primary's *own* failure, mapped to the HTTP shape before it left — so a
 * `SQLITE_CONSTRAINT` arrives as a `SQLITE_CONSTRAINT` with its 409 and the client never learns
 * that a second node was involved.
 */
export interface ResultBody {
  id: number
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
    status?: number
    /** The database's txid as the failure saw it. */
    txid?: number
    /** Which statement of a forwarded batch failed. */
    failedIndex?: number
  }
}

export interface UnsubscribeBody {
  stream: number
}

export interface ErrorBody {
  stream?: number
  code: ReplicationErrorCode
  message: string
}

// ── frames ─────────────────────────────────────────────────────────────────────────────────────

export interface Frame {
  type: number
  body: Uint8Array
}

/** A framing failure. Fatal: the socket is closed, because the stream can never resynchronise. */
export class ProtocolError extends Error {
  readonly code: "PROTO" = "PROTO"

  constructor(message: string) {
    super(message)
    this.name = "ProtocolError"
  }
}

/** `type u8 | len u32 BE | body`. */
export function encodeFrame(type: number, body: Uint8Array): Uint8Array {
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new ProtocolError(
      `${frameName(type)} body is ${body.byteLength} bytes, over the ${MAX_BODY_BYTES} limit`,
    )
  }
  const out = new Uint8Array(FRAME_HEADER_SIZE + body.byteLength)
  out[0] = type & 0xff
  new DataView(out.buffer).setUint32(1, body.byteLength, false)
  out.set(body, FRAME_HEADER_SIZE)
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A control frame: the body is UTF-8 JSON. */
export function encodeJson(type: number, body: unknown): Uint8Array {
  return encodeFrame(type, encoder.encode(JSON.stringify(body)))
}

/** Parses a control frame's body. Throws `ProtocolError` rather than a bare `SyntaxError`. */
export function decodeJson<T>(type: number, body: Uint8Array): T {
  try {
    return JSON.parse(decoder.decode(body)) as T
  } catch {
    throw new ProtocolError(`${frameName(type)} body is not valid JSON`)
  }
}

/**
 * Accepts whatever a Bun WebSocket hands over — `Buffer`, `ArrayBuffer`, `Uint8Array` or a string
 * — and yields complete frames. Bytes that do not yet make a whole frame are kept until they do.
 */
export class FrameReader {
  #chunks: Uint8Array[] = []
  #size = 0
  readonly maxBodyBytes: number

  constructor(options: { maxBodyBytes?: number } = {}) {
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  }

  /** Bytes buffered but not yet a whole frame. */
  get buffered(): number {
    return this.#size
  }

  /**
   * Adds one WebSocket message and returns every frame that is now complete. Throws
   * `ProtocolError` for a length past the cap, which is the one framing error a reader can
   * detect without reading the body.
   */
  push(message: string | Uint8Array | ArrayBuffer | ArrayBufferView): Frame[] {
    const bytes = toBytes(message)
    if (bytes.byteLength > 0) {
      this.#chunks.push(bytes)
      this.#size += bytes.byteLength
    }
    const out: Frame[] = []
    for (;;) {
      const frame = this.#next()
      if (!frame) return out
      out.push(frame)
    }
  }

  #next(): Frame | null {
    if (this.#size < FRAME_HEADER_SIZE) return null
    const head = this.#peek(FRAME_HEADER_SIZE)
    const type = head[0] as number
    const length = new DataView(head.buffer, head.byteOffset, FRAME_HEADER_SIZE).getUint32(1, false)
    if (length > this.maxBodyBytes) {
      throw new ProtocolError(
        `${frameName(type)} declares a ${length}-byte body, over the ${this.maxBodyBytes} limit`,
      )
    }
    const total = FRAME_HEADER_SIZE + length
    if (this.#size < total) return null
    const whole = this.#take(total)
    return { type, body: whole.subarray(FRAME_HEADER_SIZE) }
  }

  /** First `n` bytes, contiguous, without consuming them. */
  #peek(n: number): Uint8Array {
    const first = this.#chunks[0] as Uint8Array
    if (first.byteLength >= n) return first.subarray(0, n)
    const out = new Uint8Array(n)
    let at = 0
    for (const chunk of this.#chunks) {
      const take = Math.min(n - at, chunk.byteLength)
      out.set(chunk.subarray(0, take), at)
      at += take
      if (at === n) break
    }
    return out
  }

  /** Removes and returns the first `n` bytes. */
  #take(n: number): Uint8Array {
    const first = this.#chunks[0] as Uint8Array
    if (first.byteLength === n) {
      this.#chunks.shift()
      this.#size -= n
      return first
    }
    if (first.byteLength > n) {
      this.#chunks[0] = first.subarray(n)
      this.#size -= n
      return first.subarray(0, n)
    }
    const out = new Uint8Array(n)
    let at = 0
    while (at < n) {
      const chunk = this.#chunks[0] as Uint8Array
      const take = Math.min(n - at, chunk.byteLength)
      out.set(chunk.subarray(0, take), at)
      at += take
      if (take === chunk.byteLength) this.#chunks.shift()
      else this.#chunks[0] = chunk.subarray(take)
    }
    this.#size -= n
    return out
  }
}

function toBytes(message: string | Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof message === "string") return encoder.encode(message)
  if (message instanceof Uint8Array) return message
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
}

// ── binary bodies ──────────────────────────────────────────────────────────────────────────────

/** `TXN`: `stream u32 | TxnRecord bytes`. The record is the encoding of `src/wal/record.ts`. */
export function encodeTxn(stream: number, record: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + record.byteLength)
  new DataView(body.buffer).setUint32(0, stream >>> 0, false)
  body.set(record, 4)
  return encodeFrame(FRAME.TXN, body)
}

export interface TxnBody {
  stream: number
  record: Uint8Array
}

export function decodeTxn(body: Uint8Array): TxnBody {
  if (body.byteLength < 4) throw new ProtocolError("TXN body is shorter than its stream id")
  return {
    stream: new DataView(body.buffer, body.byteOffset, 4).getUint32(0, false),
    record: body.subarray(4),
  }
}

/** Bit 0 of `ACK.flags`: the replica has fsynced the record. */
export const ACK_FSYNCED = 0x01

/** `ACK`: `stream u32 | txid u64 BE | flags u8`. */
export function encodeAck(stream: number, txid: bigint, flags: number): Uint8Array {
  const body = new Uint8Array(13)
  const view = new DataView(body.buffer)
  view.setUint32(0, stream >>> 0, false)
  view.setBigUint64(4, BigInt.asUintN(64, txid), false)
  view.setUint8(12, flags & 0xff)
  return encodeFrame(FRAME.ACK, body)
}

export interface AckBody {
  stream: number
  txid: bigint
  flags: number
  fsynced: boolean
}

export function decodeAck(body: Uint8Array): AckBody {
  if (body.byteLength !== 13) {
    throw new ProtocolError(`ACK body is ${body.byteLength} bytes, expected 13`)
  }
  const view = new DataView(body.buffer, body.byteOffset, 13)
  const flags = view.getUint8(12)
  return {
    stream: view.getUint32(0, false),
    txid: view.getBigUint64(4, false),
    flags,
    fsynced: (flags & ACK_FSYNCED) !== 0,
  }
}

/** `SNAPSHOT_CHUNK`: `stream u32 | seq u32 | zstd(chunk)`. */
export function encodeSnapshotChunk(stream: number, seq: number, compressed: Uint8Array): Uint8Array {
  const body = new Uint8Array(8 + compressed.byteLength)
  const view = new DataView(body.buffer)
  view.setUint32(0, stream >>> 0, false)
  view.setUint32(4, seq >>> 0, false)
  body.set(compressed, 8)
  return encodeFrame(FRAME.SNAPSHOT_CHUNK, body)
}

export interface SnapshotChunkBody {
  stream: number
  seq: number
  /** Still compressed; the caller decides when to spend the zstd. */
  compressed: Uint8Array
}

export function decodeSnapshotChunk(body: Uint8Array): SnapshotChunkBody {
  if (body.byteLength < 8) throw new ProtocolError("SNAPSHOT_CHUNK body is shorter than its header")
  const view = new DataView(body.buffer, body.byteOffset, 8)
  return {
    stream: view.getUint32(0, false),
    seq: view.getUint32(4, false),
    compressed: body.subarray(8),
  }
}

// ── handshake proof ────────────────────────────────────────────────────────────────────────────

/** 32 bytes of randomness, base64: the nonce a primary challenges a replica with. */
export function makeNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64")
}

/** `base64(HMAC-SHA256(clusterSecret, nonce))`. */
export function makeProof(secret: string, nonce: string): string {
  return createHmac("sha256", secret).update(nonce).digest("base64")
}

// ── database identity ──────────────────────────────────────────────────────────────────────────

/** The byte the three identity inputs are joined with; it cannot occur in a database name. */
const IDENTITY_SEPARATOR = " "

/**
 * A database's generation id: the 64 bits of hex that tell one `beta` from the next one.
 *
 * Deliberately the same shape `newGenerationId()` in `src/storage/layout.ts` mints for a bucket
 * generation, because it is the same concept — "this particular database, not whatever else has
 * worn the name".
 *
 * It is *derived* rather than minted: the catalog has no generation column, so the id is a hash of
 * the three things on a `tenants` row that are fixed for the life of a database and different for
 * a fresh one — its name, its creation timestamp and its page size. Everything else on the row
 * moves: `epoch` on promotion, `txid` and `checksum` on every commit, the WAL salts on every
 * checkpoint. The limit that follows is a delete and a re-create inside one millisecond at the
 * same page size, which collide; `docs/r7-unfollow.md` says so out loud and says what a real
 * column would buy. This function is the single place that column would slot into.
 */
export function generationId(row: { name: string; createdAtMs: number; pageSize: number }): string {
  return createHash("sha256")
    .update([row.name, row.createdAtMs, row.pageSize].join(IDENTITY_SEPARATOR))
    .digest("hex")
    .slice(0, 16)
}

/**
 * Constant-time comparison of a presented proof against the expected one. Length is compared
 * first because `timingSafeEqual` throws on a mismatch, and a length difference is not a secret:
 * it is visible in the frame the attacker sent.
 */
export function verifyProof(secret: string, nonce: string, proof: string | undefined): boolean {
  if (typeof proof !== "string" || proof.length === 0) return false
  const expected = Buffer.from(makeProof(secret, nonce), "base64")
  let presented: Buffer
  try {
    presented = Buffer.from(proof, "base64")
  } catch {
    return false
  }
  if (presented.byteLength !== expected.byteLength) return false
  return timingSafeEqual(presented, expected)
}
