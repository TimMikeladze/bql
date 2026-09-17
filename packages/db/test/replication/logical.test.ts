// P9, `docs/p9-logical-cdc.md`. A replica's change feed carried `{ txid, changes: [] }` for every
// transaction, which a subscriber cannot tell from "that transaction changed nothing". With
// `[replication] logicalChanges` on, the primary records the row changes its capture already saw
// and the replica publishes them.
//
// The case that matters is a **fold**. Group commit folds fifty concurrent writers into one
// transaction, and since L8 the primary emits fifty events for it, keyed `(txid, seq)`. A replica
// receives one record for that one transaction, so nothing it could decode out of the pages would
// tell it where one statement ended and the next began. The first test asserts the two feeds agree
// event for event on exactly that shape, because it is the shape a WAL page decoder cannot produce.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { ChangeEvent } from "../../src/client/protocol.ts"
import { WS_PROTOCOL } from "../../src/client/protocol.ts"
import { RECORD_VERSION, RECORD_VERSION_LOGICAL } from "../../src/wal/index.ts"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  until,
  untilSynced,
  untilTxid,
  type Node,
} from "./harness.ts"

const SCHEMA = "create table t (id integer primary key, v text)"
const FOLD = 50

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
  error?: { code: string; message: string }
  data?: ChangeEvent
}

interface Socket {
  send(value: unknown): void
  frames: Frame[]
  changes(): ChangeEvent[]
  close(): void
}

async function socketOn(node: Node): Promise<Socket> {
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
    changes: () =>
      frames.filter((f) => f.event === "change").map((f) => f.data as ChangeEvent),
    close: () => socket.close(),
  }
}

/** Subscribes to `db`'s change feed at `include`, waiting for the answer. */
async function subscribe(socket: Socket, db: string, include: string): Promise<Frame> {
  socket.send({ id: 1, op: "subscribe", kind: "changes", db, include })
  await until(
    () => socket.frames.some((f) => f.id === 1),
    `the change subscription on ${db}`,
  )
  return socket.frames.find((f) => f.id === 1) as Frame
}

describe("logical CDC on a replica", () => {
  test("a fold of fifty writes reaches the replica event for event", async () => {
    const primary = track(
      await startPrimary({
        replication: { logicalChanges: "row" },
        limits: { groupCommit: true, groupCommitMax: 128 },
      }),
    )
    await createDb(primary, "acme", SCHEMA)
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "acme")

    const onPrimary = await socketOn(primary)
    const onReplica = await socketOn(replica)
    expect((await subscribe(onPrimary, "acme", "row")).ok).toBe(true)
    // The primary announced on SUBSCRIBED that it records rows, so this is served before any
    // record carrying them has arrived.
    expect((await subscribe(onReplica, "acme", "row")).ok).toBe(true)

    // Fifty writes in one event-loop turn: group commit folds them into one transaction, so the
    // replica gets one record and the primary emits fifty events under one txid.
    const written = await Promise.all(
      Array.from({ length: FOLD }, (_, i) =>
        query(primary, "acme", "insert into t (v) values (?)", [`v${i}`]),
      ),
    )
    const txids = new Set(written.map((w) => w.txid))
    expect(txids.size).toBeLessThan(FOLD) // otherwise nothing folded and the test proves nothing

    await until(() => onPrimary.changes().length >= FOLD, "the primary's fifty events")
    await until(() => onReplica.changes().length >= FOLD, "the replica's fifty events")
    onPrimary.close()
    onReplica.close()

    const mine = onPrimary.changes()
    const theirs = onReplica.changes()
    expect(theirs.length).toBe(mine.length)
    // Event for event: the same key and the same rows, in the same order.
    expect(theirs).toEqual(mine)
    // And the key really is a fold: fifty events, fewer txids, a dense `seq` within each.
    const bySeq = new Map<number, number[]>()
    for (const event of theirs) {
      const seqs = bySeq.get(event.txid) ?? []
      seqs.push(event.seq as number)
      bySeq.set(event.txid, seqs)
    }
    expect(bySeq.size).toBeLessThan(FOLD)
    for (const seqs of bySeq.values()) {
      expect(seqs).toEqual(seqs.map((_, i) => i))
    }
    // The rows themselves arrived, not just the keys.
    const values = theirs.flatMap((e) => e.changes.map((c) => c.row?.v))
    expect(new Set(values)).toEqual(new Set(written.map((_, i) => `v${i}`)))
    for (const change of theirs.flatMap((e) => e.changes)) {
      expect(change.op).toBe("insert")
      expect(change.table).toBe("t")
    }
  })

  test("a replica whose primary records nothing answers LOGICAL_UNAVAILABLE", async () => {
    // The default. Before P9 this subscription succeeded and delivered `changes: []` forever,
    // which is a wrong answer a consumer had no way to detect.
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "acme")

    const socket = await socketOn(replica)
    const refused = await subscribe(socket, "acme", "row")
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("LOGICAL_UNAVAILABLE")

    // Over HTTP too, with the status the error table names.
    const sse = await replica.fetch("/v1/db/acme/changes", { headers: { accept: "text/event-stream" } })
    expect(sse.status).toBe(501)
    expect(((await sse.json()) as { error: { code: string } }).error.code).toBe(
      "LOGICAL_UNAVAILABLE",
    )

    // `include=none` asks for no rows, so it is served: a live-query client and a
    // "something changed, re-read" consumer work on a replica exactly as they always did.
    const none = await subscribe(await socketOn(replica), "acme", "none")
    expect(none.ok).toBe(true)
    socket.close()
  })

  test("the feed on a primary is unaffected by what the record carries", async () => {
    // The ordering hazard, asserted directly: the record is encoded *before* the change feed
    // publishes, so the record path and the feed are both reaching for the same buffered rows. If
    // the record path simply drained it, this feed would be empty and the replica's would be full.
    const primary = track(await startPrimary({ replication: { logicalChanges: "row" } }))
    await createDb(primary, "acme", SCHEMA)
    const socket = await socketOn(primary)
    expect((await subscribe(socket, "acme", "row")).ok).toBe(true)

    await query(primary, "acme", "insert into t (v) values ('one')")
    await until(() => socket.changes().length >= 1, "the primary's own event")
    const event = socket.changes()[0] as ChangeEvent
    expect(event.changes).toHaveLength(1)
    expect(event.changes[0]?.row).toEqual({ id: 1, v: "one" })
    socket.close()
  })

  test("the recorded level caps what leaves the node", async () => {
    // The primary captures at whatever its highest *local* subscriber asked for, which is no basis
    // for deciding what crosses the network — `row+old` is the whole row twice. So a local
    // subscriber here asks for `row+old`, raising the capture level well above the `pk` the config
    // said to record, and the replica must still see only `pk`.
    const primary = track(await startPrimary({ replication: { logicalChanges: "pk" } }))
    await createDb(primary, "acme", SCHEMA)
    await query(primary, "acme", "insert into t (v) values ('seed')")
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "acme")

    const onPrimary = await socketOn(primary)
    expect((await subscribe(onPrimary, "acme", "row+old")).ok).toBe(true)
    const onReplica = await socketOn(replica)
    expect((await subscribe(onReplica, "acme", "row")).ok).toBe(true)

    const written = await query(primary, "acme", "update t set v = 'two' where id = 1")
    await untilTxid(replica, "acme", written.txid)
    await until(() => onPrimary.changes().length >= 1, "the primary's event")
    await until(() => onReplica.changes().length >= 1, "the replica's event")

    // The primary's own feed has the whole row and the previous one, because a subscriber here
    // asked for them and the capture obliged.
    const mine = (onPrimary.changes()[0] as ChangeEvent).changes[0]
    expect(mine?.row).toEqual({ id: 1, v: "two" })
    expect(mine?.old).toEqual({ id: 1, v: "seed" })

    // The replica gets what was *recorded*, which is `pk` and nothing more. The feed cannot invent
    // what the primary did not put on the wire, and must not be given more than the config allowed.
    const theirs = (onReplica.changes()[0] as ChangeEvent).changes[0]
    expect(theirs?.pk).toEqual({ id: 1 })
    expect(theirs?.row).toBeUndefined()
    expect(theirs?.old).toBeUndefined()
    onPrimary.close()
    onReplica.close()
  })

  test("a v1-only replica keeps replicating against a primary with the flag on", async () => {
    // A peer that sends no `maxRecordVersion` is one built before P9. The primary must strip the
    // logical section rather than stream a record the peer would refuse by version.
    const primary = track(await startPrimary({ replication: { logicalChanges: "row" } }))
    await createDb(primary, "acme", SCHEMA)
    await query(primary, "acme", "insert into t (v) values ('before')")

    const { FRAME, FrameReader, encodeJson, makeProof, PROTO_VERSION } = await import(
      "../../src/replication/protocol.ts"
    )
    const { decode } = await import("../../src/wal/index.ts")
    const tenant = primary.handle.registry.open("acme")
    const from = tenant.txid

    const records: { version: number; hasLogical: boolean; txid: bigint }[] = []
    const socket = new WebSocket(primary.replicationUrl)
    socket.binaryType = "arraybuffer"
    const reader = new FrameReader()
    let subscribed = false
    let announced: boolean | undefined
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the old replica never subscribed")), 5000)
      socket.addEventListener("message", (event) => {
        for (const frame of reader.push(event.data as ArrayBuffer)) {
          if (frame.type === FRAME.TXN) {
            // `stream u32 | record`, per the TXN frame layout.
            const bytes = frame.body.subarray(4)
            const { record } = decode(bytes)
            records.push({
              version: record.version,
              hasLogical: record.logical !== undefined,
              txid: record.txid,
            })
            continue
          }
          const body = JSON.parse(new TextDecoder().decode(frame.body)) as Record<string, unknown>
          if (frame.type === FRAME.HELLO && body.nonce) {
            socket.send(
              encodeJson(FRAME.HELLO, {
                proto: PROTO_VERSION,
                node: "old-replica",
                proof: makeProof(primary.handle.config.replication.secret, body.nonce as string),
                // No `maxRecordVersion`: this peer predates P9 and cannot read version 2.
              }),
            )
            continue
          }
          if (frame.type === FRAME.HELLO && body.ok) {
            socket.send(
              encodeJson(FRAME.SUBSCRIBE, {
                stream: 1,
                db: "acme",
                fromTxid: from.toString(),
                epoch: tenant.epoch,
                checksum: tenant.position.checksum.toString(),
              }),
            )
            continue
          }
          if (frame.type === FRAME.SUBSCRIBED) {
            announced = body.logical as boolean | undefined
            subscribed = true
            clearTimeout(timer)
            resolve()
            continue
          }
          if (frame.type === FRAME.ERROR) {
            clearTimeout(timer)
            reject(new Error(`the primary refused the old replica: ${JSON.stringify(body)}`))
            return
          }
        }
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("the replication socket failed to open"))
      })
    })
    expect(subscribed).toBe(true)
    // The primary still announces what it records; an old peer simply ignores the field.
    expect(announced).toBe(true)

    await query(primary, "acme", "insert into t (v) values ('after')")
    await until(() => records.length >= 1, "a record on the old replica's stream")
    socket.close()

    // Version 1, no logical section, and still a record this peer can decode and apply.
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(record.version).toBe(RECORD_VERSION)
      expect(record.hasLogical).toBe(false)
    }
    // Meanwhile the primary's own log holds the version-2 record the downgrade came from.
    tenant.flushPending()
    const own = [...tenant.log.iterate(records[0]?.txid as bigint)]
    expect(own[0]?.version).toBe(RECORD_VERSION_LOGICAL)
    expect(own[0]?.logical).toBeDefined()
  })
})
