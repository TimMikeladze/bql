// One scenario, driven the way a user drives the product: over the network surface, through the
// client SDK and through raw `fetch`/`WebSocket`. The tests in this file are a sequence, not a
// set — `bun test` runs a file in order, and each step builds on the state the last one left.
//
// Nothing here reaches into `src/` except the last test, where reaching in is the point: the WAL
// applier of `src/wal` is fed from a tenant's own log, which is the phase-1 replication path
// running on today's code.

import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BqlClientError } from "../../src/client/errors.ts"
import { createClient, type Client, type Db } from "../../src/client/index.ts"
import type { ServerHandle } from "../../src/server/app.ts"
import { tenantDir } from "../../src/tenant/index.ts"
import { computeFull, listSnapshots, TxnLog, WalApplier } from "../../src/wal/index.ts"
import {
  cleanupTempDirs,
  dumpDatabase,
  openSocket,
  openSse,
  saveDump,
  serve,
  tempDir,
  until,
  type SseCollector,
  type TestSocket,
} from "./harness.ts"

const DBS = ["alpha", "beta", "gamma"] as const
const TASKS = 20
const WRITES_PER_TASK = 6
const SUBSCRIBERS = 5

const SCHEMA = [
  "create table items(id integer primary key, owner integer, n integer)",
  "create table audit(id integer primary key, note text)",
]

let dataDir = ""
let scratch = ""
let handle: ServerHandle | null = null
let port = 0
let url = ""
let adminKey = ""
let client: Client

/** Every txid each database's writers were told, in commit order. */
const committed = new Map<string, number[]>()
/** Open handles the teardown has to reclaim whatever a test did. */
const openFeeds: SseCollector[] = []
const openSockets: TestSocket[] = []

function api(route: string, init: RequestInit & { token?: string | null } = {}): Promise<Response> {
  const { token, ...rest } = init
  const headers = new Headers(rest.headers)
  const bearer = token === undefined ? adminKey : token
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`)
  if (rest.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return fetch(`${url}${route}`, { ...rest, headers })
}

async function apiJson<T>(route: string, init?: RequestInit & { token?: string | null }): Promise<T> {
  const response = await api(route, init)
  const body = (await response.json()) as T & { error?: { message: string } }
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${JSON.stringify(body)}`)
  return body
}

async function restart(): Promise<void> {
  await handle?.close()
  handle = await serve(dataDir, port)
  expect(handle.server.port as number).toBe(port)
}

beforeAll(async () => {
  dataDir = tempDir()
  scratch = tempDir("bql-e2e-scratch-")
  handle = await serve(dataDir, 0)
  port = handle.server.port as number
  url = `http://127.0.0.1:${port}`
  adminKey = handle.adminKey as string
  client = createClient({ url, token: adminKey, retryMs: 50 })
})

afterAll(async () => {
  for (const collector of openFeeds) collector.close()
  for (const socket of openSockets) socket.close()
  client?.close()
  await handle?.close()
  cleanupTempDirs()
})

// ── 1. three tenants ───────────────────────────────────────────────────────────────────────────

describe("bql end to end", () => {
  test("creates three databases, each with its own schema and txid space", async () => {
    for (const name of DBS) {
      const created = await api("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
      expect(created.status).toBe(201)
      await client.db(name).batch(SCHEMA.map((sql) => ({ sql })))
      committed.set(name, [])
    }

    const listed = await apiJson<{ databases: { name: string; txid: number }[] }>("/v1/db")
    expect(listed.databases.map((d) => d.name).sort()).toEqual([...DBS].sort())
    // Two tables created in one atomic batch is one transaction, so every database is at txid 1.
    for (const row of listed.databases) expect(row.txid).toBe(1)
  })

  // ── 2. concurrent writes under twenty subscribers per database ───────────────────────────────

  test(
    "every commit reaches every changes subscriber exactly once, and live results converge",
    async () => {
      const feeds = new Map<string, SseCollector[]>()
      const lives = new Map<string, TestSocket[]>()

      for (const name of DBS) {
        const collectors: SseCollector[] = []
        for (let i = 0; i < SUBSCRIBERS; i++) {
          // The route registers the subscription before it answers, so a write after this line
          // cannot slip past the subscriber.
          const collector = await openSse(`${url}/v1/db/${name}/changes?include=pk`, {
            token: adminKey,
          })
          collectors.push(collector)
          openFeeds.push(collector)
        }
        feeds.set(name, collectors)

        const sockets: TestSocket[] = []
        for (let i = 0; i < SUBSCRIBERS; i++) {
          const socket = await openSocket(
            `ws://127.0.0.1:${port}/v1/ws?token=${encodeURIComponent(adminKey)}`,
          )
          const reply = await socket.ask({
            op: "subscribe",
            db: name,
            kind: "live",
            sql: "select count(*) c, coalesce(sum(n), 0) s from items",
          })
          expect(reply.ok).toBe(true)
          sockets.push(socket)
          openSockets.push(socket)
        }
        lives.set(name, sockets)
      }

      // 20 tasks, writing round-robin across all three databases at once.
      await Promise.all(
        Array.from({ length: TASKS }, async (_, task) => {
          for (let i = 0; i < WRITES_PER_TASK; i++) {
            const name = DBS[(task + i) % DBS.length] as string
            const written = await client
              .db(name)
              .sql`insert into items(owner, n) values (${task}, ${i})`.run()
            ;(committed.get(name) as number[]).push(written.txid as number)
          }
        }),
      )

      const perDb = TASKS * WRITES_PER_TASK / DBS.length
      for (const name of DBS) {
        const txids = committed.get(name) as number[]
        // Every write is still answered, with its own result and its own txid.
        expect(txids.length).toBe(perDb)
        const sorted = [...txids].sort((a, b) => a - b)
        const distinct = [...new Set(sorted)]
        // **`[limits] groupCommit` is on by default**, so writes that arrive together are folded
        // into one transaction and share its txid. This is the contract that change made, and it
        // is written down here: there are no more transactions than writes, and the txid space the
        // single writer hands out is still one dense ascending run — it is the *writes per
        // transaction* that moved, not the sequence.
        expect(distinct.length).toBeLessThanOrEqual(perDb)
        expect(distinct.length).toBeGreaterThan(0)
        expect(distinct[distinct.length - 1] as number).toBe(
          (distinct[0] as number) + distinct.length - 1,
        )
      }

      // Every SSE subscriber saw every write, once — **one event per statement** since L8, keyed
      // `(txid, seq)`. Group commit folds concurrent writes into one transaction, so the txids
      // repeat; what does not repeat is the key, which is the point of it.
      for (const name of DBS) {
        const txids = (committed.get(name) as number[]).sort((a, b) => a - b)
        const lastTxid = txids[txids.length - 1] as number
        for (const collector of feeds.get(name) as SseCollector[]) {
          await collector.waitFor(
            () => collector.of("change").length >= txids.length,
            15_000,
            `${txids.length} change events on ${name}`,
          )
          const seen = collector.of("change")
          // One event per write, and every one of them carries the txid it committed in.
          expect(seen.length).toBe(txids.length)
          expect(seen.map((e) => e.data.txid as number)).toEqual(txids)
          // `(txid, seq)` is distinct across the whole feed: the key a downstream consumer dedupes
          // on, which `txid` alone could not be once a fold shares one.
          const keys = seen.map((e) => `${e.data.txid}.${e.data.seq}`)
          expect(new Set(keys).size).toBe(keys.length)
          // Within one transaction the sequence is dense and ascending from 0.
          const bySeq = new Map<number, number[]>()
          for (const event of seen) {
            const txid = event.data.txid as number
            const list = bySeq.get(txid) ?? []
            list.push(event.data.seq as number)
            bySeq.set(txid, list)
          }
          for (const [, seqs] of bySeq) {
            expect(seqs).toEqual(seqs.map((_, i) => i))
          }
          expect(collector.errors).toEqual([])
          // `id:` is the position, `txid.seq`, which is what a `Last-Event-ID` resume is built on.
          const tail = bySeq.get(lastTxid) as number[]
          expect(collector.lastId).toBe(`${lastTxid}.${tail[tail.length - 1]}`)
        }
      }

      // Every live subscriber converged on the committed state. Re-runs are coalesced per tick, so
      // a live query is not expected to emit once per commit — only to end up right.
      for (const name of DBS) {
        const total = (
          await apiJson<{ rows: number[][] }>(`/v1/db/${name}/query`, {
            method: "POST",
            body: JSON.stringify({ sql: "select count(*) c, coalesce(sum(n), 0) s from items" }),
          })
        ).rows[0] as number[]
        for (const socket of lives.get(name) as TestSocket[]) {
          await socket.waitFor(
            () => {
              const rows = socket.pushes.filter((p) => p.event === "rows")
              const last = rows[rows.length - 1]
              return (
                last !== undefined &&
                JSON.stringify((last.data as { rows: unknown }).rows) === JSON.stringify([total])
              )
            },
            15_000,
            `the live query on ${name} to converge on ${JSON.stringify(total)}`,
          )
        }
      }

      for (const collector of feeds.values()) for (const c of collector) c.close()
      for (const sockets of lives.values()) for (const s of sockets) s.close()
    },
    30_000,
  )

  // ── 3. a fork at a mid txid is the primary at that txid ──────────────────────────────────────

  test("a fork at a txid dumps identically to the primary taken at that txid", async () => {
    const midTxid = (await apiJson<{ txid: number }>("/v1/db/alpha")).txid
    // `GET /dump` snapshots the tenant as it stands, which right now is exactly `midTxid`.
    const primaryAtMid = await saveDump(
      await api("/v1/db/alpha/dump"),
      path.join(scratch, "alpha-at-mid.db"),
    )

    for (let i = 0; i < 10; i++) {
      await client.db("alpha").sql`insert into items(owner, n) values (${99}, ${i})`.run()
    }
    expect((await apiJson<{ txid: number }>("/v1/db/alpha")).txid).toBe(midTxid + 10)

    const forked = await api("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "alpha-fork", from: { db: "alpha", at: midTxid } }),
    })
    expect(forked.status).toBe(201)
    expect(((await forked.json()) as { txid: number }).txid).toBe(midTxid)

    const forkFile = await saveDump(
      await api("/v1/db/alpha-fork/dump"),
      path.join(scratch, "alpha-fork.db"),
    )
    expect(dumpDatabase(forkFile)).toBe(dumpDatabase(primaryAtMid))
    // And the fork is a live database, not just a file.
    const rows = await client.db("alpha-fork").sql`select count(*) c from items`.values()
    expect((rows[0] as number[])[0]).toBe(TASKS * WRITES_PER_TASK / DBS.length)
  })

  // ── 4. snapshot, then point-in-time restore into a new database ──────────────────────────────

  test("a snapshot plus the log restores the database as it was at that txid", async () => {
    const before = await client.db("beta").sql`select id, owner, n from items order by id`.values()
    const snapshot = await apiJson<{ snapshotId: string; txid: number }>("/v1/db/beta/snapshot", {
      method: "POST",
      body: "{}",
    })
    expect(snapshot.txid).toBeGreaterThan(0)

    for (let i = 0; i < 10; i++) {
      await client.db("beta").sql`insert into items(owner, n) values (${77}, ${i})`.run()
    }

    const restored = await api("/v1/db/beta/restore", {
      method: "POST",
      body: JSON.stringify({ at: snapshot.txid, into: "beta-pitr" }),
    })
    expect(restored.status).toBe(201)
    expect(await restored.json()).toMatchObject({ name: "beta-pitr", at: snapshot.txid })

    const after = await client
      .db("beta-pitr")
      .sql`select id, owner, n from items order by id`.values()
    expect(after.length).toBe(before.length)
    expect([...after]).toEqual([...before])
    // The database it was restored from kept its own later history.
    const live = await client.db("beta").sql`select count(*) c from items`.values()
    expect((live[0] as number[])[0]).toBe(before.length + 10)
  })

  // ── 5. token scoping through the SDK ─────────────────────────────────────────────────────────

  test("a read-only token cannot write, and a table ACL is enforced through the SDK", async () => {
    const ro = await apiJson<{ token: string }>("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ dbs: ["alpha"], scope: "ro", ttl: 600 }),
    })
    const reader = createClient({ url, token: ro.token })
    const seen = await reader.db("alpha").sql`select count(*) c from items`.values()
    expect((seen[0] as number[])[0]).toBeGreaterThan(0)

    const refused = await failure(
      reader.db("alpha").sql`insert into items(owner, n) values (1, 1)`.run(),
    )
    expect(refused.status).toBe(403)
    expect(refused.code).toBe("NOT_AUTHORIZED")

    // A token for a database it was not minted for cannot even see that the database exists.
    const elsewhere = await failure(reader.db("beta").sql`select 1`)
    expect(elsewhere.status).toBe(403)
    reader.close()

    const scoped = await apiJson<{ token: string }>("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({
        dbs: ["gamma"],
        scope: "rw",
        tables: { items: "r", audit: "rw" },
        ttl: 600,
      }),
    })
    const limited = createClient({ url, token: scoped.token })
    const gamma: Db = limited.db("gamma")
    expect(((await gamma.sql`select count(*) c from items`.values())[0] as number[])[0]).toBe(
      TASKS * WRITES_PER_TASK / DBS.length,
    )
    const writeDenied = await failure(gamma.sql`insert into items(owner, n) values (1, 1)`.run())
    expect(writeDenied.status).toBe(403)
    const allowed = await gamma.sql`insert into audit(note) values (${"scoped"})`.run()
    expect(allowed.affectedRows).toBe(1)
    limited.close()
  })

  // ── 6. a restart, a reconnect, and Last-Event-ID ─────────────────────────────────────────────

  test("a disconnected subscriber resumes from Last-Event-ID without a gap", async () => {
    const first = await openSse(`${url}/v1/db/gamma/changes?include=pk`, { token: adminKey })
    const early: number[] = []
    for (let i = 0; i < 3; i++) {
      early.push(
        (await client.db("gamma").sql`insert into items(owner, n) values (${5}, ${i})`.run())
          .txid as number,
      )
    }
    await first.waitFor(() => first.of("change").length >= 3, 10_000, "three change events")
    const resumeFrom = first.lastId as string
    // L8: the id is `txid.seq`. These writes are serialised — each awaits the last — so each is
    // its own transaction and its own single statement, which is `seq: 0`.
    expect(resumeFrom).toBe(`${early[2]}.0`)
    first.close()

    // Two commits land while nobody is listening. The engine is retained past its last subscriber
    // precisely so the ring keeps filling for a client that comes back.
    const missed: number[] = []
    for (let i = 0; i < 2; i++) {
      missed.push(
        (await client.db("gamma").sql`insert into items(owner, n) values (${6}, ${i})`.run())
          .txid as number,
      )
    }

    const second = await openSse(`${url}/v1/db/gamma/changes?include=pk`, {
      token: adminKey,
      lastEventId: resumeFrom,
    })
    openFeeds.push(second)
    await second.waitFor(() => second.of("change").length >= 2, 10_000, "the two missed events")
    expect(second.of("change").map((e) => e.data.txid)).toEqual(missed)
    expect(second.of("change").map((e) => e.data.seq)).toEqual([0, 0])
    expect(second.of("reset").length).toBe(0)

    // And a bare txid still resumes, which is what every client written before L8 sends.
    const bare = await openSse(`${url}/v1/db/gamma/changes?include=pk`, {
      token: adminKey,
      lastEventId: String(early[2]),
    })
    openFeeds.push(bare)
    await bare.waitFor(() => bare.of("change").length >= 2, 10_000, "the same two, by bare txid")
    expect(bare.of("change").map((e) => e.data.txid)).toEqual(missed)
    expect(bare.of("reset").length).toBe(0)
    bare.close()

    const next = (
      await client.db("gamma").sql`insert into items(owner, n) values (${7}, ${0})`.run()
    ).txid as number
    await second.waitFor(() => second.of("change").length >= 3, 10_000, "the live tail")
    expect(second.of("change").map((e) => e.data.txid)).toEqual([...missed, next])
    second.close()
  })

  test("the server restarts on the same data directory and clients carry on", async () => {
    const beforeTxid = (await apiJson<{ txid: number }>("/v1/db/gamma")).txid
    const stale = String(beforeTxid - 3)

    // An SDK feed that is holding the connection when the listener goes away.
    const feed = client.db("gamma").changes()
    const delivered: number[] = []
    const resets: number[] = []
    feed.on("change", (event) => delivered.push(event.txid))
    feed.on("reset", (event) => resets.push(event.txid))
    feed.on("error", () => {})
    const firstAfterOpen = (
      await client.db("gamma").sql`insert into items(owner, n) values (${8}, ${1})`.run()
    ).txid as number
    await until(() => delivered.includes(firstAfterOpen), 10_000, () => "the feed to be live")

    await restart()

    // The catalog, the log and the databases all survived, and the txid did not go backwards.
    const afterTxid = (await apiJson<{ txid: number }>("/v1/db/gamma")).txid
    expect(afterTxid).toBe(firstAfterOpen)
    const listed = await apiJson<{ databases: { name: string }[] }>("/v1/db")
    expect(listed.databases.map((d) => d.name).sort()).toEqual(
      ["alpha", "alpha-fork", "beta", "beta-pitr", "gamma"].sort(),
    )

    const afterRestart = (
      await client.db("gamma").sql`insert into items(owner, n) values (${9}, ${1})`.run()
    ).txid as number
    expect(afterRestart).toBe(afterTxid + 1)

    // The feed reconnects on its own. The change ring lives in memory, so whether it can serve the
    // position the client held depends on whether a commit landed before the reconnect: the ring
    // the restarted server builds is sealed at the txid it finds. Either answer is correct, and a
    // `reset` is the honest one — what must not happen is silence, or an event delivered twice.
    await until(
      () => resets.length > 0 || delivered.includes(afterRestart),
      15_000,
      () => `the feed to reconnect; delivered ${delivered.join(",")}, resets ${resets.length}`,
    )
    const tailAfterRestart = (
      await client.db("gamma").sql`insert into items(owner, n) values (${9}, ${2})`.run()
    ).txid as number
    await until(
      () => delivered.includes(tailAfterRestart),
      15_000,
      () => `the reconnected feed to deliver ${tailAfterRestart}; it has ${delivered.join(",")}`,
    )
    expect(new Set(delivered).size).toBe(delivered.length)
    expect([...delivered].sort((a, b) => a - b)).toEqual(delivered)
    feed.close()

    // The change ring lives in memory, so a `Last-Event-ID` from before the restart is a position
    // the new ring cannot serve, and the honest answer is `reset` rather than an empty backlog.
    const resumed = await openSse(`${url}/v1/db/gamma/changes?include=pk`, {
      token: adminKey,
      lastEventId: stale,
    })
    openFeeds.push(resumed)
    await resumed.waitFor(() => resumed.of("reset").length > 0, 10_000, "a reset after a restart")
    const tail = (
      await client.db("gamma").sql`insert into items(owner, n) values (${9}, ${3})`.run()
    ).txid as number
    await resumed.waitFor(() => resumed.of("change").length > 0, 10_000, "the tail after a reset")
    expect(resumed.of("change").map((e) => e.data.txid)).toEqual([tail])
    resumed.close()
  }, 30_000)

  // ── 7. the phase-1 replication path, on today's code ─────────────────────────────────────────

  test("the WAL applier replays a tenant's log into a fresh directory, byte for byte", async () => {
    const snapshot = await apiJson<{ txid: number }>("/v1/db/alpha/snapshot", {
      method: "POST",
      body: "{}",
    })
    for (let i = 0; i < 25; i++) {
      await client.db("alpha").sql`insert into items(owner, n) values (${42}, ${i})`.run()
    }
    const primary = await apiJson<{ txid: number; epoch: number; checksum: string }>(
      "/v1/db/alpha/replication",
    )
    expect(primary.txid).toBeGreaterThan(snapshot.txid)

    // Everything below reads files, so nothing may be writing them.
    client.close()
    await handle?.close()
    handle = null

    const primaryDir = tenantDir(dataDir, "alpha")
    const snapshots = listSnapshots(primaryDir)
    const ref = snapshots.find((s) => s.txid === String(snapshot.txid))
    if (!ref) throw new Error(`no snapshot at ${snapshot.txid} in ${JSON.stringify(snapshots)}`)

    // A replica starts life as a physical copy of a snapshot, so its page numbers match.
    const replicaDir = path.join(scratch, "replica")
    fs.mkdirSync(replicaDir, { recursive: true })
    const replicaPath = path.join(replicaDir, "main.db")
    fs.copyFileSync(ref.path, replicaPath)
    const base = computeFull(replicaPath, { includeWal: false })
    expect(base.checksum.toString()).toBe(ref.checksum)

    const applier = new WalApplier({ dbPath: replicaPath, dir: replicaDir })
    applier.seed({
      txid: BigInt(ref.txid),
      epoch: ref.epoch,
      postChecksum: base.checksum,
      dbSizePages: base.pages,
      pageSize: base.pageSize,
    })

    const log = TxnLog.open({ dir: primaryDir })
    let applied = 0
    for (const record of log.iterate(BigInt(ref.txid) + 1n)) {
      applier.apply(record)
      applied++
    }
    log.close()

    expect(applied).toBe(primary.txid - snapshot.txid)
    expect(applier.position.txid).toBe(BigInt(primary.txid))
    // The rolling checksum the primary reports and the one the replica folded to are the same
    // number, which is the `(txid, checksum)` position pair of design §4.3.
    expect(applier.position.postChecksum.toString()).toBe(primary.checksum)
    applier.close()

    expect(dumpDatabase(replicaPath)).toBe(dumpDatabase(path.join(primaryDir, "main.db")))
  }, 30_000)
})

/** The error a promise rejected with. Fails the test when it resolved instead. */
async function failure(promise: PromiseLike<unknown>): Promise<BqlClientError> {
  try {
    await promise
  } catch (err) {
    return err as BqlClientError
  }
  throw new Error("expected the call to fail, and it did not")
}
