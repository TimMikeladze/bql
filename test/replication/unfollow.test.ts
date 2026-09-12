// A replica used to keep a database the primary had deleted, and the name could be reused
// underneath it: both nodes stood at the same txid, so a `minTxid` read-your-writes check was
// *satisfied* by the stale copy. `docs/r7-unfollow.md` has the reproduction.
//
// The two-node tests here are the reproduction asserted the right way round. The scripted-primary
// tests below drive `ReplicaClient` against a socket a test writes the frames for, which is the
// only way to put a delete and a re-create inside one announcement — on real nodes the registry
// announces each of them the moment it happens.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  type ClientSocket,
  decodeJson,
  encodeJson,
  FRAME,
  FrameReader,
  generationId,
  makeNonce,
  ReplicaClient,
  ReplicaUnfollowed,
  type SubscribeBody,
} from "../../src/replication/index.ts"
import { TenantRegistry } from "../../src/tenant/index.ts"
import {
  createDb,
  type Node,
  query,
  startCluster,
  startReplica,
  stopAll,
  untilFollowing,
  untilSynced,
  until,
} from "./harness.ts"

afterEach(async () => {
  await stopAll()
  for (const { registry, dir } of scratch.splice(0)) {
    registry.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── two real nodes ─────────────────────────────────────────────────────────────────────────────

/** What `node` answers for `select v from t`, or null when it does not have the database. */
async function readValue(node: Node, db: string): Promise<string | null> {
  const response = await node.fetch(`/v1/db/${db}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "select v from t" }),
  })
  if (!response.ok) return null
  const body = (await response.json()) as { rows: unknown[][] }
  return (body.rows[0]?.[0] as string | undefined) ?? null
}

async function names(node: Node): Promise<string[]> {
  const body = await node.json<{ databases: { name: string }[] }>("/v1/db")
  return body.databases.map((one) => one.name)
}

describe("a database the primary deletes", () => {
  test("leaves the replica too, and takes its rows with it", async () => {
    const cluster = await startCluster(1)
    const replica = cluster.replicas[0] as Node
    await createDb(cluster.primary, "beta", "create table t (v text)")
    await query(cluster.primary, "beta", "insert into t values ('OLD-GENERATION')")
    await untilSynced(cluster.primary, replica, "beta")
    expect(await readValue(replica, "beta")).toBe("OLD-GENERATION")

    const deleted = await cluster.primary.fetch("/v1/db/beta", { method: "DELETE" })
    expect(deleted.status).toBe(200)

    await until(async () => !(await names(replica)).includes("beta"), "the replica to drop beta", 4000)
    expect(await readValue(replica, "beta")).toBeNull()
    // Disposed the way a primary-side delete disposes of one: recoverable, not removed.
    expect(fs.readdirSync(path.join(replica.dir, "trash")).some((one) => one.startsWith("beta-")))
      .toBe(true)
  })

  test("and is re-created under the same name never serves the old rows", async () => {
    const cluster = await startCluster(1)
    const replica = cluster.replicas[0] as Node
    await createDb(cluster.primary, "beta", "create table t (v text)")
    await query(cluster.primary, "beta", "insert into t values ('OLD-GENERATION')")
    await untilSynced(cluster.primary, replica, "beta")
    expect(await readValue(replica, "beta")).toBe("OLD-GENERATION")

    // Delete and re-create in one breath, then write. The txids line up with the old generation's
    // exactly — which is what made the stale copy pass a `minTxid` check before R7.
    await cluster.primary.fetch("/v1/db/beta", { method: "DELETE" })
    await createDb(cluster.primary, "beta", "create table t (v text)")
    await query(cluster.primary, "beta", "insert into t values ('NEW-GENERATION')")
    expect(await readValue(cluster.primary, "beta")).toBe("NEW-GENERATION")

    // Poll to the new generation, and fail the moment the old one is served on the way there.
    await until(async () => {
      const seen = await readValue(replica, "beta")
      expect(seen).not.toBe("OLD-GENERATION")
      return seen === "NEW-GENERATION"
    }, "the replica to serve the new generation", 4000)

    const primaryTxid = Number(cluster.primary.handle.registry.open("beta").txid)
    const replicaTxid = Number(replica.handle.registry.open("beta").txid)
    expect(replicaTxid).toBe(primaryTxid)
  })

  test("is not mistaken for a name a replica follows explicitly but has never been given", async () => {
    const cluster = await startCluster(1, { follow: ["acme"] })
    const replica = cluster.replicas[0] as Node
    await createDb(cluster.primary, "acme", "create table t (v text)")
    await createDb(cluster.primary, "beta", "create table t (v text)")
    await query(cluster.primary, "acme", "insert into t values ('KEPT')")
    await untilSynced(cluster.primary, replica, "acme")

    // `beta` was announced and never followed; deleting it must not disturb `acme`.
    await cluster.primary.fetch("/v1/db/beta", { method: "DELETE" })
    await until(
      async () => !(await names(cluster.primary)).includes("beta"),
      "the primary to drop beta",
      4000,
    )
    await Bun.sleep(250)

    expect(await names(replica)).toEqual(["acme"])
    expect(await readValue(replica, "acme")).toBe("KEPT")
    expect(replica.handle.runtime.replica?.status().unfollowed).toEqual([])
  })
})

// ── a primary the test writes the frames for ───────────────────────────────────────────────────

const scratch: { registry: TenantRegistry; dir: string }[] = []

function tempRegistry(): { registry: TenantRegistry; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-unfollow-"))
  const registry = TenantRegistry.open({ dir })
  const entry = { registry, dir }
  scratch.push(entry)
  return entry
}

const SECRET = "scripted-primary-secret"

/** A socket a test drives both ends of: it answers the handshake and records what the client sends. */
class ScriptedPrimary {
  readonly reader = new FrameReader()
  readonly sent: { type: number; body: Uint8Array }[] = []
  #listeners = new Map<string, (event: never) => void>()

  readonly socket: ClientSocket = {
    binaryType: "arraybuffer",
    send: (data) => {
      for (const frame of this.reader.push(data as Uint8Array)) this.sent.push(frame)
    },
    close: () => {},
    addEventListener: (type, listener) => {
      this.#listeners.set(type, listener)
      if (type === "close") queueMicrotask(() => this.#open())
    },
  }

  #open(): void {
    this.#listeners.get("open")?.(undefined as never)
    this.push(
      encodeJson(FRAME.HELLO, { proto: 1, node: "scripted", nonce: makeNonce() }),
    )
  }

  push(frame: Uint8Array): void {
    this.#listeners.get("message")?.({ data: frame } as never)
  }

  announce(databases: string[], generations?: Record<string, string>): void {
    this.push(
      encodeJson(FRAME.HELLO, {
        proto: 1,
        node: "scripted",
        ok: true,
        databases,
        ...(generations ? { generations } : {}),
      }),
    )
  }

  heartbeat(databases: string[], generations?: Record<string, string>): void {
    this.push(
      encodeJson(FRAME.HEARTBEAT, {
        ts: Date.now(),
        streams: [],
        databases,
        ...(generations ? { generations } : {}),
      }),
    )
  }

  /** Every `SUBSCRIBE` the client has sent, in order. */
  subscribes(): SubscribeBody[] {
    return this.sent
      .filter((frame) => frame.type === FRAME.SUBSCRIBE)
      .map((frame) => decodeJson<SubscribeBody>(frame.type, frame.body))
  }

  unsubscribed(): number[] {
    return this.sent
      .filter((frame) => frame.type === FRAME.UNSUBSCRIBE)
      .map((frame) => decodeJson<{ stream: number }>(frame.type, frame.body).stream)
  }

  /** Accepts the newest `SUBSCRIBE` at its own position, naming `generation`. */
  accept(generation: string): void {
    const last = this.subscribes().at(-1) as SubscribeBody
    this.push(
      encodeJson(FRAME.SUBSCRIBED, {
        stream: last.stream,
        db: last.db,
        mode: "stream",
        txid: last.fromTxid,
        epoch: 0,
        pageSize: 4096,
        generation,
      }),
    )
  }
}

function scriptedClient(options: { follow?: string[] } = {}): {
  client: ReplicaClient
  primary: ScriptedPrimary
  dir: string
  bootstrapDir: string
  notices: ReplicaUnfollowed[]
} {
  const { registry, dir } = tempRegistry()
  const primary = new ScriptedPrimary()
  const notices: ReplicaUnfollowed[] = []
  const bootstrapDir = path.join(dir, "bootstrap")
  const client = new ReplicaClient({
    registry,
    primary: "ws://scripted/v1/replication",
    secret: SECRET,
    node: "replica-1",
    bootstrapDir,
    ...(options.follow ? { follow: options.follow } : {}),
    onError: (err) => {
      if (err instanceof ReplicaUnfollowed) notices.push(err)
    },
    factory: () => primary.socket,
  })
  return { client, primary, dir, bootstrapDir, notices }
}

describe("a scripted primary", () => {
  test("that re-creates a database inside one announcement makes the replica drop the copy", async () => {
    const { client, primary, dir, notices } = scriptedClient()
    client.start()
    await Bun.sleep(10)

    // The delete and the re-create both land between two announcements, so the *name* never
    // leaves the list. Only the generation id says one beta is not the next one.
    primary.announce(["beta"], { beta: "1111111111111111" })
    await Bun.sleep(5)
    primary.accept("1111111111111111")
    await Bun.sleep(5)
    expect(client.status().streams[0]?.generation).toBe("1111111111111111")

    primary.heartbeat(["beta"], { beta: "2222222222222222" })
    await Bun.sleep(10)
    client.stop()

    // Dropped through the registry's delete path — recoverable — and asked for again from zero.
    expect(fs.readdirSync(path.join(dir, "trash")).some((one) => one.startsWith("beta-"))).toBe(true)
    expect(primary.unsubscribed()).toEqual([1])
    const asked = primary.subscribes()
    expect(asked.length).toBe(2)
    expect(asked[1]?.fromTxid).toBe("0")
    expect(asked[1]?.generation).toBeUndefined()
    expect(notices.map((one) => one.message).join(" ")).toContain("was re-created")
  })

  test("that announces nothing drops nothing, and says so once", async () => {
    const { client, primary, dir, notices } = scriptedClient()
    client.start()
    await Bun.sleep(10)
    primary.announce(["acme", "beta"], { acme: "aaaaaaaaaaaaaaaa", beta: "bbbbbbbbbbbbbbbb" })
    await Bun.sleep(5)
    expect(client.followed.sort()).toEqual(["acme", "beta"])

    // A primary that announced two databases and now announces none is a wrong URL or a primary
    // restarted empty far more often than it is two deletions in one tick.
    primary.heartbeat([], {})
    primary.heartbeat([], {})
    await Bun.sleep(10)

    expect(client.followed.sort()).toEqual(["acme", "beta"])
    expect(client.status().unfollowed).toEqual([])
    expect(fs.existsSync(path.join(dir, "trash"))).toBe(false)
    expect(notices.length).toBe(1)
    expect(notices[0]?.message).toContain("announced no databases")
    client.stop()
  })

  test("that drops a database mid-bootstrap leaves no temp file behind", async () => {
    const { client, primary, bootstrapDir } = scriptedClient()
    client.start()
    await Bun.sleep(10)
    primary.announce(["beta"], { beta: "1111111111111111" })
    await Bun.sleep(5)

    const stream = (primary.subscribes().at(-1) as SubscribeBody).stream
    primary.push(
      encodeJson(FRAME.SUBSCRIBED, {
        stream,
        db: "beta",
        mode: "snapshot",
        txid: "7",
        epoch: 0,
        pageSize: 4096,
        generation: "1111111111111111",
      }),
    )
    primary.push(
      encodeJson(FRAME.SNAPSHOT_BEGIN, {
        stream,
        txid: "7",
        epoch: 0,
        checksum: "0",
        bytes: 8192,
        pageSize: 4096,
        pages: 2,
      }),
    )
    await Bun.sleep(5)
    expect(fs.readdirSync(bootstrapDir).filter((one) => one.endsWith(".db")).length).toBe(1)

    // The announcement arrives while the snapshot is still in flight.
    primary.heartbeat([], undefined)
    primary.heartbeat(["gamma"], { gamma: "3333333333333333" })
    await Bun.sleep(10)
    client.stop()

    expect(client.followed).not.toContain("beta")
    expect(fs.readdirSync(bootstrapDir).filter((one) => one.endsWith(".db"))).toEqual([])
  })
})

describe("the generation id", () => {
  test("is stable for a database and different for a fresh one of the same name", () => {
    const row = { name: "beta", createdAtMs: 1_700_000_000_000, pageSize: 4096 }
    expect(generationId(row)).toBe(generationId({ ...row }))
    expect(generationId(row)).toMatch(/^[0-9a-f]{16}$/)
    expect(generationId({ ...row, createdAtMs: row.createdAtMs + 1 })).not.toBe(generationId(row))
    expect(generationId({ ...row, name: "gamma" })).not.toBe(generationId(row))
  })
})

describe("a replica restarted while the primary churned", () => {
  test("drops a database that left the announcement while it was down", async () => {
    const cluster = await startCluster(1)
    const replica = cluster.replicas[0] as Node
    await createDb(cluster.primary, "acme", "create table t (v text)")
    await createDb(cluster.primary, "beta", "create table t (v text)")
    await query(cluster.primary, "beta", "insert into t values ('OLD-GENERATION')")
    await untilFollowing(replica, "acme")
    await untilFollowing(replica, "beta")
    const dir = replica.dir
    await replica.close()

    await cluster.primary.fetch("/v1/db/beta", { method: "DELETE" })

    // The restarted node has no stream to notice is missing — only the generation ledger in
    // `<bootstrapDir>/generations.json` remembers that it holds a copy at all.
    const restarted = await startReplica(cluster.primary, { node: "replica-1", dir })
    await until(
      async () => !(await names(restarted)).includes("beta"),
      "the restarted replica to drop beta",
      4000,
    )
    expect(await readValue(restarted, "beta")).toBeNull()
    // And the database that stayed announced is untouched.
    expect(await names(restarted)).toEqual(["acme"])
  })
})
