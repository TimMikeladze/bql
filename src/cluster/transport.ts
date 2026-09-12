// The Raft socket: `/v1/cluster/raft`, one WebSocket per direction per peer pair.
//
// Framing, versioning and the handshake are `src/replication/protocol.ts`'s, imported rather than
// copied — `type u8 | len u32 BE | body`, a three-frame HELLO in which the listener challenges
// with a nonce and the dialler answers with `HMAC-SHA256(clusterSecret, nonce)`. A socket that has
// not proved the secret is closed before it can send a single Raft message; there is no state a
// stranger is allowed to touch here, so there is nothing to gain by being lenient.
//
// Invariant: this transport drops, it never queues. A message to a peer that is not connected —
// or to a socket that is backpressured — is discarded on the spot. Raft retries by design: the
// next heartbeat re-sends everything the follower is missing, and `nextIndex` backs up until it
// fits. An unbounded queue would turn a partition into an out-of-memory kill, which is the one
// failure Raft cannot recover from.
//
// Second decision: each node dials every peer and sends only on its own outbound socket, so a pair
// holds two simplex sockets. One socket per pair would save a socket and cost a tie-break that has
// to be right in every partition and every reconnect race; at three to five nodes the socket is
// much the cheaper of the two.
//
// Raft message bodies are UTF-8 JSON with entry payloads base64'd, exactly as the replication
// protocol's control frames are JSON. These are control-plane messages of a few hundred bytes; the
// snapshot, the only thing here that could be large, is kilobytes of cluster state.

import {
  encodeFrame,
  FrameReader,
  makeNonce,
  makeProof,
  ProtocolError,
  PROTO_VERSION,
  verifyProof,
} from "../replication/protocol.ts"
import type { LogEntry, RaftMessage, RaftSnapshot } from "./raft.ts"
import type { NodeId } from "./state.ts"

/** The path `app.ts` will mount this on. */
export const RAFT_PATH = "/v1/cluster/raft"

export const RAFT_FRAME = {
  HELLO: 0x01,
  RAFT: 0x02,
} as const

/** Ceiling for the reconnect backoff, as in `src/replication/replica.ts`. */
const MAX_RECONNECT_MS = 10_000

interface RaftHello {
  proto: number
  node: NodeId
  /** Listener's first frame. */
  nonce?: string
  /** Dialler's answer. */
  proof?: string
  /** Listener's third frame. */
  ok?: boolean
}

/** What this module needs from a Bun `ServerWebSocket`, as `ReplicationSocket` does. */
export interface RaftSocket {
  send(data: Uint8Array | string): number
  close(code?: number, reason?: string): void
  readonly readyState: number
  data: unknown
}

/** The minimum this module needs from a `WebSocket` on the dialling side. */
export interface RaftClientSocket {
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  binaryType: string
  addEventListener(type: string, listener: (event: never) => void): void
}

export type RaftSocketFactory = (url: string) => RaftClientSocket

/** Attached to an accepted socket by `app.ts`: `server.upgrade(request, { data })`. */
export interface RaftSocketData {
  cluster: true
}

/**
 * The one method this module needs from a `Bun.serve` host. Bun types `server.upgrade`'s `data`
 * from the socket data of the `Bun.serve` call it belongs to, so a caller holding an untyped
 * `server` casts to this — which is exactly what `src/server/app.ts` already does for the
 * replication socket.
 */
export interface RaftUpgradeHost {
  upgrade(request: Request, options: { data: RaftSocketData }): boolean
}

export interface RaftTransportOptions {
  id: NodeId
  /** The cluster secret. An empty one disables the endpoint; `onUpgrade` says so. */
  secret: string
  /** Peer id to `ws://host:port` — the advertise addresses from `ClusterState.nodes`. */
  peers?: Record<NodeId, string>
  onMessage: (from: NodeId, message: RaftMessage) => void
  onError?: (err: unknown) => void
  /** First backoff step; doubles with jitter up to 10 s. Default 250 ms. */
  reconnectMs?: number
  /** Injected for the tests; defaults to the global `WebSocket`. */
  factory?: RaftSocketFactory
  /** Injected so the simulator and the tests stay deterministic. Default `Math.random`. */
  random?: () => number
}

interface Inbound {
  ws: RaftSocket
  reader: FrameReader
  nonce: string
  node: NodeId
  authed: boolean
}

interface Outbound {
  url: string
  ws: RaftClientSocket | null
  reader: FrameReader
  ready: boolean
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

export class RaftTransport {
  readonly id: NodeId
  readonly secret: string
  readonly reconnectMs: number

  #peers: Record<NodeId, string>
  #onMessage: (from: NodeId, message: RaftMessage) => void
  #onError: (err: unknown) => void
  #factory: RaftSocketFactory | null
  #random: () => number
  #inbound = new Map<RaftSocket, Inbound>()
  #outbound = new Map<NodeId, Outbound>()
  #started = false
  #closed = false

  constructor(options: RaftTransportOptions) {
    this.id = options.id
    this.secret = options.secret
    this.reconnectMs = options.reconnectMs ?? 250
    this.#peers = { ...(options.peers ?? {}) }
    this.#onMessage = options.onMessage
    this.#onError = options.onError ?? (() => {})
    this.#factory = options.factory ?? null
    this.#random = options.random ?? Math.random
  }

  /** Peers with a live outbound socket. */
  connected(): NodeId[] {
    const out: NodeId[] = []
    for (const [node, peer] of this.#outbound) if (peer.ready) out.push(node)
    return out
  }

  isConnected(node: NodeId): boolean {
    return this.#outbound.get(node)?.ready ?? false
  }

  start(): void {
    if (this.#started || this.#closed) return
    this.#started = true
    for (const [node, url] of Object.entries(this.#peers)) this.#dial(node, url)
  }

  /**
   * Replaces the peer table — membership changes as the state machine learns about them. A peer
   * that is gone has its socket closed; one whose address moved is redialled.
   */
  setPeers(peers: Record<NodeId, string>): void {
    this.#peers = { ...peers }
    for (const [node, peer] of this.#outbound) {
      const url = peers[node]
      if (url === undefined || url !== peer.url) this.#drop(node)
    }
    if (!this.#started) return
    for (const [node, url] of Object.entries(peers)) {
      if (node === this.id || this.#outbound.has(node)) continue
      this.#dial(node, url)
    }
  }

  /** Sends, or drops. Never throws, never queues, never awaits. */
  send(to: NodeId, message: RaftMessage): void {
    const peer = this.#outbound.get(to)
    if (!peer || !peer.ready || !peer.ws) return
    try {
      peer.ws.send(encodeRaft(this.id, message))
    } catch (err) {
      this.#onError(err)
      this.#drop(to)
      this.#redial(to)
    }
  }

  close(): void {
    this.#closed = true
    for (const node of [...this.#outbound.keys()]) this.#drop(node)
    for (const conn of [...this.#inbound.values()]) {
      try {
        conn.ws.close(1001, "shutting down")
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.#inbound.clear()
  }

  // ── the listening half, wired into `app.ts` by the config milestone ──────────────────────────

  /**
   * `server.upgrade(request, { data })` with what this returns, or hand the `Response` back. A
   * node with no cluster secret has no business being joined to, and says so plainly rather than
   * opening a socket that can never authenticate.
   */
  onUpgrade(_request: Request): { data: RaftSocketData } | Response {
    if (this.secret.length === 0) {
      return new Response(
        JSON.stringify({
          error: {
            code: "CLUSTER_DISABLED",
            message: "this node has no cluster secret, so it does not join a raft group",
            status: 403,
          },
        }),
        { status: 403, headers: { "content-type": "application/json; charset=utf-8" } },
      )
    }
    return { data: { cluster: true } }
  }

  onOpen(ws: RaftSocket): void {
    const conn: Inbound = {
      ws,
      reader: new FrameReader(),
      nonce: makeNonce(),
      node: "?",
      authed: false,
    }
    this.#inbound.set(ws, conn)
    const hello: RaftHello = { proto: PROTO_VERSION, node: this.id, nonce: conn.nonce }
    ws.send(encodeJsonFrame(RAFT_FRAME.HELLO, hello))
  }

  onMessage(ws: RaftSocket, data: string | Uint8Array | ArrayBuffer): void {
    const conn = this.#inbound.get(ws)
    if (!conn) return
    let frames: { type: number; body: Uint8Array }[]
    try {
      frames = conn.reader.push(data)
    } catch (err) {
      this.#onError(err)
      ws.close(1002, "framing")
      return
    }
    for (const frame of frames) {
      try {
        this.#handleInbound(conn, frame.type, frame.body)
      } catch (err) {
        this.#onError(err)
        ws.close(1002, err instanceof ProtocolError ? err.message : "protocol")
        return
      }
    }
  }

  onClose(ws: RaftSocket): void {
    this.#inbound.delete(ws)
  }

  #handleInbound(conn: Inbound, type: number, body: Uint8Array): void {
    if (type === RAFT_FRAME.HELLO) {
      const hello = decodeJsonBody<RaftHello>(body)
      if (hello.proto !== PROTO_VERSION) {
        throw new ProtocolError(`raft peer speaks protocol ${hello.proto}, this node speaks ${PROTO_VERSION}`)
      }
      if (!verifyProof(this.secret, conn.nonce, hello.proof)) {
        throw new ProtocolError("raft peer did not prove the cluster secret")
      }
      conn.node = hello.node
      conn.authed = true
      conn.ws.send(encodeJsonFrame(RAFT_FRAME.HELLO, { proto: PROTO_VERSION, node: this.id, ok: true }))
      return
    }
    // The one rule that matters on this side: nothing but the handshake is read from a socket that
    // has not completed it.
    if (!conn.authed) throw new ProtocolError("raft frame before the handshake")
    if (type !== RAFT_FRAME.RAFT) throw new ProtocolError(`unknown raft frame 0x${type.toString(16)}`)
    const { from, message } = decodeRaft(body)
    this.#onMessage(from || conn.node, message)
  }

  // ── the dialling half ────────────────────────────────────────────────────────────────────────

  #dial(node: NodeId, url: string): void {
    if (node === this.id || this.#closed) return
    const peer: Outbound = {
      url,
      ws: null,
      reader: new FrameReader(),
      ready: false,
      attempt: 0,
      timer: null,
      closed: false,
    }
    this.#outbound.set(node, peer)
    this.#connect(node, peer)
  }

  #connect(node: NodeId, peer: Outbound): void {
    if (this.#closed || peer.closed) return
    const factory = this.#factory ?? ((url: string) => new WebSocket(url) as RaftClientSocket)
    let ws: RaftClientSocket
    try {
      ws = factory(peer.url)
    } catch (err) {
      this.#onError(err)
      this.#redial(node)
      return
    }
    ws.binaryType = "arraybuffer"
    peer.ws = ws
    peer.reader = new FrameReader()
    peer.ready = false

    ws.addEventListener("message", ((event: MessageEvent) => {
      if (peer.ws !== ws) return
      let frames: { type: number; body: Uint8Array }[]
      try {
        frames = peer.reader.push(event.data as string | ArrayBuffer)
      } catch (err) {
        this.#onError(err)
        ws.close(1002, "framing")
        return
      }
      for (const frame of frames) {
        try {
          this.#handleOutbound(node, peer, ws, frame.type, frame.body)
        } catch (err) {
          this.#onError(err)
          ws.close(1002, "protocol")
          return
        }
      }
    }) as (event: never) => void)

    ws.addEventListener("close", (() => {
      if (peer.ws !== ws) return
      peer.ws = null
      peer.ready = false
      this.#redial(node)
    }) as (event: never) => void)

    ws.addEventListener("error", (() => {
      // `close` follows; the backoff lives there so a failure is only counted once.
    }) as (event: never) => void)
  }

  #handleOutbound(
    node: NodeId,
    peer: Outbound,
    ws: RaftClientSocket,
    type: number,
    body: Uint8Array,
  ): void {
    if (type !== RAFT_FRAME.HELLO) {
      // The dialling socket is simplex: the peer replies on its own. Anything else is noise.
      return
    }
    const hello = decodeJsonBody<RaftHello>(body)
    if (hello.proto !== PROTO_VERSION) {
      throw new ProtocolError(`raft peer speaks protocol ${hello.proto}, this node speaks ${PROTO_VERSION}`)
    }
    if (typeof hello.nonce === "string") {
      ws.send(
        encodeJsonFrame(RAFT_FRAME.HELLO, {
          proto: PROTO_VERSION,
          node: this.id,
          proof: makeProof(this.secret, hello.nonce),
        }),
      )
      return
    }
    if (hello.ok === true) {
      peer.ready = true
      peer.attempt = 0
    }
  }

  #redial(node: NodeId): void {
    const peer = this.#outbound.get(node)
    if (!peer || peer.closed || this.#closed) return
    if (peer.timer) return
    peer.attempt += 1
    const step = Math.min(this.reconnectMs * 2 ** (peer.attempt - 1), MAX_RECONNECT_MS)
    const delay = step / 2 + this.#random() * (step / 2)
    peer.timer = setTimeout(() => {
      peer.timer = null
      this.#connect(node, peer)
    }, delay)
    // Never let a reconnect keep the process alive; `close()` must leave no handle behind.
    peer.timer.unref?.()
  }

  #drop(node: NodeId): void {
    const peer = this.#outbound.get(node)
    if (!peer) return
    peer.closed = true
    peer.ready = false
    if (peer.timer) clearTimeout(peer.timer)
    peer.timer = null
    const ws = peer.ws
    peer.ws = null
    this.#outbound.delete(node)
    try {
      ws?.close(1000, "peer removed")
    } catch {
      // Already gone.
    }
  }
}

// ── the message codec ──────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function encodeJsonFrame(type: number, body: unknown): Uint8Array {
  return encodeFrame(type, encoder.encode(JSON.stringify(body)))
}

function decodeJsonBody<T>(body: Uint8Array): T {
  try {
    return JSON.parse(decoder.decode(body)) as T
  } catch {
    throw new ProtocolError("raft frame body is not valid JSON")
  }
}

/** `RAFT`: `{ from, message }`, with every `Uint8Array` payload base64'd. */
export function encodeRaft(from: NodeId, message: RaftMessage): Uint8Array {
  return encodeJsonFrame(RAFT_FRAME.RAFT, { from, message: toWire(message) })
}

export function decodeRaft(body: Uint8Array): { from: NodeId; message: RaftMessage } {
  const parsed = decodeJsonBody<{ from?: NodeId; message?: unknown }>(body)
  if (!parsed.message || typeof parsed.message !== "object") {
    throw new ProtocolError("raft frame carries no message")
  }
  return { from: parsed.from ?? "", message: fromWire(parsed.message as WireMessage) }
}

interface WireEntry {
  index: number
  term: number
  kind: string
  data: string
}

type WireMessage = Record<string, unknown> & {
  type: string
  entries?: WireEntry[]
  snapshot?: { index: number; term: number; config: NodeId[]; learners: NodeId[]; data: string }
}

function toWire(message: RaftMessage): WireMessage {
  if (message.type === "appendEntries") {
    return { ...message, entries: message.entries.map(entryToWire) }
  }
  if (message.type === "installSnapshot") {
    const snapshot = message.snapshot
    return {
      ...message,
      snapshot: {
        index: snapshot.index,
        term: snapshot.term,
        config: snapshot.config,
        learners: snapshot.learners,
        data: base64(snapshot.data),
      },
    }
  }
  return { ...message }
}

function fromWire(wire: WireMessage): RaftMessage {
  if (wire.type === "appendEntries") {
    return { ...wire, entries: (wire.entries ?? []).map(entryFromWire) } as unknown as RaftMessage
  }
  if (wire.type === "installSnapshot" && wire.snapshot) {
    const snapshot: RaftSnapshot = {
      index: wire.snapshot.index,
      term: wire.snapshot.term,
      config: wire.snapshot.config ?? [],
      learners: wire.snapshot.learners ?? [],
      data: unbase64(wire.snapshot.data),
    }
    return { ...wire, snapshot } as unknown as RaftMessage
  }
  return wire as unknown as RaftMessage
}

function entryToWire(entry: LogEntry): WireEntry {
  return { index: entry.index, term: entry.term, kind: entry.kind, data: base64(entry.data) }
}

function entryFromWire(wire: WireEntry): LogEntry {
  return {
    index: wire.index,
    term: wire.term,
    kind: wire.kind as LogEntry["kind"],
    data: unbase64(wire.data),
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
}

function unbase64(value: string): Uint8Array {
  const buffer = Buffer.from(value ?? "", "base64")
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}
