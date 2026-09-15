// L4. `#evict` skipped `busy` and `pinned` tenants and then admitted the new one regardless —
// "the cap is a target, not a promise a correct write can break". True for `busy`, which lasts one
// statement. Not true for `pinned`, which a subscriber holds for as long as it keeps its
// subscription open, so one client opening a subscription against each of two thousand databases
// pinned two thousand tenants past `maxOpen` and nothing refused it.
//
// Three guarantees here, all as a client sees them: a principal past the pin limit is refused
// while other principals are not, a node whose LRU is entirely pinned refuses the open rather than
// exceeding `maxOpen`, and a dropped connection gives its pins back.

import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ErrorBody } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

const PIN_LIMIT = 3
const MAX_OPEN = 4
const NAMES = ["a", "b", "c", "d", "e", "f"]
let server: TestServer

beforeAll(async () => {
  server = await startTestServer({
    data: { maxOpen: MAX_OPEN },
    // Short, so a released pin is observable inside a test rather than fifteen seconds later.
    realtime: { idleRetainMs: 50 },
    limits: { maxPinnedPerPrincipal: PIN_LIMIT },
  })
  for (const name of NAMES) {
    await createDb(server, name, "create table t (id integer primary key, v text)")
  }
})
afterAll(stopAll)

interface Feed {
  status: number
  code: string | null
  close: () => void
}

/**
 * Opens a change feed and waits for its response headers, which is when the pin has landed. The
 * body is never read; `close()` aborts the request, which is what a dropped client looks like.
 */
async function subscribe(db: string, token: string): Promise<Feed> {
  const controller = new AbortController()
  const response = await server.fetch(`/v1/db/${db}/changes`, {
    token,
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  })
  if (response.ok) return { status: response.status, code: null, close: () => controller.abort() }
  const body = (await response.json()) as ErrorBody
  return { status: response.status, code: body.error.code, close: () => controller.abort() }
}

const metric = async (name: string): Promise<number> => {
  const text = await (await server.fetch("/metrics")).text()
  return Number(
    text
      .split("\n")
      .find((line) => line.startsWith(`${name}{`))
      ?.split(" ")
      .pop(),
  )
}

/** Lets every abort and every retain window land before the next case starts. */
const settle = (): Promise<void> => Bun.sleep(150)

test("a principal past the pin limit is refused, and other principals are not", async () => {
  const mine = (await server.token({ dbs: NAMES, scope: "ro" })).token
  const theirs = (await server.token({ dbs: NAMES, scope: "ro" })).token
  const open: Feed[] = []
  try {
    for (let i = 0; i < PIN_LIMIT; i++) {
      const feed = await subscribe(NAMES[i] as string, mine)
      expect(feed.status).toBe(200)
      open.push(feed)
    }
    const over = await subscribe(NAMES[PIN_LIMIT] as string, mine)
    expect(over.status).toBe(429)
    expect(over.code).toBe("PIN_LIMIT")

    // A second subscription to a database this principal already pins costs nothing new.
    const again = await subscribe(NAMES[0] as string, mine)
    expect(again.status).toBe(200)
    open.push(again)

    // Another principal's budget is its own.
    const other = await subscribe(NAMES[PIN_LIMIT] as string, theirs)
    expect(other.status).toBe(200)
    open.push(other)
    expect(await metric("bunql_tenants_pinned")).toBe(PIN_LIMIT + 1)
  } finally {
    for (const feed of open) feed.close()
  }
  await settle()
})

test("a dropped connection gives its pins back", async () => {
  const mine = (await server.token({ dbs: NAMES, scope: "ro" })).token
  const held: Feed[] = []
  for (let i = 0; i < PIN_LIMIT; i++) held.push(await subscribe(NAMES[i] as string, mine))
  expect((await subscribe(NAMES[PIN_LIMIT] as string, mine)).code).toBe("PIN_LIMIT")

  // Kill the sockets rather than unsubscribing politely, which is the case that matters.
  for (const feed of held) feed.close()
  await settle()

  const after = await subscribe(NAMES[PIN_LIMIT] as string, mine)
  expect(after.status).toBe(200)
  after.close()
  await settle()
  expect(await metric("bunql_tenants_pinned")).toBe(0)
})

test("a node whose LRU is entirely pinned refuses the open instead of exceeding maxOpen", async () => {
  // One principal per database, so the pin limit is never what refuses — `maxOpen` is.
  const held: Feed[] = []
  try {
    for (let i = 0; i < MAX_OPEN; i++) {
      const token = (await server.token({ dbs: NAMES, scope: "ro" })).token
      const feed = await subscribe(NAMES[i] as string, token)
      expect(feed.status).toBe(200)
      held.push(feed)
    }
    expect(await metric("bunql_open_tenants")).toBe(MAX_OPEN)

    const token = (await server.token({ dbs: NAMES, scope: "ro" })).token
    const refused = await server.fetch(`/v1/db/${NAMES[MAX_OPEN]}/query`, {
      token,
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(refused.status).toBe(503)
    expect(((await refused.json()) as ErrorBody).error.code).toBe("TOO_MANY_OPEN")
    expect(await metric("bunql_open_refused_total")).toBeGreaterThan(0)
    // The ceiling held: at `maxOpen`, not past it. Before L4 this was `maxOpen + 1` and climbing.
    expect(await metric("bunql_open_tenants")).toBe(MAX_OPEN)
  } finally {
    for (const feed of held) feed.close()
  }
  await settle()
})
