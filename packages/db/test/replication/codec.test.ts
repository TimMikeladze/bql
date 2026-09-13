// The frame codec on its own: no sockets, no tenants, no server. Everything the wire format
// promises is checkable here — framing across arbitrary message boundaries, the binary bodies, the
// size cap, and the constant-time handshake proof.

import { describe, expect, test } from "bun:test"
import {
  ACK_FSYNCED,
  decodeAck,
  decodeJson,
  decodeSnapshotChunk,
  decodeTxn,
  encodeAck,
  encodeFrame,
  encodeJson,
  encodeSnapshotChunk,
  encodeTxn,
  FRAME,
  FRAME_HEADER_SIZE,
  FrameReader,
  frameName,
  makeNonce,
  makeProof,
  MAX_BODY_BYTES,
  ProtocolError,
  PROTO_VERSION,
  type HelloBody,
  type SubscribeBody,
  verifyProof,
} from "../../src/replication/protocol.ts"

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe("frames", () => {
  test("a frame is type, big-endian length, body", () => {
    const frame = encodeFrame(FRAME.TXN, bytes(1, 2, 3))
    expect(frame.byteLength).toBe(FRAME_HEADER_SIZE + 3)
    expect(frame[0]).toBe(FRAME.TXN)
    expect(new DataView(frame.buffer).getUint32(1, false)).toBe(3)
    expect([...frame.subarray(5)]).toEqual([1, 2, 3])
  })

  test("an empty body is a legal frame", () => {
    const [frame] = new FrameReader().push(encodeFrame(FRAME.HEARTBEAT, new Uint8Array(0)))
    expect(frame?.type).toBe(FRAME.HEARTBEAT)
    expect(frame?.body.byteLength).toBe(0)
  })

  test("several frames in one message all come out, in order", () => {
    const reader = new FrameReader()
    const message = new Uint8Array([
      ...encodeJson(FRAME.HELLO, { proto: 1, node: "a" }),
      ...encodeAck(7, 42n, ACK_FSYNCED),
      ...encodeFrame(FRAME.UNSUBSCRIBE, new Uint8Array(0)),
    ])
    const frames = reader.push(message)
    expect(frames.map((f) => f.type)).toEqual([FRAME.HELLO, FRAME.ACK, FRAME.UNSUBSCRIBE])
    expect(reader.buffered).toBe(0)
  })

  test("a frame split across every possible boundary reassembles", () => {
    const whole = encodeTxn(3, new Uint8Array(200).fill(7))
    for (let cut = 1; cut < whole.byteLength; cut++) {
      const reader = new FrameReader()
      expect(reader.push(whole.subarray(0, cut))).toEqual([])
      const frames = reader.push(whole.subarray(cut))
      expect(frames.length).toBe(1)
      const decoded = decodeTxn((frames[0] as { body: Uint8Array }).body)
      expect(decoded.stream).toBe(3)
      expect(decoded.record.byteLength).toBe(200)
      expect(reader.buffered).toBe(0)
    }
  })

  test("a byte-at-a-time feed yields the frame exactly once, at the last byte", () => {
    const whole = encodeJson(FRAME.SUBSCRIBE, {
      stream: 1,
      db: "acme",
      fromTxid: "0",
      epoch: 0,
      checksum: "0",
    } satisfies SubscribeBody)
    const reader = new FrameReader()
    let seen = 0
    for (let i = 0; i < whole.byteLength; i++) {
      seen += reader.push(whole.subarray(i, i + 1)).length
      if (i < whole.byteLength - 1) expect(seen).toBe(0)
    }
    expect(seen).toBe(1)
  })

  test("a truncated frame is held, not yielded", () => {
    const reader = new FrameReader()
    const whole = encodeTxn(1, new Uint8Array(64))
    expect(reader.push(whole.subarray(0, whole.byteLength - 1))).toEqual([])
    expect(reader.buffered).toBe(whole.byteLength - 1)
  })

  test("a header alone is held until its body arrives", () => {
    const reader = new FrameReader()
    expect(reader.push(encodeFrame(FRAME.TXN, new Uint8Array(10)).subarray(0, 5))).toEqual([])
    expect(reader.buffered).toBe(5)
  })

  test("a declared length past the cap is refused before any body is read", () => {
    const reader = new FrameReader()
    const header = new Uint8Array(FRAME_HEADER_SIZE)
    header[0] = FRAME.TXN
    new DataView(header.buffer).setUint32(1, MAX_BODY_BYTES + 1, false)
    expect(() => reader.push(header)).toThrow(ProtocolError)
  })

  test("encoding a body past the cap is refused too", () => {
    expect(() => encodeFrame(FRAME.TXN, new Uint8Array(MAX_BODY_BYTES + 1))).toThrow(ProtocolError)
  })

  test("a reader with a lower cap refuses a frame a default reader would accept", () => {
    const reader = new FrameReader({ maxBodyBytes: 16 })
    expect(() => reader.push(encodeFrame(FRAME.TXN, new Uint8Array(17)))).toThrow(/over the 16/)
  })

  test("JSON bodies round-trip and a broken one is a protocol error", () => {
    const hello: HelloBody = { proto: PROTO_VERSION, node: "n1", nonce: makeNonce() }
    const [frame] = new FrameReader().push(encodeJson(FRAME.HELLO, hello))
    expect(decodeJson<HelloBody>(FRAME.HELLO, (frame as { body: Uint8Array }).body)).toEqual(hello)
    expect(() => decodeJson(FRAME.HELLO, new TextEncoder().encode("{"))).toThrow(ProtocolError)
  })

  test("frame names are readable, including unknown ones", () => {
    expect(frameName(FRAME.SNAPSHOT_CHUNK)).toBe("SNAPSHOT_CHUNK")
    expect(frameName(0x7f)).toBe("0x7f")
  })
})

describe("binary bodies", () => {
  test("TXN carries the stream id and the record untouched", () => {
    const record = new Uint8Array([9, 8, 7, 6, 5])
    const [frame] = new FrameReader().push(encodeTxn(0xdeadbeef, record))
    const decoded = decodeTxn((frame as { body: Uint8Array }).body)
    expect(decoded.stream).toBe(0xdeadbeef)
    expect([...decoded.record]).toEqual([...record])
  })

  test("ACK round-trips a full u64 txid and the fsync flag", () => {
    const txid = 0xfedc_ba98_7654_3210n
    const [frame] = new FrameReader().push(encodeAck(5, txid, ACK_FSYNCED))
    const ack = decodeAck((frame as { body: Uint8Array }).body)
    expect(ack).toEqual({ stream: 5, txid, flags: ACK_FSYNCED, fsynced: true })
  })

  test("ACK without the flag reports fsynced false", () => {
    const [frame] = new FrameReader().push(encodeAck(1, 3n, 0))
    expect(decodeAck((frame as { body: Uint8Array }).body).fsynced).toBe(false)
  })

  test("a short ACK body is a protocol error", () => {
    expect(() => decodeAck(new Uint8Array(12))).toThrow(/expected 13/)
    expect(() => decodeTxn(new Uint8Array(3))).toThrow(ProtocolError)
    expect(() => decodeSnapshotChunk(new Uint8Array(7))).toThrow(ProtocolError)
  })

  test("SNAPSHOT_CHUNK carries stream, sequence and the compressed bytes", () => {
    const plain = new Uint8Array(4096).fill(0x5a)
    const compressed = new Uint8Array(Bun.zstdCompressSync(plain, { level: 3 }))
    const [frame] = new FrameReader().push(encodeSnapshotChunk(2, 11, compressed))
    const chunk = decodeSnapshotChunk((frame as { body: Uint8Array }).body)
    expect(chunk.stream).toBe(2)
    expect(chunk.seq).toBe(11)
    expect([...new Uint8Array(Bun.zstdDecompressSync(chunk.compressed))]).toEqual([...plain])
  })
})

describe("handshake proof", () => {
  test("the right secret over the right nonce verifies", () => {
    const nonce = makeNonce()
    expect(verifyProof("s3cret", nonce, makeProof("s3cret", nonce))).toBe(true)
  })

  test("a wrong secret, a wrong nonce and a missing proof all fail", () => {
    const nonce = makeNonce()
    expect(verifyProof("s3cret", nonce, makeProof("other", nonce))).toBe(false)
    expect(verifyProof("s3cret", nonce, makeProof("s3cret", makeNonce()))).toBe(false)
    expect(verifyProof("s3cret", nonce, undefined)).toBe(false)
    expect(verifyProof("s3cret", nonce, "")).toBe(false)
  })

  test("a proof of the wrong length fails rather than throwing", () => {
    const nonce = makeNonce()
    expect(verifyProof("s3cret", nonce, "AAAA")).toBe(false)
    expect(verifyProof("s3cret", nonce, "not base64 at all!!!")).toBe(false)
  })

  test("a nonce is 32 bytes and never repeats", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const nonce = makeNonce()
      expect(Buffer.from(nonce, "base64").byteLength).toBe(32)
      seen.add(nonce)
    }
    expect(seen.size).toBe(100)
  })
})
