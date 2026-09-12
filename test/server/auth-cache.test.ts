// The rule the signature cache lives or dies by: **a hit must be as authoritative as a miss.**
// Caching the signature is safe because a signature is a pure function of the token and the ring;
// everything that can change between two requests carrying one token is re-evaluated every time.

import { describe, expect, test } from "bun:test"
import {
  AuthKeys,
  Authenticator,
  KeyRing,
  MemoryRevocationList,
  mintToken,
  SignatureCache,
  verifyToken,
} from "../../src/server/auth.ts"

async function ring(): Promise<{ keys: AuthKeys; ring: KeyRing }> {
  const keys = await AuthKeys.generate()
  return { keys, ring: new KeyRing([keys]) }
}

describe("signature cache", () => {
  test("a second verification of the same token skips the signature and nothing else", async () => {
    const { keys, ring: r } = await ring()
    const cache = new SignatureCache()
    const token = await mintToken(keys, { rw: ["acme"], ttlMs: 60_000 })

    const first = await verifyToken(r, token, { cache })
    expect(cache.size).toBe(1)
    const second = await verifyToken(r, token, { cache })
    expect(second.jti).toBe(first.jti)
    expect(second).toEqual(first)
  })

  test("a cached token that has since expired is refused, and evicted", async () => {
    const { keys, ring: r } = await ring()
    const cache = new SignatureCache()
    const token = await mintToken(keys, { rw: ["acme"], ttlMs: 10_000 })

    const now = Date.now()
    await verifyToken(r, token, { cache, now })
    expect(cache.size).toBe(1)

    // Past its `exp`, plus the default 30 s of clock slack.
    const later = now + 10_000 + 31_000
    await expect(verifyToken(r, token, { cache, now: later })).rejects.toThrow(/expired/)
    expect(cache.size).toBe(0)
  })

  test("a revocation defeats the cache on the very next request", async () => {
    const { keys, ring: r } = await ring()
    const cache = new SignatureCache()
    const revocations = new MemoryRevocationList()
    const token = await mintToken(keys, { rw: ["acme"], ttlMs: 60_000 })

    const claims = await verifyToken(r, token, { cache, revocations })
    revocations.revoke(claims.jti)

    await expect(verifyToken(r, token, { cache, revocations })).rejects.toThrow(/revoked/)
    expect(cache.size).toBe(0)
  })

  test("rotating the ring invalidates every signature it had vouched for", async () => {
    const { keys, ring: r } = await ring()
    const cache = new SignatureCache()
    const token = await mintToken(keys, { rw: ["acme"], ttlMs: 60_000 })
    await verifyToken(r, token, { cache })
    expect(cache.size).toBe(1)

    const other = await AuthKeys.generate()
    r.add(other) // the ring changed; the entry that named the old version is stale
    expect(cache.get(token, r.version)).toBeUndefined()
    // And it still verifies, because the original key is still on the ring.
    expect((await verifyToken(r, token, { cache })).jti).toBeDefined()
  })

  test("a forged token is refused and never cached", async () => {
    const { keys, ring: r } = await ring()
    const cache = new SignatureCache()
    const token = await mintToken(keys, { rw: ["acme"], ttlMs: 60_000 })
    const [header, claims] = token.split(".")
    const forged = `${header}.${claims}.${"A".repeat(86)}`

    await expect(verifyToken(r, forged, { cache })).rejects.toThrow()
    expect(cache.size).toBe(0)
  })

  test("the cache is bounded, oldest first", async () => {
    const { keys, ring: r } = await ring()
    const cache = new SignatureCache(2)
    const tokens = [
      await mintToken(keys, { rw: ["a"], ttlMs: 60_000 }),
      await mintToken(keys, { rw: ["b"], ttlMs: 60_000 }),
      await mintToken(keys, { rw: ["c"], ttlMs: 60_000 }),
    ]
    for (const token of tokens) await verifyToken(r, token, { cache })
    expect(cache.size).toBe(2)
    expect(cache.get(tokens[0] as string, r.version)).toBeUndefined()
    expect(cache.get(tokens[2] as string, r.version)).toBeDefined()
  })

  test("size 0 turns it off, and verification still works", async () => {
    const { keys, ring: r } = await ring()
    const cache = new SignatureCache(0)
    const token = await mintToken(keys, { rw: ["acme"], ttlMs: 60_000 })
    await verifyToken(r, token, { cache })
    expect(cache.size).toBe(0)
    expect((await verifyToken(r, token, { cache })).jti).toBeDefined()
  })

  test("the authenticator builds one from its config, and 0 disables it", async () => {
    const { keys } = await ring()
    const on = new Authenticator({ keys })
    expect(on.signatures?.max).toBe(1024)
    const token = await mintToken(keys, { rw: ["acme"], ttlMs: 60_000 })
    await on.authenticateToken(token)
    expect(on.signatures?.size).toBe(1)

    const off = new Authenticator({ keys, verifyCacheSize: 0 })
    expect(off.signatures).toBeNull()
    expect((await off.authenticateToken(token)).kind).toBe("token")
  })

  test("the admin key never reaches the cache", async () => {
    const { keys } = await ring()
    const auth = new Authenticator({ keys, adminKey: "sekret" })
    expect((await auth.authenticateToken("sekret")).kind).toBe("admin")
    expect(auth.signatures?.size).toBe(0)
  })
})
