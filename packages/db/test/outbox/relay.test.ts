// X6, `docs/x6-outbox.md`. The relay tails a database's log and publishes one message per row
// change. These drive it against a real server's tenants with a publisher that behaves like the
// bus — messages keyed by dedupe key — so "exactly once on the bus" is something a test can count.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { cursorPath, readCursors, writeCursor } from "../../src/outbox/cursor.ts"
import { type BusMessage, httpPublisher, type Publisher } from "../../src/outbox/publisher.ts"
import { dedupeKeyPrefix, OutboxRelay, subjectFor } from "../../src/outbox/relay.ts"
import { loadConfig, type OutboxRule } from "../../src/server/config.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "../server/harness.ts"

afterAll(stopAll)

const RULE: OutboxRule = {
  db: "*",
  busUrl: "http://bus.invalid",
  token: "t",
  tokenEnv: "",
  subject: "db.{db}.{table}",
  include: "row",
  workspace: "",
  name: "main",
}

/** The bus, as far as the relay can tell: a dedupe key publishes once, however often it is sent. */
class FakeBus implements Publisher {
  readonly byKey = new Map<string, BusMessage>()
  attempts = 0
  /** Accept the batch and then fail, the way a crash between publish and cursor write looks. */
  failAfterAccept = 0
  /** Refuse outright, the way a bus that is down looks. */
  down = false

  async publish(messages: BusMessage[]): Promise<void> {
    this.attempts += messages.length
    if (this.down) throw new Error("bus is down")
    for (const message of messages) {
      if (!this.byKey.has(message.dedupeKey)) this.byKey.set(message.dedupeKey, message)
    }
    if (this.failAfterAccept > 0) {
      this.failAfterAccept--
      throw new Error("crashed after the bus accepted")
    }
  }
}

function relayFor(server: TestServer, bus: Publisher, warnings: string[] = []): OutboxRelay {
  const runtime = server.handle.runtime
  return new OutboxRelay(
    {
      registry: runtime.registry,
      owns: () => true,
      authors: (tenant) => !tenant.isReplica,
      generationOf: (db) => runtime.generationOf(db),
      startOf: (db) => runtime.registry.catalog.getTenant(db)?.forkedAt ?? 0n,
      onError: (err) => warnings.push(String(err)),
      warn: (message) => warnings.push(message),
    },
    { rules: [RULE], batchSize: 4, intervalMs: 60_000, publisherFor: () => bus },
  )
}

async function logicalServer(overrides: Parameters<typeof startTestServer>[0] = {}) {
  return startTestServer({ replication: { logicalChanges: "row" }, ...overrides })
}

async function insert(server: TestServer, db: string, count: number, from = 0): Promise<void> {
  for (let i = 0; i < count; i++) {
    const response = await server.fetch(`/v1/db/${db}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values (?)", args: [`v${from + i}`] }),
    })
    if (!response.ok) throw new Error(await response.text())
  }
}

describe("[outbox] config", () => {
  const rules = [{ db: "app-*", busUrl: "http://bus:4317", token: "secret" }]

  test("refuses to start without [replication] logicalChanges, and says why", () => {
    expect(() => loadConfig({ env: {}, overrides: { outbox: { rules } } })).toThrow(
      /\[outbox\] needs \[replication\] logicalChanges/,
    )
  })

  test("refuses a rule asking for more than the log records", () => {
    expect(() =>
      loadConfig({
        env: {},
        overrides: {
          replication: { logicalChanges: "pk" },
          outbox: { rules: [{ ...rules[0], include: "row" }] },
        },
      }),
    ).toThrow(/logicalChanges records only "pk"/)
  })

  test("fills defaults, reads tokenEnv, and takes rules as JSON from the environment", () => {
    const config = loadConfig({
      env: {
        BQL_REPLICATION_LOGICAL_CHANGES: "row",
        BUS_TOKEN: "from-env",
        BQL_OUTBOX_RULES: JSON.stringify([{ db: "app-*", busUrl: "http://bus:4317/", tokenEnv: "BUS_TOKEN" }]),
      },
    })
    const [rule] = config.outbox.rules
    expect(rule).toMatchObject({
      db: "app-*",
      busUrl: "http://bus:4317",
      token: "from-env",
      subject: "db.{db}.{table}",
      include: "row",
    })
    expect(rule?.name).toMatch(/^[0-9a-f]{12}$/)
  })

  test("an outbox with no rules is off and needs nothing", () => {
    expect(loadConfig({ env: {} }).outbox.rules).toEqual([])
  })
})

describe("the relay", () => {
  test("subjects are sanitised to bus tokens", () => {
    expect(subjectFor("db.{db}.{table}", "app", "user events")).toBe("db.app.user_events")
  })

  test("publishes every committed row once across a crash between publish and cursor write", async () => {
    const server = await logicalServer()
    await createDb(server, "app", "create table t (id integer primary key, v text)")
    await insert(server, "app", 10)

    const bus = new FakeBus()
    bus.failAfterAccept = 1
    const warnings: string[] = []
    const first = relayFor(server, bus, warnings)
    first.attach(server.handle.runtime.tenant("app"))
    await first.flush()
    // The first batch reached the bus and then the relay "crashed": its cursor did not move.
    expect(bus.byKey.size).toBe(4)
    expect(readCursors(server.handle.runtime.tenant("app").dir).get("main")?.txid ?? 0n).toBe(0n)
    await first.close()

    // A new relay — a restart — resumes from the cursor on disk and re-sends that batch.
    const second = relayFor(server, bus, warnings)
    second.attach(server.handle.runtime.tenant("app"))
    await second.flush()
    expect(bus.attempts).toBe(14)
    expect(bus.byKey.size).toBe(10)
    const bodies = [...bus.byKey.values()].map((m) => m.body as { v?: unknown; row?: { v: string } })
    expect(bodies.map((b) => b.row?.v).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `v${i}`).sort(),
    )
    const sample = [...bus.byKey.values()][0] as BusMessage
    expect(sample.subject).toBe("db.app.t")
    expect(sample.dedupeKey).toMatch(/^app:[0-9a-f]{16}:\d+:[0-9a-f]{16}:0:0$/)
    expect(sample.body).toMatchObject({ db: "app", table: "t", op: "insert", seq: 0, i: 0 })

    // The cursor is on disk at the log's head, so a third start publishes nothing.
    const head = server.handle.runtime.tenant("app").log.lastTxid
    expect(readCursors(server.handle.runtime.tenant("app").dir).get("main")?.txid).toBe(head)
    await second.close()
    const third = relayFor(server, bus)
    third.attach(server.handle.runtime.tenant("app"))
    await third.flush()
    expect(bus.attempts).toBe(14)
    await third.close()
  })

  test("a record with no rows is skipped and counted; later commits are relayed as they land", async () => {
    const server = await logicalServer()
    await createDb(server, "app", "create table t (id integer primary key, v text)")
    const bus = new FakeBus()
    const relay = relayFor(server, bus)
    relay.attach(server.handle.runtime.tenant("app"))
    await relay.flush()
    // The schema's transaction changed no rows, so its record is version 1.
    expect(relay.metrics().skipped).toBeGreaterThan(0)
    expect(bus.byKey.size).toBe(0)

    await insert(server, "app", 3)
    const deadline = Date.now() + 5000
    while (bus.byKey.size < 3 && Date.now() < deadline) await Bun.sleep(10)
    expect(bus.byKey.size).toBe(3)
    expect(relay.state("app")[0]).toMatchObject({ rule: "main", lag: 0, published: 3 })
    await relay.close()
  })

  test("a failing bus holds the cursor, and the backlog goes out once it recovers", async () => {
    const server = await logicalServer()
    await createDb(server, "app", "create table t (id integer primary key, v text)")
    await insert(server, "app", 5)
    const bus = new FakeBus()
    bus.down = true
    const warnings: string[] = []
    const relay = relayFor(server, bus, warnings)
    relay.attach(server.handle.runtime.tenant("app"))
    await relay.flush()
    expect(relay.state("app")[0]?.lastError).toBe("bus is down")
    expect(relay.state("app")[0]?.lag).toBeGreaterThan(0)
    expect(warnings.some((line) => line.includes("cannot publish"))).toBe(true)

    bus.down = false
    const deadline = Date.now() + 5000
    while (bus.byKey.size < 5 && Date.now() < deadline) await Bun.sleep(20)
    expect(bus.byKey.size).toBe(5)
    expect(relay.state("app")[0]).toMatchObject({ lastError: null, lag: 0 })
    await relay.close()
  })

  test("a cursor overtaken by retention is a loud OUTBOX_GAP and a jump, never a silent skip", async () => {
    // A segment per transaction, so retention can drop records the relay never saw.
    const server = await logicalServer({ durability: { segmentBytes: 1, retention: "0" } })
    await createDb(server, "app", "create table t (id integer primary key, v text)")
    await insert(server, "app", 1)
    const tenant = server.handle.runtime.tenant("app")
    const bus = new FakeBus()
    const warnings: string[] = []
    const relay = relayFor(server, bus, warnings)
    relay.attach(tenant)
    await relay.flush()
    const cursor = readCursors(tenant.dir).get("main")?.txid as bigint
    // The bus goes away while writes continue, and retention overtakes the cursor.
    bus.down = true
    await insert(server, "app", 6, 1)
    await relay.flush()
    tenant.log.retain({ maxBytes: 1 })
    const first = tenant.log.firstTxid as bigint
    expect(first).toBe(tenant.log.lastTxid)
    bus.down = false
    await relay.flush()
    const deadline = Date.now() + 5000
    while (relay.metrics().gaps === 0 && Date.now() < deadline) await Bun.sleep(20)
    await relay.flush()
    expect(
      warnings.some((line) =>
        line.includes(`OUTBOX_GAP app (main): transactions ${cursor + 1n}..${first - 1n}`),
      ),
    ).toBe(true)
    expect(relay.metrics().gaps).toBe(1)
    // The first row, then only what the log still holds: the newest record, one row.
    expect(bus.byKey.size).toBe(2)
    expect(readCursors(tenant.dir).get("main")?.txid).toBe(tenant.log.lastTxid)
    await relay.close()
  })

  test("a deleted database stops being relayed and takes its cursor with it", async () => {
    const server = await logicalServer()
    await createDb(server, "gone", "create table t (id integer primary key, v text)")
    await insert(server, "gone", 2)
    const bus = new FakeBus()
    const relay = relayFor(server, bus)
    const tenant = server.handle.runtime.tenant("gone")
    relay.attach(tenant)
    await relay.flush()
    expect(fs.existsSync(cursorPath(tenant.dir))).toBe(true)
    await relay.forget("gone")
    expect(relay.state("gone")).toEqual([])
    const deleted = await server.fetch("/v1/db/gone", { method: "DELETE" })
    expect(deleted.ok).toBe(true)
    expect(fs.existsSync(cursorPath(tenant.dir))).toBe(false)
    await relay.close()
  })

  test("a reset branch reuses txids with new content, and the bus does not drop it as a duplicate", async () => {
    const server = await logicalServer()
    await createDb(server, "base", "create table t (id integer primary key, v text)")
    const forked = await server.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "pr", from: { db: "base" } }),
    })
    expect(forked.status).toBe(201)
    const bus = new FakeBus()
    const warnings: string[] = []
    const relay = relayFor(server, bus, warnings)
    const runtime = server.handle.runtime
    relay.attach(runtime.tenant("pr"))
    await insert(server, "pr", 1, 100)
    await relay.flush()
    const before = runtime.tenant("pr").log.lastTxid
    expect(bus.byKey.size).toBe(1)

    // The parent has not moved, so the reset branch's next write lands on the same txid.
    expect((await server.fetch("/v1/db/pr/reset", { method: "POST" })).ok).toBe(true)
    await relay.forget("pr")
    relay.attach(runtime.tenant("pr"))
    await insert(server, "pr", 1, 200)
    await relay.flush()
    expect(runtime.tenant("pr").log.lastTxid).toBe(before)
    const values = [...bus.byKey.values()].map((m) => (m.body as { row?: { v: string } }).row?.v)
    expect(values.sort()).toEqual(["v100", "v200"])
    // A fork starts at its fork point: the parent's history is not a gap.
    expect(warnings.some((line) => line.includes("OUTBOX_GAP"))).toBe(false)
    await relay.close()
  })

  test("the key names the change: same txid and state dedupe, a different state does not", () => {
    const same = dedupeKeyPrefix("app", "g", 7n, 0xabcn)
    expect(dedupeKeyPrefix("app", "g", 7n, 0xabcn)).toBe(same)
    expect(dedupeKeyPrefix("app", "g", 7n, 0xabdn)).not.toBe(same)
  })

  test("a cursor written against another history is discarded, and the log republished", async () => {
    const server = await logicalServer()
    await createDb(server, "app", "create table t (id integer primary key, v text)")
    await insert(server, "app", 3)
    const tenant = server.handle.runtime.tenant("app")
    // A cursor at the head whose checksum is not the log's: the log reached this txid another way.
    writeCursor(tenant.dir, "main", tenant.log.lastTxid, 1n)
    const bus = new FakeBus()
    const warnings: string[] = []
    const relay = relayFor(server, bus, warnings)
    relay.attach(tenant)
    await relay.flush()
    expect(warnings.some((line) => line.includes("is not the one the cursor was written against"))).toBe(true)
    expect(bus.byKey.size).toBe(3)
    await relay.close()
  })

  test("a drain awaiting the bus across a reset does not write its cursor into the new branch", async () => {
    const server = await logicalServer()
    await createDb(server, "base", "create table t (id integer primary key, v text)")
    await server.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "pr", from: { db: "base" } }),
    })
    await insert(server, "pr", 2)
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow: Publisher = { publish: () => gate }
    const relay = relayFor(server, slow)
    const runtime = server.handle.runtime
    relay.attach(runtime.tenant("pr"))
    const draining = relay.flush()
    await Bun.sleep(50)
    expect((await server.fetch("/v1/db/pr/reset", { method: "POST" })).ok).toBe(true)
    release()
    await draining
    expect(fs.existsSync(cursorPath(runtime.tenant("pr").dir))).toBe(false)
    await relay.close()
  })

  test("a transaction larger than a batch goes out in chunks, and the cursor moves once, at its end", async () => {
    const server = await logicalServer()
    await createDb(server, "big", "create table t (id integer primary key, v text)")
    const response = await server.fetch("/v1/db/big/query", {
      method: "POST",
      body: JSON.stringify({
        sql:
          "with recursive n(i) as (select 1 union all select i + 1 from n where i < 2500) " +
          "insert into t (v) select 'r' || i from n",
      }),
    })
    expect(response.ok).toBe(true)
    const tenant = server.handle.runtime.tenant("big")
    const sizes: number[] = []
    const bus = new FakeBus()
    // A bus with the real ceiling: more than 1000 in a request is refused.
    const capped: Publisher = {
      async publish(messages) {
        if (messages.length > 1000) throw new Error(`batch of ${messages.length} refused`)
        sizes.push(messages.length)
        // The crash, after the first chunk: nothing about the record may be marked done.
        if (sizes.length === 1) {
          await bus.publish(messages)
          throw new Error("crashed mid-record")
        }
        await bus.publish(messages)
      },
    }
    const runtime = server.handle.runtime
    const relay = new OutboxRelay(
      {
        registry: runtime.registry,
        owns: () => true,
        authors: () => true,
        generationOf: (db) => runtime.generationOf(db),
        startOf: () => 0n,
        onError: () => {},
        warn: () => {},
      },
      { rules: [RULE], batchSize: 5000, intervalMs: 60_000, publisherFor: () => capped },
    )
    relay.attach(tenant)
    await relay.flush()
    expect(readCursors(tenant.dir).get("main")?.txid ?? 0n).toBeLessThan(tenant.log.lastTxid)
    const deadline = Date.now() + 5000
    while (bus.byKey.size < 2500 && Date.now() < deadline) await Bun.sleep(20)
    await relay.flush()
    expect(bus.byKey.size).toBe(2500)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000)
    expect(readCursors(tenant.dir).get("main")?.txid).toBe(tenant.log.lastTxid)
    await relay.close()
  })

  test("[outbox] batchSize is clamped to the bus's batch ceiling", () => {
    const config = loadConfig({
      env: {},
      overrides: {
        replication: { logicalChanges: "row" },
        outbox: { batchSize: 50_000, rules: [{ busUrl: "http://bus", token: "t" }] },
      },
    })
    expect(config.outbox.batchSize).toBe(1000)
  })
})

describe("the publisher", () => {
  test("a 413 halves the batch until the bus takes it", async () => {
    const accepted: number[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { messages } = JSON.parse(String(init.body)) as { messages: unknown[] }
      if (messages.length > 2) return new Response(JSON.stringify({ error: "too big" }), { status: 413 })
      accepted.push(messages.length)
      return new Response(JSON.stringify({ results: [] }), { status: 201 })
    }) as unknown as typeof fetch
    const publisher = httpPublisher({ url: "http://bus", token: "t" }, { fetchImpl })
    const message = (i: number): BusMessage => ({ subject: "a", key: "k", dedupeKey: `d${i}`, body: i })
    await publisher.publish(Array.from({ length: 7 }, (_, i) => message(i)))
    expect(accepted.reduce((a, b) => a + b, 0)).toBe(7)
    expect(Math.max(...accepted)).toBeLessThanOrEqual(2)
  })
})
