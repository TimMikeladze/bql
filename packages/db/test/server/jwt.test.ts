// The provider-JWT verifier behind `/v1/session { jwt }` (docs/plan-web.md, "Accounts"), against
// keys made here and a JWKS served from a local listener, so key rotation is a real refetch.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JwtVerifier } from "../../src/server/jwt.ts"
import { TestIdp } from "./idp.ts"

let idp: TestIdp
const ISSUER = "https://idp.test"

beforeAll(async () => {
  idp = await TestIdp.start(ISSUER)
})
afterAll(() => idp.stop())

function provider(audience?: string) {
  return { issuer: ISSUER, jwks: idp.jwksUrl, ...(audience ? { audience } : {}) }
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return "ok"
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`
  }
}

describe("JwtVerifier", () => {
  test("accepts RS256, ES256 and EdDSA tokens from the provider's keys", async () => {
    const verifier = new JwtVerifier()
    for (const alg of ["RS256", "ES256", "EdDSA"] as const) {
      const claims = await verifier.verify(await idp.sign({ sub: `user-${alg}` }, { alg }), provider())
      expect(claims.sub).toBe(`user-${alg}`)
    }
  })

  test("refuses a bad signature, another issuer, another audience and alg none", async () => {
    const verifier = new JwtVerifier()
    const good = await idp.sign({ sub: "u1", aud: "acme" })
    const [h, p, sig] = good.split(".") as [string, string, string]
    const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: "u2", iss: ISSUER, aud: "acme", exp: 9e9 })).toString("base64url")}.${sig}`
    expect(await code(verifier.verify(tampered, provider()))).toMatch(/UNAUTHENTICATED: jwt: bad signature/)
    expect(await code(verifier.verify(good, { ...provider(), issuer: "https://other.test" }))).toMatch(/iss .* is not/)
    expect(await code(verifier.verify(good, provider("acme")))).toBe("ok")
    expect(await code(verifier.verify(good, provider("other")))).toMatch(/aud .* does not name other/)
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${p}.`
    expect(await code(verifier.verify(none, provider()))).toMatch(/alg "none" is not accepted/)
    const hs = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${p}.${sig}`
    expect(await code(verifier.verify(hs, provider()))).toMatch(/alg "HS256" is not accepted/)
  })

  test("checks exp and nbf with 30 s of skew", async () => {
    const verifier = new JwtVerifier()
    const now = Math.floor(Date.now() / 1000)
    expect(await code(verifier.verify(await idp.sign({ sub: "u", exp: now - 60 }), provider()))).toMatch(/expired/)
    expect(await code(verifier.verify(await idp.sign({ sub: "u", exp: now - 10 }), provider()))).toBe("ok")
    expect(await code(verifier.verify(await idp.sign({ sub: "u", nbf: now + 120 }), provider()))).toMatch(/nbf/)
    expect(await code(verifier.verify(await idp.sign({ sub: "u", exp: undefined }), provider()))).toMatch(/no exp/)
  })

  test("an unknown kid refetches once; a rotated-in key is then accepted", async () => {
    let nowMs = Date.now()
    const verifier = new JwtVerifier({ refetchCooldownMs: 30_000 })
    await verifier.verify(await idp.sign({ sub: "u" }), provider(), nowMs)
    const before = idp.fetches
    const rotated = await idp.rotate()
    const token = await idp.sign({ sub: "u" }, { kid: rotated })

    // Right after a read, a forced one is not allowed: an unknown kid is refused without a fetch.
    expect(await code(verifier.verify(token, provider(), nowMs + 1_000))).toMatch(/has no key/)
    expect(idp.fetches).toBe(before)

    nowMs += 31_000
    expect(await code(verifier.verify(token, provider(), nowMs))).toBe("ok")
    expect(idp.fetches).toBe(before + 1)

    // A made-up kid inside the cooldown costs the provider nothing.
    const bogus = await idp.sign({ sub: "u" }, { kid: "made-up" })
    expect(await code(verifier.verify(bogus, provider(), nowMs + 5_000))).toMatch(/has no key made-up/)
    expect(idp.fetches).toBe(before + 1)
  })

  test("an unreachable JWKS is IDP_UNAVAILABLE", async () => {
    const verifier = new JwtVerifier()
    const token = await idp.sign({ sub: "u" })
    expect(await code(verifier.verify(token, { issuer: ISSUER, jwks: "http://127.0.0.1:1/jwks" }))).toMatch(/^IDP_UNAVAILABLE/)
  })
})
