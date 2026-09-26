// Minting and checking tokens: every way a token can be wrong has to be a 401, and a token that
// is right has to grant exactly the databases its globs name and nothing else.

import { describe, expect, test } from "bun:test"
import {
  ADMIN,
  AuthKeys,
  Authenticator,
  claimsFor,
  constantTimeEqual,
  globMatch,
  KeyRing,
  MemoryRevocationList,
  mintToken,
  requireScope,
  tokenFromRequest,
  tokenPrincipal,
  verifyToken,
  type TokenPrincipal,
} from "../../src/server/auth.ts"
import { BqlError } from "../../src/server/errors.ts"
import { fromBase64, toBase64Url } from "../../src/server/json.ts"

const keys = await AuthKeys.generate()
const other = await AuthKeys.generate()
const ring = new KeyRing([keys])

function principalOf(claims: Awaited<ReturnType<typeof verifyToken>>): TokenPrincipal {
  return tokenPrincipal(claims)
}

describe("keys", () => {
  test("a generated key can sign and its kid is derived from the public half", async () => {
    expect(keys.canSign).toBe(true)
    expect(keys.kid).toHaveLength(16)
    expect(keys.kid).not.toBe(other.kid)
    const reloaded = await AuthKeys.fromRawPublic(keys.exportRawPublic())
    expect(reloaded.kid).toBe(keys.kid)
    expect(reloaded.canSign).toBe(false)
  })

  test("survives a PKCS#8 round trip", async () => {
    const reloaded = await AuthKeys.fromPkcs8(await keys.exportPkcs8())
    expect(reloaded.kid).toBe(keys.kid)
    expect(reloaded.canSign).toBe(true)
    const token = await mintToken(reloaded, { ro: ["acme"] })
    await expect(verifyToken(ring, token)).resolves.toBeDefined()
  })

  test("survives a JWK round trip, private and public", async () => {
    const priv = await AuthKeys.fromJwk(await keys.exportJwk("private"))
    expect(priv.kid).toBe(keys.kid)
    expect(priv.canSign).toBe(true)
    const pub = await AuthKeys.fromJwk(await keys.exportJwk("public"))
    expect(pub.kid).toBe(keys.kid)
    expect(pub.canSign).toBe(false)
    await expect(pub.exportPkcs8()).rejects.toThrow(BqlError)
  })

  test("rejects key material that is not Ed25519", async () => {
    await expect(AuthKeys.fromRawPublic(new Uint8Array(31))).rejects.toThrow(BqlError)
    await expect(AuthKeys.fromJwk({ kty: "EC", crv: "P-256" })).rejects.toThrow(BqlError)
  })

  test("a ring picks the signing key and can be rotated", async () => {
    const two = new KeyRing([keys, other])
    expect(two.size).toBe(2)
    expect(two.signing.kid).toBe(keys.kid)
    two.setSigning(other.kid)
    expect(two.signing.kid).toBe(other.kid)
    expect(() => two.setSigning("nope")).toThrow(BqlError)
    expect(two.get(keys.kid)?.kid).toBe(keys.kid)
  })
})

describe("mint and verify", () => {
  test("a freshly minted token checks out and keeps its claims", async () => {
    const token = await mintToken(keys, {
      rw: ["acme", "acme-*"],
      ro: ["shared"],
      tables: { todos: "r" },
      ttlMs: 60_000,
      sub: "ann",
    })
    const header = JSON.parse(atob(token.split(".")[0] as string))
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: keys.kid })

    const claims = await verifyToken(ring, token)
    expect(claims.p).toEqual({ ro: { ns: ["shared"] }, rw: { ns: ["acme", "acme-*"] } })
    expect(claims.t).toEqual({ todos: "r" })
    expect(claims.sub).toBe("ann")
    expect(claims.kid).toBe(keys.kid)
    expect(claims.jti).toBeString()
    expect(claims.exp).toBe((claims.iat as number) + 60)
  })

  test("a tampered payload fails", async () => {
    const token = await mintToken(keys, { ro: ["acme"] })
    const [head, body, signature] = token.split(".") as [string, string, string]
    const claims = JSON.parse(new TextDecoder().decode(fromBase64(body)))
    claims.p = { rw: { ns: ["*"] } }
    const forged = `${head}.${toBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}.${signature}`
    await expect(verifyToken(ring, forged)).rejects.toThrow("signature does not check out")
  })

  test("a tampered signature fails", async () => {
    const token = await mintToken(keys, { ro: ["acme"] })
    const [head, body, signature] = token.split(".") as [string, string, string]
    const bytes = fromBase64(signature)
    bytes[0] = (bytes[0] as number) ^ 0x01
    await expect(verifyToken(ring, `${head}.${body}.${toBase64Url(bytes)}`)).rejects.toThrow(
      "signature does not check out",
    )
    await expect(verifyToken(ring, `${head}.${body}.not-base64!`)).rejects.toThrow(BqlError)
    await expect(verifyToken(ring, `${head}.${body}.`)).rejects.toThrow(BqlError)
  })

  test("an expired token fails once it is past the clock tolerance", async () => {
    const minted = Date.now()
    const token = await mintToken(keys, { ro: ["acme"], ttlMs: 1000, now: minted })
    await expect(verifyToken(ring, token, { now: minted + 500 })).resolves.toBeDefined()
    // Still inside the 30 s default tolerance.
    await expect(verifyToken(ring, token, { now: minted + 20_000 })).resolves.toBeDefined()
    await expect(verifyToken(ring, token, { now: minted + 60_000 })).rejects.toThrow("expired")
    await expect(
      verifyToken(ring, token, { now: minted + 2000, clockToleranceSec: 0 }),
    ).rejects.toThrow("expired")
  })

  test("a token signed by a key this node does not have fails", async () => {
    const token = await mintToken(other, { rw: ["acme"] })
    await expect(verifyToken(ring, token)).rejects.toThrow("unknown key")
    await expect(verifyToken(new KeyRing([keys, other]), token)).resolves.toBeDefined()
  })

  test("a token whose kid does not match its signature fails", async () => {
    const token = await mintToken(other, { rw: ["acme"] })
    const [, body, signature] = token.split(".") as [string, string, string]
    const header = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: keys.kid })),
    )
    await expect(verifyToken(ring, `${header}.${body}.${signature}`)).rejects.toThrow(
      "signature does not check out",
    )
  })

  test("alg none and other algorithms are refused outright", async () => {
    const claims = toBase64Url(
      new TextEncoder().encode(JSON.stringify(claimsFor({ rw: ["acme"] }))),
    )
    for (const alg of ["none", "HS256", "RS256"]) {
      const header = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg, kid: keys.kid })))
      await expect(verifyToken(ring, `${header}.${claims}.`)).rejects.toThrow("algorithm")
    }
  })

  test("garbage is refused before any crypto happens", async () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "!!!.???.***"]) {
      await expect(verifyToken(ring, bad)).rejects.toThrow(BqlError)
    }
  })

  test("a revoked jti fails even though the signature is good", async () => {
    const revocations = new MemoryRevocationList()
    const token = await mintToken(keys, { ro: ["acme"], jti: "tok-1" })
    await expect(verifyToken(ring, token, { revocations })).resolves.toBeDefined()
    revocations.revoke("tok-1")
    await expect(verifyToken(ring, token, { revocations })).rejects.toThrow("revoked")
    revocations.restore("tok-1")
    await expect(verifyToken(ring, token, { revocations })).resolves.toBeDefined()
  })

  test("revocations can be purged once the tokens would have expired anyway", () => {
    const revocations = new MemoryRevocationList()
    revocations.revoke("old", 100)
    revocations.revoke("forever")
    revocations.purge(200)
    expect(revocations.isRevoked("old")).toBe(false)
    expect(revocations.isRevoked("forever")).toBe(true)
  })
})

describe("scopes", () => {
  test("globs match the way a namespace list should", () => {
    expect(globMatch("acme", "acme")).toBe(true)
    expect(globMatch("acme", "acme-eu")).toBe(false)
    expect(globMatch("acme-*", "acme-eu")).toBe(true)
    expect(globMatch("acme-*", "acme-")).toBe(true)
    expect(globMatch("acme-*", "acme")).toBe(false)
    expect(globMatch("*", "anything")).toBe(true)
    expect(globMatch("*-eu", "acme-eu")).toBe(true)
    expect(globMatch("a*b*c", "axxbyyc")).toBe(true)
    expect(globMatch("a*b*c", "axxbyy")).toBe(false)
    expect(globMatch("acme-?", "acme-1")).toBe(true)
    expect(globMatch("acme-?", "acme-12")).toBe(false)
    expect(globMatch("acme", "ACME")).toBe(false)
  })

  test("read-write wins over read-only when both match", async () => {
    const token = await mintToken(keys, { ro: ["acme-*", "shared"], rw: ["acme-eu"] })
    const principal = principalOf(await verifyToken(ring, token))
    expect(principal.scopeFor("acme-eu")).toBe("rw")
    expect(principal.scopeFor("acme-us")).toBe("ro")
    expect(principal.scopeFor("shared")).toBe("ro")
    expect(principal.scopeFor("other")).toBe(null)
  })

  test("a token with no permissions reaches nothing", () => {
    const principal = tokenPrincipal(claimsFor({}))
    expect(principal.scopeFor("acme")).toBe(null)
    expect(principal.tables).toBeUndefined()
  })

  test("requireScope is the routes' gate", () => {
    const rw = tokenPrincipal(claimsFor({ rw: ["acme"] }))
    const ro = tokenPrincipal(claimsFor({ ro: ["acme"] }))
    expect(requireScope(rw, "acme", "rw")).toBe("rw")
    expect(requireScope(ro, "acme", "ro")).toBe("ro")
    expect(requireScope(ADMIN, "anything", "rw")).toBe("rw")
    expect(() => requireScope(ro, "acme", "rw")).toThrow("read-only")
    expect(() => requireScope(ro, "other", "ro")).toThrow("no access")
    try {
      requireScope(ro, "acme", "rw")
    } catch (err) {
      expect((err as BqlError).status).toBe(403)
    }
  })
})

describe("Authenticator", () => {
  test("takes a bearer token from the header", async () => {
    const auth = new Authenticator({ keys: ring })
    const token = await mintToken(keys, { rw: ["acme"] })
    const request = new Request("http://x/v1/db/acme/query", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(tokenFromRequest(request)).toBe(token)
    const principal = await auth.authenticate(request)
    expect(principal.kind).toBe("token")
    expect((principal as TokenPrincipal).scopeFor("acme")).toBe("rw")
  })

  test("takes it from the query string, which is all EventSource can do", async () => {
    const auth = new Authenticator({ keys: ring })
    const token = await mintToken(keys, { ro: ["acme"] })
    const request = new Request(`http://x/v1/db/acme/changes?token=${token}`)
    const principal = await auth.authenticate(request)
    expect((principal as TokenPrincipal).scopeFor("acme")).toBe("ro")
  })

  test("takes a bare token, which is how the WebSocket hello arrives", async () => {
    const auth = new Authenticator({ keys: ring })
    const token = await mintToken(keys, { ro: ["acme"] })
    expect((await auth.authenticate(token)).kind).toBe("token")
  })

  test("no credential at all is a 401, not a 403", async () => {
    const auth = new Authenticator({ keys: ring })
    await expect(auth.authenticate(new Request("http://x/v1/db/acme/query"))).rejects.toThrow(
      BqlError,
    )
    try {
      await auth.authenticate(null)
    } catch (err) {
      expect((err as BqlError).status).toBe(401)
      expect((err as BqlError).code).toBe("UNAUTHENTICATED")
    }
  })

  test("the configured admin key is a principal of its own", async () => {
    const auth = new Authenticator({ keys: ring, adminKey: "s3cret" })
    expect(auth.hasAdminKey).toBe(true)
    expect((await auth.authenticateToken("s3cret")).kind).toBe("admin")
    await expect(auth.authenticateToken("s3cre")).rejects.toThrow(BqlError)
    await expect(auth.authenticateToken("s3cret ")).rejects.toThrow(BqlError)
  })

  test("secrets are compared without an early exit", () => {
    const enc = new TextEncoder()
    expect(constantTimeEqual(enc.encode("abc"), enc.encode("abc"))).toBe(true)
    expect(constantTimeEqual(enc.encode("abc"), enc.encode("abd"))).toBe(false)
    expect(constantTimeEqual(enc.encode("abc"), enc.encode("abcd"))).toBe(false)
    expect(constantTimeEqual(enc.encode(""), enc.encode(""))).toBe(true)
  })

  test("mints through the ring's signing key and honours its own clock", async () => {
    const revocations = new MemoryRevocationList()
    const auth = new Authenticator({ keys: ring, revocations, now: () => 1_700_000_000_000 })
    const token = await auth.mint({ rw: ["acme"], ttlMs: 3600_000 })
    const claims = await verifyToken(ring, token, { now: 1_700_000_000_000 })
    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.exp).toBe(1_700_003_600)
    revocations.revoke(claims.jti)
    await expect(auth.authenticateToken(token)).rejects.toThrow("revoked")
  })

  test("a node with no keys and no admin key accepts nothing", async () => {
    const auth = new Authenticator()
    await expect(auth.authenticateToken("whatever")).rejects.toThrow(BqlError)
  })
})
