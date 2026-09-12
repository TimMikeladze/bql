// Hosted mode (C4b): a `ReplicationServer` whose connections are adopted from a router on another
// thread. `docs/c4b-replication-workers.md` §4.
//
// The property under test is that the seam was cut in the right place — a hosted server given a
// pre-authenticated connection and pre-decoded frames produces *exactly* the frames the ordinary
// one produces after its own handshake. Everything below the connection runs unchanged, so if that
// holds, `workers > 1` serves a replica the same bytes `workers = 1` does.

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
  type HelloBody,
} from "../../src/replication/protocol.ts"
import { ReplicationServer, type ReplicationSocket } from "../../src/replication/primary.ts"
import { TenantRegistry, type Tenant } from "../../src/tenant/index.ts"

const SECRET = "hosted-secret"
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-hosted-"))
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

/** A socket that keeps every frame it was handed, decoded. */
class FakeSocket implements ReplicationSocket {
  readyState = 1
  data: unknown = { replication: true }
  readonly sent: { type: number; body: Uint8Array }[] = []
  closed: { code?: number; reason?: string } | null = null

  #reader = new FrameReader()

  send(data: Uint8Array | string): number {
    for (const frame of this.#reader.push(data)) {
      this.sent.push({ type: frame.type, body: frame.body.slice() })
    }
    return 1
  }

  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    }
    this.readyState = 3
  }

  types(): string[] {
    return this.sent.map((frame) => frameName(frame.type))
  }
}

function subscribeBody(tenant: Tenant, fromTxid: bigint): unknown {
  return {
    stream: 1,
    db: tenant.name,
    fromTxid: fromTxid.toString(),
    epoch: tenant.epoch,
    checksum: (fromTxid === tenant.txid
      ? tenant.checksum
      : (tenant.log.read(fromTxid + 1n)?.preChecksum ?? 0n)
    ).toString(),
  }
}

const encoder = new TextEncoder()

describe("hosted mode", () => {
  test("adopt + deliver produce the same frames as open + message", async () => {
    const { registry, tenant } = await primaryWith(3)

    // The ordinary server: its own handshake over a real frame stream.
    const plain = new ReplicationServer({ registry, node: "p", secret: SECRET, onError: () => {} })
    const a = new FakeSocket()
    plain.open(a)
    const hello = decodeJson<HelloBody>(FRAME.HELLO, (a.sent[0] as { body: Uint8Array }).body)
    plain.message(
      a,
      encodeJson(FRAME.HELLO, {
        proto: PROTO_VERSION,
        node: "fake",
        proof: makeProof(SECRET, hello.nonce as string),
      }),
    )
    plain.message(a, encodeJson(FRAME.SUBSCRIBE, subscribeBody(tenant, 1n)))

    // The hosted one: no handshake, no nonce, and the body pre-decoded by the router.
    const hosted = new ReplicationServer({
      registry,
      node: "p",
      secret: SECRET,
      hosted: true,
      onError: () => {},
    })
    const b = new FakeSocket()
    hosted.adopt(b, "fake")
    hosted.deliver(
      b,
      FRAME.SUBSCRIBE,
      encoder.encode(JSON.stringify(subscribeBody(tenant, 1n))),
    )

    // The ordinary server sends two `HELLO`s first — the challenge and the answer — which is the
    // whole of what the router does instead. Everything after them is identical.
    expect(a.types().slice(0, 2)).toEqual(["HELLO", "HELLO"])
    expect(a.types().slice(2)).toEqual(b.types())
    expect(a.sent.slice(2).map((f) => f.body)).toEqual(b.sent.map((f) => f.body))
    expect(b.types()).toEqual(["SUBSCRIBED", "TXN", "TXN", "TXN"])

    plain.stop()
    hosted.stop()
  })

  test("a live commit reaches a hosted stream, and unsubscribing unpins", async () => {
    const { registry, tenant } = await primaryWith(1)
    const hosted = new ReplicationServer({
      registry,
      node: "p",
      secret: SECRET,
      hosted: true,
      onError: () => {},
    })
    const socket = new FakeSocket()
    hosted.adopt(socket, "fake")
    hosted.deliver(
      socket,
      FRAME.SUBSCRIBE,
      encoder.encode(JSON.stringify(subscribeBody(tenant, tenant.txid))),
    )
    expect(hosted.streamCount).toBe(1)
    const before = socket.sent.length

    tenant.write((db) => db.run("insert into t (v) values ('live')"))
    expect(socket.types().slice(before)).toEqual(["TXN"])

    hosted.deliver(socket, FRAME.UNSUBSCRIBE, encoder.encode(JSON.stringify({ stream: 1 })))
    expect(hosted.streamCount).toBe(0)
    hosted.stop()
  })

  test("it runs no heartbeat timer and asks the router to announce instead", async () => {
    const { registry, tenant } = await primaryWith(0)
    const hosted = new ReplicationServer({
      registry,
      node: "p",
      secret: SECRET,
      hosted: true,
      heartbeatMs: 1,
      onError: () => {},
    })
    let announces = 0
    hosted.setAnnounceHandler(() => {
      announces += 1
    })
    const socket = new FakeSocket()
    hosted.adopt(socket, "fake")
    hosted.deliver(
      socket,
      FRAME.SUBSCRIBE,
      encoder.encode(JSON.stringify(subscribeBody(tenant, tenant.txid))),
    )
    const after = socket.sent.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Thirty heartbeat intervals and not one frame: N workers ticking down one socket would send
    // N announcements per interval, which is why the router owns the tick.
    expect(socket.sent.length).toBe(after)

    hosted.announce()
    expect(announces).toBe(1)
    hosted.stop()
  })

  test("positions report every stream, which is what the router's HEARTBEAT carries", async () => {
    const { registry, tenant } = await primaryWith(2)
    const hosted = new ReplicationServer({
      registry,
      node: "p",
      secret: SECRET,
      hosted: true,
      onError: () => {},
    })
    const socket = new FakeSocket()
    hosted.adopt(socket, "fake")
    hosted.deliver(
      socket,
      FRAME.SUBSCRIBE,
      encoder.encode(JSON.stringify(subscribeBody(tenant, tenant.txid))),
    )
    const positions = hosted.positions()
    expect(positions.length).toBe(1)
    expect(positions[0]?.stream).toBe(1)
    expect(positions[0]?.txid).toBe(tenant.txid)
    expect(positions[0]?.ws).toBe(socket)
    hosted.stop()
  })

  test("a frame before the router adopted the connection is ignored, not thrown", async () => {
    const { registry, tenant } = await primaryWith(0)
    const hosted = new ReplicationServer({
      registry,
      node: "p",
      secret: SECRET,
      hosted: true,
      onError: () => {},
    })
    const stranger = new FakeSocket()
    hosted.deliver(
      stranger,
      FRAME.SUBSCRIBE,
      encoder.encode(JSON.stringify(subscribeBody(tenant, 0n))),
    )
    expect(stranger.sent.length).toBe(0)
    expect(hosted.streamCount).toBe(0)
    hosted.stop()
  })
})
