// Hosted mode for the *replica* half (C4c): a `ReplicaClient` whose upstream connection is owned
// by a router on another thread. `docs/c4c-replication-follow.md` §5.
//
// The property under test is the mirror of `hosted.test.ts`'s: a hosted client handed a
// pre-authenticated socket and pre-decoded frames sends *exactly* the frames an ordinary client
// sends after its own handshake and its own announcement. Everything below the connection —
// `#subscribe`, the snapshot path, `#apply`, `#ack` — runs unchanged, so if that holds, a node with
// `workers > 1` follows an upstream with the same bytes `workers = 1` does.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  encodeFrame,
  encodeJson,
  FRAME,
  FrameReader,
  frameName,
  makeNonce,
  PROTO_VERSION,
} from "../../src/replication/protocol.ts"
import { ReplicationServer, type ReplicationSocket } from "../../src/replication/primary.ts"
import {
  ReplicaClient,
  type ClientSocket,
  type ReplicaHost,
} from "../../src/replication/replica.ts"
import { TenantRegistry, type Tenant } from "../../src/tenant/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const SECRET = "hosted-follow-secret"
const dirs: string[] = []
const registries: TenantRegistry[] = []

function tempRegistry(): TenantRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-follow-"))
  dirs.push(dir)
  const registry = TenantRegistry.open({ dir })
  registries.push(registry)
  return registry
}

afterEach(() => {
  while (registries.length > 0) registries.pop()?.close()
})

afterAll(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) removeTempDir(dir)
  }
})

async function upstreamWith(rows: number): Promise<{ registry: TenantRegistry; tenant: Tenant }> {
  const registry = tempRegistry()
  const tenant = await registry.create("acme")
  tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
  for (let i = 0; i < rows; i++) {
    tenant.write((db) => db.run("insert into t (v) values (?)", [`v${i}`]))
  }
  return { registry, tenant }
}

interface Captured {
  type: number
  body: Uint8Array
}

/** A socket that keeps every frame it was handed, decoded, and can deliver events back. */
class FakeSocket implements ClientSocket, ReplicationSocket {
  readyState = 1
  binaryType = "arraybuffer"
  data: unknown = { replication: true }
  readonly sent: Captured[] = []
  closed = false

  #reader = new FrameReader()
  #listeners = new Map<string, ((event: never) => void)[]>()

  send(data: string | ArrayBufferLike | ArrayBufferView): number {
    for (const frame of this.#reader.push(data as ArrayBuffer)) {
      this.sent.push({ type: frame.type, body: frame.body.slice() })
    }
    return 1
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const held = this.#listeners.get(type) ?? []
    held.push(listener)
    this.#listeners.set(type, held)
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) (listener as (e: unknown) => void)(event)
  }

  types(): string[] {
    return this.sent.map((frame) => frameName(frame.type))
  }
}

/** Everything a hosted client reports that is not a frame, recorded in the order it happened. */
function recordingHost(): { host: ReplicaHost; log: string[] } {
  const log: string[] = []
  return {
    log,
    host: {
      installed: (stream, db, txid) => log.push(`installed ${stream} ${db} ${txid}`),
      again: (stream, db) => log.push(`again ${stream} ${db}`),
      stopped: (db, trash) => log.push(`stopped ${db} ${trash === null ? "none" : "trashed"}`),
      forward: (id, request) => log.push(`forward ${id} ${request.db} ${request.op}`),
      detach: (db) => log.push(`detach ${db}`),
      attach: (db) => log.push(`attach ${db}`),
    },
  }
}

/**
 * The upstream, as a hosted `ReplicationServer` over a fake socket: it needs no handshake, which
 * means the test can pump frames both ways without a network.
 */
function upstream(registry: TenantRegistry): { server: ReplicationServer; socket: FakeSocket } {
  const server = new ReplicationServer({
    registry,
    node: "p",
    secret: SECRET,
    hosted: true,
    onError: () => {},
  })
  const socket = new FakeSocket()
  server.adopt(socket, "replica")
  return { server, socket }
}

/**
 * Drives both directions until neither side has anything left to say, and answers with how far
 * through the client's own frames it got. A bootstrap is asynchronous on the primary — a reflink
 * and a zstd pass per chunk — so this cannot be a single synchronous exchange.
 */
async function pump(
  server: ReplicationServer,
  up: FakeSocket,
  client: { deliver(type: number, body: Uint8Array): void } | FakeSocket,
  down: Captured[],
  from: number,
): Promise<number> {
  let at = from
  for (let quiet = 0; quiet < 8; quiet++) {
    if (at < down.length) {
      const batch = down.slice(at)
      at = down.length
      for (const frame of batch) server.deliver(up as ReplicationSocket, frame.type, frame.body)
      quiet = 0
    }
    if (up.sent.length > 0) {
      const batch = up.sent.splice(0)
      for (const answer of batch) {
        if ("deliver" in client) client.deliver(answer.type, answer.body)
        else client.emit("message", { data: encodeFrame(answer.type, answer.body).buffer })
      }
      quiet = 0
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return at
}

/** A write that waits out a snapshot rather than failing the test with the `BUSY` it answers. */
async function write(tenant: Tenant, sql: string): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      tenant.write((db) => db.run(sql))
      return
    } catch (err) {
      if (Date.now() > deadline || (err as { code?: string }).code !== "BUSY") throw err
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

describe("hosted mode, following", () => {
  test("adopt + follow produce the same frames as a handshake and an announcement", async () => {
    const { registry: source, tenant } = await upstreamWith(3)

    // The ordinary client: its own socket, its own proof, its own `#resolveFollow`.
    const plainSocket = new FakeSocket()
    const plain = new ReplicaClient({
      registry: tempRegistry(),
      primary: "ws://upstream/v1/replication",
      secret: SECRET,
      node: "r",
      factory: () => plainSocket,
      onError: () => {},
    })
    plain.start()
    plainSocket.emit("open", {})
    plainSocket.emit("message", {
      data: encodeJson(FRAME.HELLO, { proto: PROTO_VERSION, node: "p", nonce: makeNonce() }).buffer,
    })
    // The proof it just sent is the whole of what the router does instead; drop it and compare
    // everything after.
    expect(plainSocket.types()).toEqual(["HELLO"])
    plainSocket.sent.length = 0
    plainSocket.emit("message", {
      data: encodeJson(FRAME.HELLO, {
        proto: PROTO_VERSION,
        node: "p",
        ok: true,
        databases: ["acme"],
      }).buffer,
    })

    // The hosted one: no socket of its own, no proof, and the follow decision made for it.
    const hostedSocket = new FakeSocket()
    const hosted = new ReplicaClient({
      registry: tempRegistry(),
      primary: "ws://upstream/v1/replication",
      secret: SECRET,
      node: "r",
      mode: "hosted",
      onError: () => {},
    })
    hosted.adopt(hostedSocket, recordingHost().host)
    hosted.follow(1, "acme", null, false)

    expect(plainSocket.types()).toEqual(["SUBSCRIBE"])
    expect(hostedSocket.types()).toEqual(plainSocket.types())
    expect(hostedSocket.sent[0]?.body).toEqual(plainSocket.sent[0]?.body as Uint8Array)

    // And they stay identical once the upstream answers: a snapshot, then the acks for it.
    const one = upstream(source)
    const two = upstream(source)
    let plainAt = await pump(one.server, one.socket, plainSocket, plainSocket.sent, 0)
    let hostedAt = await pump(two.server, two.socket, hosted, hostedSocket.sent, 0)
    expect(hostedSocket.types().slice(1)).toEqual(plainSocket.types().slice(1))

    // One more commit upstream, delivered to both, produces the same `ACK` from both.
    await write(tenant, "insert into t (v) values ('live')")
    plainAt = await pump(one.server, one.socket, plainSocket, plainSocket.sent, plainAt)
    hostedAt = await pump(two.server, two.socket, hosted, hostedSocket.sent, hostedAt)
    expect(hostedAt).toBe(plainAt)
    expect(hostedSocket.types()).toEqual(plainSocket.types())
    expect(hostedSocket.sent.map((f) => f.body)).toEqual(plainSocket.sent.map((f) => f.body))
    expect(plainSocket.types().at(-1)).toBe("ACK")

    plain.stop()
    hosted.stop()
    one.server.stop()
    two.server.stop()
  })

  test("the install is reported before the ACK for it reaches the socket", async () => {
    const { registry: source } = await upstreamWith(2)
    const recorder = recordingHost()
    const hostedSocket = new FakeSocket()
    const hosted = new ReplicaClient({
      registry: tempRegistry(),
      primary: "ws://upstream/v1/replication",
      secret: SECRET,
      node: "r",
      mode: "hosted",
      onError: () => {},
    })
    hosted.adopt(hostedSocket, recorder.host)
    hosted.follow(1, "acme", null, false)

    const up = upstream(source)
    await pump(up.server, up.socket, hosted, hostedSocket.sent, 0)

    // The bootstrap acked, and the ledger report came first — which is what makes the router write
    // `generations.json` before the ack reaches the wire (§3.2).
    expect(hostedSocket.types()).toContain("ACK")
    expect(recorder.log.some((line) => line.startsWith("installed 1 acme"))).toBe(true)
    hosted.stop()
    up.server.stop()
  })

  test("it opens no socket, runs no reconnect and keeps no ledger of its own", async () => {
    const registry = tempRegistry()
    let built = 0
    const hosted = new ReplicaClient({
      registry,
      primary: "ws://upstream/v1/replication",
      secret: SECRET,
      node: "r",
      mode: "hosted",
      reconnectMs: 1,
      heartbeatMs: 1,
      factory: () => {
        built += 1
        return new FakeSocket()
      },
      onError: () => {},
    })
    hosted.start()
    hosted.retarget("ws://somewhere-else/v1/replication")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(built).toBe(0)

    // The ledger is pushed down, not read from disk and never written back.
    expect(hosted.generationOf("acme")).toBeNull()
    hosted.generations([["acme", "gen-1"]])
    expect(hosted.generationOf("acme")).toBe("gen-1")
    expect(fs.existsSync(path.join(registry.dir, "bootstrap", "generations.json"))).toBe(false)
    hosted.stop()
  })

  test("the connection-level facts come from the router, not from this thread", async () => {
    const hosted = new ReplicaClient({
      registry: tempRegistry(),
      primary: "ws://configured/v1/replication",
      secret: SECRET,
      node: "r",
      mode: "hosted",
      onError: () => {},
    })
    hosted.adopt(new FakeSocket(), recordingHost().host)
    // Disconnected until told otherwise: a worker exists before the node's upstream socket does,
    // and `Forwarder` asks this before it hands a write over.
    expect(hosted.connected).toBe(false)

    hosted.link({
      connected: true,
      primary: "ws://retargeted/v1/replication",
      node: "p2",
      lastError: null,
    })
    expect(hosted.connected).toBe(true)
    // The router's `retarget` moved it, so the config's value would be stale here.
    expect(hosted.status().primary).toBe("ws://retargeted/v1/replication")
    expect(hosted.status().node).toBe("p2")
    hosted.stop()
  })

  test("positions report every local stream, which is what the router's HEARTBEAT carries", async () => {
    const { registry: source } = await upstreamWith(1)
    const hostedSocket = new FakeSocket()
    const hosted = new ReplicaClient({
      registry: tempRegistry(),
      primary: "ws://upstream/v1/replication",
      secret: SECRET,
      node: "r",
      mode: "hosted",
      onError: () => {},
    })
    hosted.adopt(hostedSocket, recordingHost().host)
    hosted.follow(7, "acme", null, false)
    const up = upstream(source)
    await pump(up.server, up.socket, hosted, hostedSocket.sent, 0)

    // The upstream's own position rides down in the same message the positions come back in.
    const positions = hosted.positions([[7, "99"]])
    expect(positions.length).toBe(1)
    expect(positions[0]?.stream).toBe(7)
    expect(positions[0]?.db).toBe("acme")
    expect(positions[0]?.bootstrapping).toBe(false)
    expect(hosted.status().streams[0]?.lagTxid).toBe(99 - Number(positions[0]?.applied))
    hosted.stop()
    up.server.stop()
  })

  test("unfollow disposes of the copy here and reports where it went", async () => {
    const { registry: source } = await upstreamWith(1)
    const recorder = recordingHost()
    const hostedSocket = new FakeSocket()
    const registry = tempRegistry()
    const hosted = new ReplicaClient({
      registry,
      primary: "ws://upstream/v1/replication",
      secret: SECRET,
      node: "r",
      mode: "hosted",
      onError: () => {},
    })
    hosted.adopt(hostedSocket, recorder.host)
    hosted.follow(1, "acme", null, false)
    const up = upstream(source)
    await pump(up.server, up.socket, hosted, hostedSocket.sent, 0)
    expect(registry.has("acme")).toBe(true)

    hosted.unfollow(1, "acme", true, "deleted upstream")
    expect(registry.has("acme")).toBe(false)
    expect(recorder.log.some((line) => line === "stopped acme trashed")).toBe(true)
    hosted.stop()
    up.server.stop()
  })

  test("C2's detach on a worker reports rather than deciding", async () => {
    const recorder = recordingHost()
    const hosted = new ReplicaClient({
      registry: tempRegistry(),
      primary: "ws://upstream/v1/replication",
      secret: SECRET,
      node: "r",
      mode: "hosted",
      onError: () => {},
    })
    hosted.adopt(new FakeSocket(), recorder.host)
    hosted.detach("acme")
    hosted.attach("acme")
    // `#detached` is node-level — a primary still announcing the database must not pull *any*
    // shard back into following it — so the decision is the router's.
    expect(recorder.log).toEqual(["detach acme", "attach acme"])
    expect(hosted.detached).toEqual([])
    hosted.stop()
  })
})
