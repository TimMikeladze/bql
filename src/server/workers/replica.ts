// The router's half of *following* an upstream when `[server] workers > 1`
// (`docs/c4c-replication-follow.md`).
//
// Decision: **the same seam C4b cut, cut the other way.** The router owns the one upstream
// *connection* — the socket, the reconnect and its backoff, the HMAC proof, the `FrameReader`, the
// generation ledger, R7's reconciliation, R2's forward queue and the node's `ReplicaStatus` — and
// the worker that owns a database owns that database's *stream*, with `registry.openReplica`, the
// snapshot file, `installSnapshot`, `registry.pin` and `tenant.applyRecord` all called on the
// thread that holds the writer.
//
// Invariant: the connection half and the stream half are **one class in three modes**, not two
// classes. `src/replication/replica.ts` runs here in `"routed"` mode and on a worker in
// `"hosted"` mode, so `#resolveFollow`, the backoff, the ledger and the frame dispatch exist once.
// This file is only the adapter that turns that client's `ShardHost` calls into `postMessage` and
// the pool's `FollowHost` callbacks back into client calls — which is why it is short.
//
// Second invariant: a frame is routed by the *stream* it names, and a stream's worker is learned
// from the one message that mints it (`follow.start`, which names the database) and forgotten by
// the one that ends it. That is the rule `router.ts` applies to a transaction baton and
// `replication.ts` applies to a replica's stream, for the same reason.

import type {
  ForwardRequest,
  LinkState,
  ReplicaClient,
  ShardHost,
  StreamPosition,
} from "../../replication/index.ts"
import type { ServerRuntime } from "../runtime.ts"
import type { FollowHost, WorkerPool } from "./pool.ts"

/**
 * `ShardHost` over a `WorkerPool`: each call is one `postMessage` to the worker that owns the
 * database, except `link` and `generations`, which are node-level facts every worker needs, and
 * `positions`, which is the one gather and happens once per heartbeat rather than once per record.
 */
export class WorkerShards implements ShardHost {
  #pool: WorkerPool
  #onError: (err: unknown) => void
  /**
   * C3b: which of the node's upstreams this host serves. A worker keeps one hosted client per
   * upstream, so every envelope says which — a statically configured replica has one and it is 0.
   */
  readonly #up: number
  /** Worker that owns each open stream, learned from `start`. */
  #streams = new Map<number, number>()

  constructor(pool: WorkerPool, onError: (err: unknown) => void, up = 0) {
    this.#pool = pool
    this.#onError = onError
    this.#up = up
  }

  start(stream: number, db: string, generation: string | null, reset: boolean): void {
    const index = this.#pool.shardOf(db)
    this.#streams.set(stream, index)
    try {
      this.#pool.followStart(index, this.#up, stream, db, generation, reset)
    } catch (err) {
      this.#streams.delete(stream)
      this.#onError(err)
    }
  }

  frame(stream: number, db: string, type: number, body: Uint8Array): void {
    // The routing key is the stream, but a worker that is gone has to be loud rather than leave a
    // stream that never applies another record — the same failure C4b's `#deliver` makes loud.
    const index = this.#streams.get(stream) ?? this.#pool.shardOf(db)
    try {
      // Copied rather than forwarded: `FrameReader` hands back a view into the whole WebSocket
      // message, and structured clone would move that entire buffer rather than this frame.
      this.#pool.followFrame(index, this.#up, type, body.slice())
    } catch (err) {
      this.#streams.delete(stream)
      this.#onError(err)
    }
  }

  stop(stream: number, db: string, drop: boolean, reason: string): void {
    const index = this.#streams.get(stream) ?? this.#pool.shardOf(db)
    this.#streams.delete(stream)
    try {
      this.#pool.followStop(index, this.#up, stream, db, drop, reason)
    } catch (err) {
      this.#onError(err)
    }
  }

  link(state: LinkState): void {
    this.#pool.followLink(this.#up, state)
  }

  generations(entries: [string, string][]): void {
    this.#pool.followGenerations(this.#up, entries)
  }

  async positions(primary: [number, string][]): Promise<StreamPosition[]> {
    return this.#pool.followStatus(this.#up, primary)
  }

  result(shard: number, id: number, body: { id: number; ok: boolean; result?: unknown; error?: unknown }): void {
    try {
      this.#pool.followResult(shard, {
        up: this.#up,
        id,
        ok: body.ok,
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(body.error ? { error: body.error as never } : {}),
      })
    } catch (err) {
      this.#onError(err)
    }
  }
}

/**
 * The other direction: what a worker reports that is not a frame for the socket. Every one of these
 * is a decision the router owns — the ledger, the stream table, `#detached`, the unfollow log, the
 * forward queue — so each is handed straight to the `"routed"` client.
 */
export function followHost(
  client: ReplicaClient,
  runtime: ServerRuntime,
  onError: (err: unknown) => void,
): FollowHost {
  return {
    out(bytes: Uint8Array): void {
      client.sendFrame(bytes)
    },
    installed(stream: number, db: string, txid: string): void {
      client.installed(stream, db, txid)
    },
    again(stream: number, db: string, reason: string): void {
      client.again(stream, db, reason)
    },
    stopped(db: string, trash: string | null): void {
      client.stopped(db, trash)
    },
    forwardFrom(shard: number, id: number, request: ForwardRequest): void {
      client.forwardFrom(shard, id, request)
    },
    detach(db: string): void {
      client.detach(db)
    },
    attach(db: string): void {
      client.attach(db)
    },
    followPrimary(url: string): void {
      // C4b §6's gap: a database fenced on a worker demoted but could not converge, because
      // starting a client inside a worker thread is exactly what C4c makes unnecessary.
      try {
        runtime.followPrimary(url)
      } catch (err) {
        onError(err)
      }
    },
  }
}
