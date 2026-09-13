// Realtime on a replica (`plan-phase1.md` finding 3). A replica has no preupdate hooks — its
// transactions arrive as WAL frames — so its feed is driven by `applyRecord`: live queries re-run
// and converge on the primary's state, and the change feed carries txids with an empty `changes`
// array, which is the phase-1 limitation `docs/api.md` documents.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { WS_PROTOCOL } from "../../src/client/protocol.ts"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  until,
  untilSynced,
  type Node,
} from "./harness.ts"

const SCHEMA = "create table t (id integer primary key, v text)"

let open: { close(): Promise<void> }[] = []

function track<T extends { close(): Promise<void> }>(thing: T): T {
  open.push(thing)
  return thing
}

afterEach(async () => {
  const current = open
  open = []
  for (const thing of current.reverse()) {
    try {
      await thing.close()
    } catch {
      // Already closed by the test itself.
    }
  }
})

afterAll(stopAll)

interface Frame {
  id?: number
  ok?: boolean
  sub?: string
  event?: string
  data?: { txid: number; rows?: unknown[][]; added?: unknown[][]; changes?: unknown[] }
}

/** An open socket on `node`, with every frame it has sent us. */
async function socketOn(node: Node): Promise<{ send(v: unknown): void; frames: Frame[]; close(): void }> {
  const socket = new WebSocket(`${node.url.replace("http", "ws")}/v1/ws?token=${node.adminKey}`, [
    WS_PROTOCOL,
  ])
  const frames: Frame[] = []
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", () => reject(new Error("the socket did not open")))
  })
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame)
  })
  return {
    send: (value: unknown) => socket.send(JSON.stringify(value)),
    frames,
    close: () => socket.close(),
  }
}

describe("replica realtime", () => {
  test("a live query on a replica converges after a write on the primary", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    await query(primary, "acme", "insert into t (v) values ('before')")
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "acme")

    const socket = await socketOn(replica)
    socket.send({ id: 1, op: "subscribe", kind: "live", db: "acme", sql: "select v from t order by id" })
    await until(() => socket.frames.some((f) => f.id === 1 && f.ok), "the live subscription")
    await until(
      () => socket.frames.some((f) => f.event === "rows"),
      "the first result of the live query",
    )
    const first = socket.frames.find((f) => f.event === "rows") as Frame
    expect(first.data?.rows).toEqual([["before"]])

    // The write happens on the other node; nothing on this one is told which rows moved.
    const written = await query(primary, "acme", "insert into t (v) values ('after')")
    await until(
      () => socket.frames.filter((f) => f.event === "rows" || f.event === "diff").length > 1,
      "the live query to re-run on the replica",
    )
    const latest = socket.frames.filter((f) => f.event === "rows" || f.event === "diff").at(-1) as Frame
    expect(latest.data?.rows ?? latest.data?.added).toEqual([["before"], ["after"]])
    expect(latest.data?.txid).toBeGreaterThanOrEqual(written.txid)
    socket.close()
  })

  test("the change feed on a replica carries txids with no rows", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "acme")

    const socket = await socketOn(replica)
    socket.send({ id: 1, op: "subscribe", kind: "changes", db: "acme" })
    await until(() => socket.frames.some((f) => f.id === 1 && f.ok), "the change subscription")

    const written = await query(primary, "acme", "insert into t (v) values ('row')")
    await until(() => socket.frames.some((f) => f.event === "change"), "a change event")
    const change = socket.frames.find((f) => f.event === "change") as Frame
    expect(change.data?.txid).toBe(written.txid)
    // The phase-1 limitation, asserted so it cannot regress silently into a lie about the rows.
    expect(change.data?.changes).toEqual([])
    socket.close()
  })

  test("a live query on a replica converges after a write forwarded through it", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "acme")

    const socket = await socketOn(replica)
    socket.send({ id: 1, op: "subscribe", kind: "live", db: "acme", sql: "select count(*) as n from t" })
    await until(() => socket.frames.some((f) => f.event === "rows"), "the first result")

    await replica.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('through the replica')" }),
    })
    await until(
      () => socket.frames.filter((f) => f.event === "rows" || f.event === "diff").length > 1,
      "the live query to see the forwarded write",
    )
    const latest = socket.frames.filter((f) => f.event === "rows").at(-1) as Frame
    expect(latest.data?.rows).toEqual([[1]])
    socket.close()
  })
})
