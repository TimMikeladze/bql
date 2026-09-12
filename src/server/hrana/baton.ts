// Invariant: a baton is proof that this process handed it out, and proof of nothing else. It
// names a stream and a position in that stream's response sequence; it is signed, it expires, and
// it is refused the moment either the signature, the expiry or the sequence is off. A client that
// replays an old baton is told the stream moved on rather than being quietly reattached to it.
//
// The signature is HMAC-SHA256 under 32 random bytes generated per process, not the node's Ed25519
// token key. Batons rotate on *every* response, so signing is on the hot path, and
// `Bun.CryptoHasher` is synchronous while `crypto.subtle.sign` is a promise and an allocation. A
// key that dies with the process is also the honest lifetime: the stream a baton names lives in
// this process's memory, so a baton that outlived a restart could only ever be refused.

import { constantTimeEqual } from "../auth.ts"
import { BunQLError } from "../errors.ts"

export interface BatonClaim {
  streamId: number
  seq: number
}

const encoder = new TextEncoder()

export class BatonSigner {
  readonly #key: Uint8Array
  readonly #ttlMs: number

  constructor(ttlMs: number, key?: Uint8Array) {
    this.#ttlMs = ttlMs
    this.#key = key ?? crypto.getRandomValues(new Uint8Array(32))
  }

  /** `<streamId>.<seq>.<expiresAtMs>.<mac>`; every part is URL-safe as written. */
  sign(streamId: number, seq: number, now = Date.now()): string {
    const payload = `${streamId}.${seq}.${now + this.#ttlMs}`
    return `${payload}.${this.#mac(payload)}`
  }

  /**
   * The claim inside a baton, or a 400. The signature is checked before anything is parsed out of
   * the payload, so a forged baton never reaches the stream registry at all.
   */
  verify(baton: string, now = Date.now()): BatonClaim {
    const cut = baton.lastIndexOf(".")
    if (cut <= 0) throw forged()
    const payload = baton.slice(0, cut)
    const mac = baton.slice(cut + 1)
    if (!constantTimeEqual(encoder.encode(mac), encoder.encode(this.#mac(payload)))) throw forged()
    const parts = payload.split(".")
    if (parts.length !== 3) throw forged()
    const streamId = Number(parts[0])
    const seq = Number(parts[1])
    const expiresAt = Number(parts[2])
    if (!Number.isInteger(streamId) || !Number.isInteger(seq) || !Number.isFinite(expiresAt)) {
      throw forged()
    }
    if (expiresAt <= now) {
      throw new BunQLError("BAD_REQUEST", "the baton has expired; open a new stream", 400)
    }
    return { streamId, seq }
  }

  #mac(payload: string): string {
    return new Bun.CryptoHasher("sha256", this.#key).update(payload).digest("base64url")
  }
}

function forged(): BunQLError {
  return new BunQLError("BAD_REQUEST", "the baton is not one this server issued", 400)
}
