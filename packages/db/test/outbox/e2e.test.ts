// X6 end to end: a real database server with `[outbox]` rules, a real bus in the same process, and
// then a webhook sink draining the bus into a local HTTP server. Rows go in one end and come out of
// the other, once each, through a restart of the database server.
//
// The bus is loaded by path at run time rather than imported: `packages/db` does not import the
// bus's source (`docs/monorepo.md`), and a test that type-checked the bus under this package's
// compiler options would be checking it against rules it was not written for.

import { afterAll, describe, expect, test } from "bun:test"
import { createDb, startTestServer, stopAll, tempDataDir } from "../server/harness.ts"

afterAll(stopAll)

interface Message {
  seq: number
  subject: string
  dedupeKey: string | null
  body: { db: string; table: string; op: string; txid: number; row?: { v: string } }
}
interface BusModule {
  BusStore: new (path: string) => { close(): void }
  createServer(options: Record<string, unknown>): { port: number; stop(force?: boolean): void }
  generateKey(): string
  BusClient: new (options: { url: string; token: string }) => {
    log(after?: number, limit?: number, options?: { subject?: string }): Promise<Message[]>
    subscribe(request: { name: string; pattern: string; deliverFrom?: string }): Promise<unknown>
  }
  SinkRunner: new (options: Record<string, unknown>) => { start(): Promise<void>; stop(): void }
  webhookSink(options: { url: string; secret?: string }): unknown
  verifyWebhookSignature(secret: string, header: string | null, body: string): boolean
}

const BUS_ENTRY = "../../../bus/src/index.ts"

async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(25)
  }
}

describe("outbox end to end", () => {
  test("committed rows reach a bus subject once each, and a webhook sink after it", async () => {
    const bus = (await import(BUS_ENTRY)) as BusModule
    const adminToken = bus.generateKey()
    const store = new bus.BusStore(":memory:")
    const busServer = bus.createServer({
      store,
      signingKey: bus.generateKey(),
      adminToken,
      port: 0,
      hostname: "127.0.0.1",
    })
    const busUrl = `http://127.0.0.1:${busServer.port}`
    const client = new bus.BusClient({ url: busUrl, token: adminToken })
    await client.subscribe({ name: "cdc", pattern: "db.>", deliverFrom: "beginning" })

    const received: Message[] = []
    let signed = true
    const hook = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const text = await req.text()
        signed &&= bus.verifyWebhookSignature("s3cret", req.headers.get("x-bql-signature"), text)
        for (const record of JSON.parse(text) as { body: Message["body"] }[]) {
          received.push({ body: record.body } as Message)
        }
        return new Response(null, { status: 204 })
      },
    })
    const sink = new bus.SinkRunner({
      client,
      id: "hook",
      subscription: "cdc",
      writer: bus.webhookSink({ url: `http://127.0.0.1:${hook.port}/`, secret: "s3cret" }),
      batchSize: 50,
      flushMs: 50,
    })
    const sinkDone = sink.start()

    const dir = tempDataDir()
    const overrides = {
      data: { dir },
      replication: { logicalChanges: "row" as const },
      outbox: {
        intervalMs: 50,
        rules: [{ db: "app-*", busUrl, token: adminToken, name: "main" }],
      },
    }
    try {
      let server = await startTestServer(overrides)
      // Created after the relay started: a new database matching the glob is picked up on open.
      await createDb(server, "app-1", "create table t (id integer primary key, v text)")
      await createDb(server, "other", "create table t (id integer primary key, v text)")
      const write = async (db: string, v: string) => {
        const response = await server.fetch(`/v1/db/${db}/query`, {
          method: "POST",
          body: JSON.stringify({ sql: "insert into t (v) values (?)", args: [v] }),
        })
        expect(response.ok).toBe(true)
      }
      for (let i = 0; i < 5; i++) await write("app-1", `a${i}`)
      await write("other", "ignored")

      await until(async () => (await client.log(0, 100, { subject: "db.>" })).length >= 5)
      let messages = await client.log(0, 100, { subject: "db.>" })
      expect(messages.map((m) => m.body.row?.v)).toEqual(["a0", "a1", "a2", "a3", "a4"])
      expect(new Set(messages.map((m) => m.subject))).toEqual(new Set(["db.app-1.t"]))
      expect(messages.every((m) => m.dedupeKey?.startsWith("app-1:"))).toBe(true)

      const status = await server.json<{ outbox: { rule: string; lag: number; published: number }[] }>(
        "/v1/db/app-1/replication",
      )
      expect(status.outbox).toEqual([expect.objectContaining({ rule: "main", lag: 0, published: 5 })])
      const metrics = await (await server.fetch("/metrics")).text()
      expect(metrics).toMatch(/bql_outbox_published_total\{[^}]*\} 5/)
      expect(metrics).toMatch(/bql_outbox_gaps_total\{[^}]*\} 0/)

      // A restart on the same directory: the cursor is on disk, nothing is published twice, and
      // the relay carries on with what is committed next.
      await server.close()
      server = await startTestServer(overrides)
      const again = async (v: string) => {
        const response = await server.fetch("/v1/db/app-1/query", {
          method: "POST",
          body: JSON.stringify({ sql: "insert into t (v) values (?)", args: [v] }),
        })
        expect(response.ok).toBe(true)
      }
      await again("a5")
      await until(async () => (await client.log(0, 100, { subject: "db.>" })).length >= 6)
      await Bun.sleep(150)
      messages = await client.log(0, 100, { subject: "db.>" })
      expect(messages.map((m) => m.body.row?.v)).toEqual(["a0", "a1", "a2", "a3", "a4", "a5"])

      // And out the far side: the webhook saw every row once, signed.
      await until(() => received.length >= 6)
      expect(received.map((m) => m.body.row?.v).sort()).toEqual(["a0", "a1", "a2", "a3", "a4", "a5"])
      expect(signed).toBe(true)
      await server.close()
    } finally {
      sink.stop()
      await sinkDone
      hook.stop(true)
      busServer.stop(true)
      store.close()
    }
  }, 30_000)
})
