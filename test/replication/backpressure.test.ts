// Backpressure on the primary's side, driven through a fake socket rather than a real one.
//
// `ws.send` returning -1 (buffered) or 0 (refused) is the only signal Bun gives, and neither can
// be provoked over loopback with test-sized records — so the socket is the thing under test's own
// interface, and the records are real ones out of a real tenant's log.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  decodeJson,
  encodeJson,
  FRAME,
  FrameReader,
  frameName,
  makeProof,
  PROTO_VERSION,
  type ErrorBody,
  type HelloBody,
} from "../../src/replication/protocol.ts"
import {
  ReplicationServer,
  type ReplicationSocket,
} from "../../src/replication/primary.ts"
import { TenantRegistry, type Tenant } from "../../src/tenant/index.ts"

const SECRET = "backpressure-secret"
const dirs: string[] = []
const registries: TenantRegistry[] = []

afterEach(() => {
  while (registries.length > 0) registries.pop()?.close()
})

afterAll(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function primaryWith(rows: number): Promise<{ registry: TenantRegistry; tenant: Tenant }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-backpressure-"))
  dirs.push(dir)
  const registry = TenantRegistry.open({ dir })
  registries.push(registry)
  const tenant = await registry.create("acme")
  tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
  for (let i = 0; i < rows; i++) {
    tenant.write((db) => db.run("insert into t (v) values (?)", [`v${i}`]))
  }
  return { registry, tenant }
}

/**
 * A socket whose `send` returns whatever the test says next: 1 for accepted, -1 for buffered,
 * 0 for refused. Everything it was handed is decoded back into frames.
 */
class FakeSocket implements ReplicationSocket {
  readyState = 1
  data: unknown = { replication: true }
  /** What `send` returns. Set it to -1 or 0 to backpressure. */
  result = 1
  readonly sent: { type: number; body: Uint8Array }[] = []
  closed: { code?: number; reason?: string } | null = null

  #reader = new FrameReader()

  send(data: Uint8Array | string): number {
    if (this.result !== 0) {
      for (const frame of this.#reader.push(data)) {
        this.sent.push({ type: frame.type, body: frame.body.slice() })
      }
    }
    return this.result
  }

  close(code?: number, reason?: string): void {
    this.closed = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }
    this.readyState = 3
  }

  types(): string[] {
    return this.sent.map((frame) => frameName(frame.type))
  }

  count(type: number): number {
    return this.sent.filter((frame) => frame.type === type).length
  }

  last<T>(type: number): T | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const frame = this.sent[i] as { type: number; body: Uint8Array }
      if (frame.type === type) return decodeJson<T>(type, frame.body)
    }
    return null
  }
}

/** Runs the handshake and subscribes stream 1 from `fromTxid`. */
function attach(
  server: ReplicationServer,
  socket: FakeSocket,
  tenant: Tenant,
  fromTxid = tenant.txid,
): void {
  server.open(socket)
  const hello = socket.last<HelloBody>(FRAME.HELLO)
  server.message(
    socket,
    encodeJson(FRAME.HELLO, {
      proto: PROTO_VERSION,
      node: "fake",
      proof: makeProof(SECRET, hello?.nonce as string),
    }),
  )
  server.message(
    socket,
    encodeJson(FRAME.SUBSCRIBE, {
      stream: 1,
      db: tenant.name,
      fromTxid: fromTxid.toString(),
      epoch: tenant.epoch,
      checksum: (fromTxid === tenant.txid
        ? tenant.checksum
        : (tenant.log.read(fromTxid + 1n)?.preChecksum ?? 0n)
      ).toString(),
    }),
  )
}

describe("backpressure", () => {
  test("a buffered send pauses the stream and `drain` flushes what piled up", async () => {
    const { registry, tenant } = await primaryWith(3)
    const server = new ReplicationServer({ registry, node: "p", secret: SECRET, onError: () => {} })
    const socket = new FakeSocket()
    attach(server, socket, tenant)
    expect(socket.last<{ mode: string }>(FRAME.SUBSCRIBED)?.mode).toBe("stream")

    // From here the socket buffers: `send` accepts the frame and says so with -1.
    socket.result = -1
    tenant.write((db) => db.run("insert into t (v) values ('buffered')"))
    expect(socket.count(FRAME.TXN)).toBe(1)

    // Still paused: further records queue inside the server rather than reaching the socket.
    tenant.write((db) => db.run("insert into t (v) values ('queued')"))
    tenant.write((db) => db.run("insert into t (v) values ('queued too')"))
    expect(socket.count(FRAME.TXN)).toBe(1)

    socket.result = 1
    server.drain(socket)
    expect(socket.count(FRAME.TXN)).toBe(3)
    server.stop()
  })

  test("a refused send is kept and replayed, so no record is lost", async () => {
    const { registry, tenant } = await primaryWith(2)
    const server = new ReplicationServer({ registry, node: "p", secret: SECRET, onError: () => {} })
    const socket = new FakeSocket()
    attach(server, socket, tenant)

    // 0 means the socket dropped the frame entirely; it has to come back on drain.
    socket.result = 0
    tenant.write((db) => db.run("insert into t (v) values ('refused')"))
    expect(socket.count(FRAME.TXN)).toBe(0)

    socket.result = 1
    server.drain(socket)
    expect(socket.count(FRAME.TXN)).toBe(1)
    server.stop()
  })

  test("a socket that stays backpressured past slowReplicaMs is closed with BUSY", async () => {
    const { registry, tenant } = await primaryWith(1)
    const server = new ReplicationServer({
      registry,
      node: "p",
      secret: SECRET,
      heartbeatMs: 10,
      slowReplicaMs: 20,
      onError: () => {},
    })
    const socket = new FakeSocket()
    attach(server, socket, tenant)

    socket.result = -1
    tenant.write((db) => db.run("insert into t (v) values ('stuck')"))

    const deadline = Date.now() + 4000
    while (socket.closed === null) {
      if (Date.now() > deadline) throw new Error("the slow socket was never closed")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // The ERROR frame is written while the socket still accepts frames, so it is on the wire.
    socket.result = 1
    expect(socket.closed?.reason).toBe("BUSY")
    expect(server.replicasOf("acme")).toEqual([])
    server.stop()
  })

  test("catch-up and live records arrive once each, in ascending order", async () => {
    const { registry, tenant } = await primaryWith(5)
    const server = new ReplicationServer({ registry, node: "p", secret: SECRET, onError: () => {} })
    const socket = new FakeSocket()
    // Subscribe from txid 2, so records 3..6 come out of the log and the rest live.
    attach(server, socket, tenant, 2n)
    tenant.write((db) => db.run("insert into t (v) values ('live')"))

    const { decodeTxn } = await import("../../src/replication/protocol.ts")
    const { decodeHeader } = await import("../../src/wal/record.ts")
    const txids = socket.sent
      .filter((frame) => frame.type === FRAME.TXN)
      .map((frame) => decodeHeader(decodeTxn(frame.body).record)?.header.txid as bigint)
    expect(txids).toEqual([3n, 4n, 5n, 6n, 7n])
    expect(new Set(txids).size).toBe(txids.length)
    server.stop()
  })

  test("an unknown database is refused UNKNOWN_DB without closing the socket", async () => {
    const { registry, tenant } = await primaryWith(1)
    const server = new ReplicationServer({ registry, node: "p", secret: SECRET, onError: () => {} })
    const socket = new FakeSocket()
    server.open(socket)
    const hello = socket.last<HelloBody>(FRAME.HELLO)
    server.message(
      socket,
      encodeJson(FRAME.HELLO, {
        proto: PROTO_VERSION,
        node: "fake",
        proof: makeProof(SECRET, hello?.nonce as string),
      }),
    )
    server.message(
      socket,
      encodeJson(FRAME.SUBSCRIBE, {
        stream: 9,
        db: "nope",
        fromTxid: "0",
        epoch: 0,
        checksum: "0",
      }),
    )
    expect(socket.last<ErrorBody>(FRAME.ERROR)?.code).toBe("UNKNOWN_DB")
    expect(socket.closed).toBeNull()

    // The same socket can still subscribe to a database that does exist.
    server.message(
      socket,
      encodeJson(FRAME.SUBSCRIBE, {
        stream: 1,
        db: tenant.name,
        fromTxid: tenant.txid.toString(),
        epoch: tenant.epoch,
        checksum: tenant.checksum.toString(),
      }),
    )
    expect(socket.last<{ mode: string }>(FRAME.SUBSCRIBED)?.mode).toBe("stream")
    server.stop()
  })

  test("a frame before the handshake is AUTH_FAILED and closes the socket", async () => {
    const { registry } = await primaryWith(0)
    const server = new ReplicationServer({ registry, node: "p", secret: SECRET, onError: () => {} })
    const socket = new FakeSocket()
    server.open(socket)
    server.message(
      socket,
      encodeJson(FRAME.SUBSCRIBE, {
        stream: 1,
        db: "acme",
        fromTxid: "0",
        epoch: 0,
        checksum: "0",
      }),
    )
    expect(socket.last<ErrorBody>(FRAME.ERROR)?.code).toBe("AUTH_FAILED")
    expect(socket.closed?.code).toBe(1008)
    server.stop()
  })

  test("a malformed frame closes the socket with PROTO", async () => {
    const { registry } = await primaryWith(0)
    const server = new ReplicationServer({ registry, node: "p", secret: SECRET, onError: () => {} })
    const socket = new FakeSocket()
    server.open(socket)
    // A 32 MiB declared body is over the cap and cannot be anything but a framing error.
    const header = new Uint8Array(5)
    header[0] = FRAME.TXN
    new DataView(header.buffer).setUint32(1, 32 * 1024 * 1024, false)
    server.message(socket, header)
    expect(socket.last<ErrorBody>(FRAME.ERROR)?.code).toBe("PROTO")
    expect(socket.closed?.code).toBe(1002)
    server.stop()
  })

  test("ACK frames land on `replicasOf` and reach the R2 seam", async () => {
    const { registry, tenant } = await primaryWith(2)
    const server = new ReplicationServer({ registry, node: "p", secret: SECRET, onError: () => {} })
    const socket = new FakeSocket()
    attach(server, socket, tenant)
    const seen: { db: string; txid: bigint; fsynced: boolean }[] = []
    server.onAck((event) => seen.push({ db: event.db, txid: event.txid, fsynced: event.fsynced }))

    tenant.write((db) => db.run("insert into t (v) values ('acked')"))
    const { encodeAck, ACK_FSYNCED } = await import("../../src/replication/protocol.ts")
    server.message(socket, encodeAck(1, tenant.txid, ACK_FSYNCED))

    expect(seen).toEqual([{ db: "acme", txid: tenant.txid, fsynced: true }])
    const replicas = server.replicasOf("acme")
    expect(replicas).toHaveLength(1)
    expect(replicas[0]?.node).toBe("fake")
    expect(replicas[0]?.txid).toBe(Number(tenant.txid))
    expect(replicas[0]?.lag).toBe(0)
    expect(server.maxLagTxid).toBe(0)
    server.stop()
  })
})
