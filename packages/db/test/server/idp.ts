// A stand-in identity provider for tests: RS256, ES256 and EdDSA keys made in the test, a JWKS
// served on a free port, and `rotate()` to add a key the way a provider rolls one in.

type Alg = "RS256" | "ES256" | "EdDSA"

const PARAMS = {
  RS256: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
  EdDSA: { name: "Ed25519" },
} as const

const SIGN = {
  RS256: { name: "RSASSA-PKCS1-v1_5" },
  ES256: { name: "ECDSA", hash: "SHA-256" },
  EdDSA: { name: "Ed25519" },
} as const

interface Key {
  kid: string
  alg: Alg
  privateKey: CryptoKey
  jwk: Record<string, unknown>
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

export class TestIdp {
  readonly keys: Key[] = []
  fetches = 0
  #server!: ReturnType<typeof Bun.serve>
  #n = 0

  private constructor(readonly issuer: string) {}

  static async start(issuer: string): Promise<TestIdp> {
    const idp = new TestIdp(issuer)
    for (const alg of ["RS256", "ES256", "EdDSA"] as const) await idp.#add(alg)
    idp.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        idp.fetches++
        return Response.json({ keys: idp.keys.map((key) => key.jwk) })
      },
    })
    return idp
  }

  get jwksUrl(): string {
    return `http://127.0.0.1:${this.#server.port}/.well-known/jwks.json`
  }

  async #add(alg: Alg): Promise<string> {
    const pair = (await crypto.subtle.generateKey(PARAMS[alg] as never, true, ["sign", "verify"])) as CryptoKeyPair
    const kid = `${alg.toLowerCase()}-${++this.#n}`
    const { key_ops: _ops, ext: _ext, ...bare } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>
    const jwk = { ...bare, kid, alg, use: "sig" }
    this.keys.push({ kid, alg, privateKey: pair.privateKey, jwk })
    return kid
  }

  /** Adds a new ES256 key to the published set and returns its kid. */
  rotate(): Promise<string> {
    return this.#add("ES256")
  }

  /**
   * A signed token: `iss` and an `exp` an hour out unless `claims` sets them (`exp: undefined`
   * leaves it off). `kid` picks the key, which may be one not published (`"made-up"`).
   */
  async sign(claims: Record<string, unknown>, options: { alg?: Alg; kid?: string } = {}): Promise<string> {
    const key = options.kid
      ? (this.keys.find((one) => one.kid === options.kid) ?? { ...this.keys.find((one) => one.alg === "ES256")!, kid: options.kid })
      : this.keys.find((one) => one.alg === (options.alg ?? "ES256"))!
    const payload: Record<string, unknown> = { iss: this.issuer, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims }
    for (const [name, value] of Object.entries(payload)) if (value === undefined) delete payload[name]
    const input = `${b64({ alg: key.alg, kid: key.kid, typ: "JWT" })}.${b64(payload)}`
    const signature = await crypto.subtle.sign(SIGN[key.alg] as never, key.privateKey, new TextEncoder().encode(input))
    return `${input}.${Buffer.from(signature).toString("base64url")}`
  }

  stop(): void {
    this.#server.stop(true)
  }
}
