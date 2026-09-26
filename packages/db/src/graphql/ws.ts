// `graphql-transport-ws`, the protocol every GraphQL client speaks (graphql-ws, Apollo, urql,
// GraphiQL). Implemented here rather than taken as a dependency: it is a small state machine, and
// `src/graphql/peers.ts`'s rule is that bql.sh's runtime dependency count is zero.
// `docs/h7-subscriptions.md` §4.
//
// Invariant: **the principal is established once, at `connection_init`, and every operation on the
// socket runs as it.** A browser cannot set `Authorization` on a WebSocket, which is why the
// protocol has an init payload at all. Nothing here re-authenticates per message, and nothing here
// holds a token past the socket — `src/graphql/ambient.ts` explains why a captured one would be a
// privilege escalation.
//
// Second invariant: a `query` or a `mutation` sent over this socket runs through **the same
// executor the HTTP surface runs**, so the depth limit, the complexity limit, `nullOnNotFound` and
// bql.sh's error vocabulary are the same on both. One execution path, one set of limits.
//
// Third invariant: every subscription this socket opened is closed when it closes. The engine's
// subscriber count is what a leak shows up in, and `close()` walks the map rather than trusting a
// client to send `complete`.

import type { DocumentNode, ExecutionResult, GraphQLSchema } from "graphql"
import type { DataApiContext } from "../dataapi/index.ts"
import { runInCall } from "./ambient.ts"
import type { Peers } from "./peers.ts"
import type { SubscriptionContext } from "./subscription.ts"

/** The subprotocol name, exactly as the standard spells it. */
export const GRAPHQL_WS_PROTOCOL = "graphql-transport-ws"

/** Close codes from the protocol. 4400–4499 are its own. */
export const WS_CLOSE = {
  badRequest: 4400,
  unauthorized: 4401,
  forbidden: 4403,
  initTimeout: 4408,
  subscriberAlreadyExists: 4409,
  tooManyInitRequests: 4429,
} as const

/** What this module needs of a socket; a `ServerWebSocket` satisfies it. */
export interface GraphQLSocketLike {
  send(data: string): unknown
  close(code?: number, reason?: string): void
}

/** One prepared operation, ready to run or to stream. */
export interface PreparedOperation {
  document: DocumentNode
  schema: GraphQLSchema
  context: SubscriptionContext
  variables?: Record<string, unknown> | undefined
  operationName?: string | undefined
  /**
   * The ambient call a `query` or a `mutation` runs inside — `src/graphql/ambient.ts`'s store,
   * which is what a generated resolver reads the caller's rights from. A **subscription** needs
   * none: the `changes` field dispatches nothing, it shapes an event the engine already produced.
   */
  ambient: { db: string; context: unknown }
}

/**
 * What the server supplies. `authenticate` is called once per socket with `connection_init`'s
 * payload; `prepare` is called per operation and is where the database, the schema, the caller's
 * rights and the limits are resolved — the same order `src/graphql/handler.ts` uses, because it is
 * load-bearing.
 */
export interface GraphQLSocketHost {
  authenticate(payload: unknown): Promise<void> | void
  prepare(
    query: string,
    variables: Record<string, unknown> | undefined,
    operationName: string | undefined,
  ): Promise<PreparedOperation>
  peers(): Promise<Peers>
  onError?(err: unknown): void
}

type Incoming =
  | { type: "connection_init"; payload?: unknown }
  | { type: "ping"; payload?: unknown }
  | { type: "pong"; payload?: unknown }
  | { type: "subscribe"; id: string; payload: { query: string; variables?: Record<string, unknown>; operationName?: string } }
  | { type: "complete"; id: string }

/** One client socket speaking `graphql-transport-ws`. */
export class GraphQLSocket {
  #socket: GraphQLSocketLike
  #host: GraphQLSocketHost
  #ready = false
  #closed = false
  /** Live operations by client id, so `complete` and a socket close both end them. */
  #operations = new Map<string, { stop: () => void }>()

  constructor(socket: GraphQLSocketLike, host: GraphQLSocketHost) {
    this.#socket = socket
    this.#host = host
  }

  async message(raw: string): Promise<void> {
    if (this.#closed) return
    let message: Incoming
    try {
      message = JSON.parse(raw) as Incoming
    } catch {
      this.#socket.close(WS_CLOSE.badRequest, "invalid JSON")
      return
    }
    switch (message.type) {
      case "connection_init":
        return this.#init(message.payload)
      case "ping":
        this.#send({ type: "pong" })
        return
      case "pong":
        return
      case "subscribe":
        return this.#subscribe(message)
      case "complete":
        this.#end(message.id)
        return
      default:
        this.#socket.close(WS_CLOSE.badRequest, `unknown message type ${String((message as { type?: string }).type)}`)
    }
  }

  /** Every operation this socket opened, ended. Called when the socket goes, whatever the reason. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const [, operation] of this.#operations) operation.stop()
    this.#operations.clear()
  }

  async #init(payload: unknown): Promise<void> {
    if (this.#ready) {
      this.#socket.close(WS_CLOSE.tooManyInitRequests, "already initialised")
      return
    }
    try {
      await this.#host.authenticate(payload)
    } catch (err) {
      this.#report(err)
      this.#socket.close(WS_CLOSE.unauthorized, messageOf(err))
      return
    }
    this.#ready = true
    this.#send({ type: "connection_ack" })
  }

  async #subscribe(message: Extract<Incoming, { type: "subscribe" }>): Promise<void> {
    if (!this.#ready) {
      this.#socket.close(WS_CLOSE.unauthorized, "connection_init has not been acknowledged")
      return
    }
    const id = message.id
    if (typeof id !== "string" || id.length === 0) {
      this.#socket.close(WS_CLOSE.badRequest, "subscribe needs an id")
      return
    }
    if (this.#operations.has(id)) {
      this.#socket.close(WS_CLOSE.subscriberAlreadyExists, `subscriber for ${id} already exists`)
      return
    }
    // Claimed before the first await, so two `subscribe` frames with the same id in one tick
    // cannot both pass the check above.
    let stopped = false
    this.#operations.set(id, {
      stop: () => {
        stopped = true
      },
    })

    let prepared: PreparedOperation
    let peers: Peers
    try {
      peers = await this.#host.peers()
      prepared = await this.#host.prepare(
        message.payload?.query ?? "",
        message.payload?.variables,
        message.payload?.operationName,
      )
    } catch (err) {
      this.#operations.delete(id)
      this.#send({ type: "error", id, payload: errorsOf(err) })
      return
    }
    if (stopped || this.#closed) {
      this.#operations.delete(id)
      return
    }

    const operation = peers.graphql.getOperationAST(prepared.document, prepared.operationName ?? null)
    if (operation?.operation === "subscription") {
      await this.#stream(id, prepared, peers)
      return
    }
    // A query or a mutation over the socket is answered and completed. Same executor, same limits.
    try {
      const result = (await runInCall(
        prepared.ambient as { db: string; context: DataApiContext },
        () =>
          peers.graphql.execute({
            schema: prepared.schema,
            document: prepared.document,
            contextValue: prepared.context,
            variableValues: prepared.variables,
            operationName: prepared.operationName,
          }),
      )) as ExecutionResult
      if (!this.#operations.has(id)) return
      this.#send({ type: "next", id, payload: serialise(result) })
      this.#send({ type: "complete", id })
    } catch (err) {
      this.#send({ type: "error", id, payload: errorsOf(err) })
    } finally {
      this.#operations.delete(id)
    }
  }

  async #stream(id: string, prepared: PreparedOperation, peers: Peers): Promise<void> {
    let iterator: AsyncIterableIterator<ExecutionResult> | null = null
    let cancelled = false
    this.#operations.set(id, {
      stop: () => {
        cancelled = true
        void iterator?.return?.()
      },
    })
    let source: Awaited<ReturnType<typeof peers.graphql.subscribe>>
    try {
      source = await peers.graphql.subscribe({
        schema: prepared.schema,
        document: prepared.document,
        contextValue: prepared.context,
        variableValues: prepared.variables,
        operationName: prepared.operationName,
      })
    } catch (err) {
      this.#operations.delete(id)
      this.#send({ type: "error", id, payload: errorsOf(err) })
      return
    }
    // `subscribe` answers with a single result when the document is refused before it streams —
    // a validation failure, or a `subscribe` that threw — and that is an `error`, not a `next`.
    if (!isAsyncIterable(source)) {
      this.#operations.delete(id)
      const result = source as ExecutionResult
      this.#send({ type: "error", id, payload: result.errors ?? errorsOf(new Error("the subscription produced no stream")) })
      return
    }
    iterator = source as AsyncIterableIterator<ExecutionResult>
    if (cancelled || this.#closed) {
      void iterator.return?.()
      this.#operations.delete(id)
      return
    }
    try {
      for await (const result of iterator) {
        if (cancelled || this.#closed) break
        this.#send({ type: "next", id, payload: serialise(result) })
      }
      if (!cancelled && !this.#closed) this.#send({ type: "complete", id })
    } catch (err) {
      this.#report(err)
      if (!cancelled && !this.#closed) this.#send({ type: "error", id, payload: errorsOf(err) })
    } finally {
      this.#operations.delete(id)
    }
  }

  #end(id: string): void {
    const operation = this.#operations.get(id)
    if (!operation) return
    this.#operations.delete(id)
    operation.stop()
  }

  #send(message: Record<string, unknown>): void {
    if (this.#closed) return
    try {
      this.#socket.send(JSON.stringify(message))
    } catch (err) {
      this.#report(err)
    }
  }

  #report(err: unknown): void {
    this.#host.onError?.(err)
  }
}

function isAsyncIterable(value: unknown): boolean {
  return typeof (value as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === "function"
}

/** `ExecutionResult` as the wire wants it: plain JSON, errors formatted. */
function serialise(result: ExecutionResult): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (result.data !== undefined) out.data = result.data
  if (result.errors && result.errors.length > 0) {
    out.errors = result.errors.map((one) => (typeof one.toJSON === "function" ? one.toJSON() : one))
  }
  if (result.extensions) out.extensions = result.extensions
  return out
}

function errorsOf(err: unknown): { message: string; extensions?: Record<string, unknown> }[] {
  const code = (err as { code?: string })?.code
  return [
    {
      message: messageOf(err),
      ...(code ? { extensions: { code } } : {}),
    },
  ]
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
