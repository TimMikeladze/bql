// L8. Group commit folds concurrent writes into one transaction, so before this a change feed
// emitted **one event per fold**: fifty writers, one event, and no way for a consumer to tell them
// apart or to dedupe across a replay — `txid` was not a key.
//
// The contract now: one event per statement, keyed `(txid, seq)`. What is asserted is that key —
// that a fold of N writes produces N events sharing one txid with a dense ascending sequence, that
// SSE and the WebSocket agree on it, and that resuming mid-transaction serves the rest of it.

import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChangeEvent } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

const FOLD = 50
let server: TestServer

beforeAll(async () => {
  server = await startTestServer({ limits: { groupCommit: true, groupCommitMax: 128 } })
  await createDb(server, "feed", "create table t (id integer primary key, v integer)")
})
afterAll(stopAll)

interface Frame {
  id?: string
  event: string
  data: ChangeEvent
}

/** Opens an SSE feed and collects frames until `want` changes have arrived or the wait is over. */
async function collect(
  want: number,
  lastEventId?: string,
  during?: () => Promise<unknown>,
): Promise<{ frames: Frame[]; close: () => void }> {
  const controller = new AbortController()
  const headers: Record<string, string> = { accept: "text/event-stream" }
  if (lastEventId) headers["last-event-id"] = lastEventId
  const response = await server.fetch("/v1/db/feed/changes?include=pk", {
    headers,
    signal: controller.signal,
  })
  if (!response.ok || !response.body) throw new Error(`sse: ${response.status}`)
  const frames: Frame[] = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let at = buffer.indexOf("\n\n")
        while (at >= 0) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const id = /^id: (.+)$/m.exec(block)?.[1]
          const name = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (name && data) {
            frames.push({ ...(id ? { id } : {}), event: name, data: JSON.parse(data) as ChangeEvent })
          }
          at = buffer.indexOf("\n\n")
        }
      }
    } catch {
      // The abort below is how this ends.
    }
  })()

  // The subscription has to exist before the writes, or the fold happens before anybody is
  // listening and the events go to the ring instead of the socket.
  await Bun.sleep(30)
  if (during) await during()
  const until = Date.now() + 5000
  while (frames.filter((f) => f.event === "change").length < want && Date.now() < until) {
    await Bun.sleep(5)
  }
  const close = (): void => {
    controller.abort()
    void pump
  }
  return { frames, close }
}

/** `FOLD` writes issued in one turn, which is what group commit folds. */
const fold = (): Promise<unknown> =>
  Promise.all(
    Array.from({ length: FOLD }, (_, i) =>
      server.json("/v1/db/feed/query", {
        method: "POST",
        body: JSON.stringify({ sql: "insert into t (v) values (?)", args: [i] }),
      }),
    ),
  )

test("a fold of 50 writes emits 50 events sharing one txid with distinct seq", async () => {
  const { frames, close } = await collect(FOLD, undefined, fold)
  close()
  const changes = frames.filter((f) => f.event === "change").map((f) => f.data)
  expect(changes.length).toBe(FOLD)
  // Every event carries exactly the one row its statement wrote.
  for (const event of changes) expect(event.changes.length).toBe(1)

  // Grouped by txid, each transaction's sequence is dense and ascending from zero.
  const bySeq = new Map<number, number[]>()
  for (const event of changes) {
    const list = bySeq.get(event.txid) ?? []
    list.push(event.seq as number)
    bySeq.set(event.txid, list)
  }
  for (const [, seqs] of bySeq) expect(seqs).toEqual(seqs.map((_, i) => i))

  // The fold really happened — otherwise this is just fifty transactions and proves nothing.
  expect(bySeq.size).toBeLessThan(FOLD)

  // And `(txid, seq)` is the key: distinct across every event, which `txid` alone is not.
  const keys = changes.map((e) => `${e.txid}.${e.seq}`)
  expect(new Set(keys).size).toBe(FOLD)
  expect(new Set(changes.map((e) => e.txid)).size).toBeLessThan(FOLD)
})

test("the SSE id is the position, and a resume mid-transaction gets the rest of it", async () => {
  const first = await collect(FOLD, undefined, fold)
  first.close()
  const changes = first.frames.filter((f) => f.event === "change")
  expect(changes.length).toBe(FOLD)
  for (const frame of changes) {
    expect(frame.id).toBe(`${frame.data.txid}.${frame.data.seq}`)
  }

  // Resume from the *first* event of the biggest fold — not the last transaction, which may well
  // have held one statement. Everything after that position has to arrive, including the rest of
  // that same transaction, which a bare txid could not express and which is the whole reason the
  // position carries a sequence.
  const sizes = new Map<number, number>()
  for (const frame of changes) {
    sizes.set(frame.data.txid, (sizes.get(frame.data.txid) ?? 0) + 1)
  }
  let folded = changes[0]?.data.txid as number
  for (const [txid, size] of sizes) {
    if (size > (sizes.get(folded) as number)) folded = txid
  }
  expect(sizes.get(folded) as number).toBeGreaterThan(1)
  const at = changes.findIndex((f) => f.data.txid === folded)
  const expected = changes.slice(at + 1).map((f) => f.id as string)
  const resumeAt = changes[at]?.id as string

  const second = await collect(expected.length, resumeAt)
  second.close()
  const replayed = second.frames.filter((f) => f.event === "change").map((f) => f.data)
  expect(second.frames.some((f) => f.event === "reset")).toBe(false)
  expect(replayed.map((e) => `${e.txid}.${e.seq}`)).toEqual(expected)
})

test("a bare txid still means the whole transaction, as it did before L8", async () => {
  const first = await collect(FOLD, undefined, fold)
  first.close()
  const changes = first.frames.filter((f) => f.event === "change").map((f) => f.data)
  const lastTxid = changes[changes.length - 1]?.txid as number

  // One more fold, so there is something after `lastTxid` to receive.
  const after = await collect(1, String(lastTxid), fold)
  after.close()
  const replayed = after.frames.filter((f) => f.event === "change").map((f) => f.data)
  expect(after.frames.some((f) => f.event === "reset")).toBe(false)
  expect(replayed.length).toBeGreaterThan(0)
  // Nothing from the transaction the client said it had already seen in full.
  expect(replayed.every((e) => e.txid > lastTxid)).toBe(true)
})

test("the WebSocket agrees with SSE on the key", async () => {
  const socket = new WebSocket(server.wsUrl(`?token=${encodeURIComponent(server.adminKey)}`), [
    "bql.v1",
  ])
  const events: ChangeEvent[] = []
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("ws failed to open"))
  })
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data)) as { event?: string; data?: ChangeEvent }
    if (frame.event === "change" && frame.data) events.push(frame.data)
  }
  socket.send(JSON.stringify({ id: 1, op: "subscribe", db: "feed", kind: "changes" }))
  await Bun.sleep(50)
  await fold()
  const until = Date.now() + 5000
  while (events.length < FOLD && Date.now() < until) await Bun.sleep(5)
  socket.close()

  expect(events.length).toBe(FOLD)
  const keys = events.map((e) => `${e.txid}.${e.seq}`)
  expect(new Set(keys).size).toBe(FOLD)
  expect(new Set(events.map((e) => e.txid)).size).toBeLessThan(FOLD)
})
