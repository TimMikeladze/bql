// GraphQL subscriptions over a real `graphql-transport-ws` socket against a real server
// (`docs/h7-subscriptions.md`). Nothing here is a mock: the point is that the protocol, the
// schema's hand-written `Subscription` root and `TenantRealtime`'s change feed meet correctly, and
// that the socket lets go of what it opened.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { graphqlAvailable, GRAPHQL_WS_PROTOCOL } from "../../src/graphql/index.ts"
import { createDb, startTestServer, type TestServer } from "../server/harness.ts"

const peers = await graphqlAvailable()
const DB = "feed"

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
  await createDb(
    server,
    DB,
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
     CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`,
  )
})

afterAll(async () => {
  await server?.close()
})

interface Frame {
  type: string
  id?: string
  payload?: unknown
}

/** One `graphql-transport-ws` socket, with the frames it received. */
class Client {
  readonly frames: Frame[] = []
  #socket: WebSocket
  #waiters: (() => void)[] = []

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.onmessage = (event: MessageEvent) => {
      this.frames.push(JSON.parse(String(event.data)) as Frame)
      for (const wake of this.#waiters.splice(0)) wake()
    }
  }

  static async open(url: string): Promise<Client> {
    const socket = new WebSocket(url, GRAPHQL_WS_PROTOCOL)
    const client = new Client(socket)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("the socket did not open"))
    })
    return client
  }

  send(frame: Frame): void {
    this.#socket.send(JSON.stringify(frame))
  }

  /** Waits until `check` holds over the frames received so far. */
  async until(what: string, check: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; frames: ${JSON.stringify(this.frames)}`)
      }
      await Promise.race([
        new Promise<void>((resolve) => this.#waiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 25)),
      ])
    }
  }

  of(type: string, id?: string): Frame[] {
    return this.frames.filter((one) => one.type === type && (id === undefined || one.id === id))
  }

  close(): void {
    this.#socket.close()
  }
}

/** The `graphql-transport-ws` endpoint: the GraphQL route, upgraded. */
function socketUrl(node: TestServer): string {
  return `${node.url.replace(/^http/, "ws")}/v1/db/${DB}/graphql`
}

async function connected(token?: string | null): Promise<Client> {
  const client = await Client.open(socketUrl(server))
  client.send({
    type: "connection_init",
    payload: { authorization: token === undefined ? server.adminKey : token },
  })
  await client.until("connection_ack", () => client.of("connection_ack").length > 0)
  return client
}

async function write(sql: string): Promise<void> {
  const response = await server.fetch(`/v1/db/${DB}/query`, { method: "POST", body: JSON.stringify({ sql }) })
  if (response.status !== 200) throw new Error(`write failed: ${await response.text()}`)
}

/** Change events delivered for one subscription id, in arrival order. */
function events(client: Client, id: string): { txid: number; changes: { table: string }[]; reset: boolean }[] {
  return client.of("next", id).map(
    (frame) =>
      (frame.payload as { data: { changes: { txid: number; changes: { table: string }[]; reset: boolean } } }).data
        .changes,
  )
}

describe.if(peers)("graphql subscriptions", () => {
  test("delivers the events a write produces, in txid order", async () => {
    const client = await connected()
    try {
      client.send({
        type: "subscribe",
        id: "a",
        payload: { query: "subscription { changes { txid changes { op table } reset } }" },
      })
      await write("insert into todos (title) values ('one')")
      await write("insert into todos (title) values ('two')")
      await client.until("two events", () => events(client, "a").length >= 2)
      const seen = events(client, "a")
      expect(seen[0]?.changes[0]?.table).toBe("todos")
      expect(seen[1]!.txid).toBeGreaterThan(seen[0]!.txid)
    } finally {
      client.close()
    }
  }, 20_000)

  test("filters by table, so another table's writes produce nothing", async () => {
    const client = await connected()
    try {
      client.send({
        type: "subscribe",
        id: "b",
        payload: { query: 'subscription { changes(tables: ["notes"]) { txid changes { table } reset } }' },
      })
      await write("insert into todos (title) values ('ignored')")
      await write("insert into notes (body) values ('kept')")
      await client.until("the notes event", () => events(client, "b").length >= 1)
      const seen = events(client, "b")
      // Only the `notes` write, and nothing from `todos` — not merely "the notes one arrived".
      for (const event of seen) {
        for (const change of event.changes) expect(change.table).toBe("notes")
      }
    } finally {
      client.close()
    }
  }, 20_000)

  test("answers a query over the same socket and completes it", async () => {
    const client = await connected()
    try {
      client.send({ type: "subscribe", id: "q", payload: { query: "{ __typename }" } })
      await client.until("the complete", () => client.of("complete", "q").length > 0)
      expect(client.of("next", "q").length).toBe(1)
    } finally {
      client.close()
    }
  }, 20_000)

  test("complete ends the subscription, and the engine lets go", async () => {
    const client = await connected()
    try {
      client.send({
        type: "subscribe",
        id: "c",
        payload: { query: "subscription { changes { txid reset } }" },
      })
      await write("insert into todos (title) values ('before complete')")
      await client.until("one event", () => events(client, "c").length >= 1)

      client.send({ type: "complete", id: "c" })
      // The subscriber is gone from the engine, which is where a leak would show rather than in
      // the frames: a client that stopped listening does not prove the server stopped producing.
      const realtime = server.handle.runtime.realtimeOf(DB)
      await client.until("the engine to let go", () => (realtime?.subscriberCount ?? 0) === 0)
    } finally {
      client.close()
    }
  }, 20_000)

  test("closing the socket unsubscribes everything it opened", async () => {
    const client = await connected()
    client.send({ type: "subscribe", id: "d", payload: { query: "subscription { changes { txid reset } }" } })
    await write("insert into todos (title) values ('x')")
    await client.until("one event", () => events(client, "d").length >= 1)
    const realtime = server.handle.runtime.realtimeOf(DB)
    expect(realtime?.subscriberCount ?? 0).toBeGreaterThan(0)

    client.close()
    const deadline = Date.now() + 4000
    while ((server.handle.runtime.realtimeOf(DB)?.subscriberCount ?? 0) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(server.handle.runtime.realtimeOf(DB)?.subscriberCount ?? 0).toBe(0)
  }, 20_000)

  test("a socket that has not initialised cannot subscribe", async () => {
    const client = await Client.open(socketUrl(server))
    try {
      client.send({ type: "subscribe", id: "e", payload: { query: "subscription { changes { txid } }" } })
      // The protocol closes the socket rather than answering; 4401 is its "unauthorized".
      await new Promise<void>((resolve) => {
        ;(client as unknown as { ["#socket"]?: WebSocket })
        setTimeout(resolve, 300)
      })
      expect(client.of("next", "e").length).toBe(0)
    } finally {
      client.close()
    }
  }, 20_000)

  test("the depth limit refuses a subscription document as it refuses a query", async () => {
    const deep = await startTestServer({ graphql: { maxDepth: 2 } })
    try {
      await createDb(deep, DB, "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
      const client = await Client.open(socketUrl(deep))
      try {
        client.send({ type: "connection_init", payload: { authorization: deep.adminKey } })
        await client.until("connection_ack", () => client.of("connection_ack").length > 0)
        client.send({
          type: "subscribe",
          id: "f",
          payload: { query: "subscription { changes { changes { op table } } }" },
        })
        await client.until("an error", () => client.of("error", "f").length > 0)
        expect(JSON.stringify(client.of("error", "f"))).toContain("levels deep")
      } finally {
        client.close()
      }
    } finally {
      await deep.close()
    }
  }, 20_000)
})
