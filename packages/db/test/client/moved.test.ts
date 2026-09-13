// What the SDK replays, and — much more importantly — what it does not.
//
// A replay is safe only because `NOT_PRIMARY` is produced strictly before a statement runs. Every
// other failure a write can end in either committed or may-have-committed, and replaying one of
// those double-applies an insert. So the rule is pinned here against a stub `fetch` rather than
// against a cluster, where the interesting cases are hard to provoke on purpose.

import { describe, expect, test } from "bun:test"
import { createClient } from "../../src/client/index.ts"
import { BunQLClientError } from "../../src/client/errors.ts"

interface Call {
  url: string
  method: string
  authorization: string | null
  body: unknown
}

/** A `fetch` that answers from a queue and records what it was asked. */
function stub(answers: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...answers]
  const impl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const next = queue.shift()
    if (!next) throw new Error(`no stubbed answer for ${url}`)
    return next
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

function failure(code: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message: code, status } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function ok(txid = 7): Response {
  return new Response(
    JSON.stringify({
      columns: [],
      types: [],
      rows: [],
      rowsAffected: 1,
      lastInsertRowid: null,
      txid,
      durationUs: 1,
      vmSteps: 1,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/** `Query` is a thenable, not a `Promise`; `expect().rejects` wants a real one. */
function run(sdk: ReturnType<typeof createClient>, sql: string): Promise<unknown> {
  return (async () => await sdk.db().unsafe(sql))()
}

function client(fetchImpl: typeof fetch) {
  return createClient({
    url: "http://a:4321",
    token: "tok",
    db: "acme",
    fetch: fetchImpl as never,
    WebSocket: null,
  })
}

describe("the one-shot replay", () => {
  test("a NOT_PRIMARY naming another node is replayed there, once, with this client's token", async () => {
    const { fetch: impl, calls } = stub([
      failure("NOT_PRIMARY", 503, { "BunQL-Primary": "http://b:4321" }),
      ok(),
    ])
    const sdk = client(impl)
    try {
      const rows = await sdk.db().unsafe("insert into t values (1)")
      expect(rows.txid).toBe(7)
    } finally {
      sdk.close()
    }
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe("http://a:4321/v1/db/acme/query")
    expect(calls[1]?.url).toBe("http://b:4321/v1/db/acme/query")
    // The token is this client's, carried onto the new node. Following the redirect instead would
    // have dropped it: `Authorization` does not survive a cross-origin redirect.
    expect(calls[1]?.authorization).toBe("Bearer tok")
    expect(calls[1]?.body).toEqual(calls[0]?.body as never)
  })

  test("a `ws://…/v1/replication` in the header is understood as the node beside it", async () => {
    const { fetch: impl, calls } = stub([
      failure("NOT_PRIMARY", 503, { "BunQL-Primary": "ws://b:4321/v1/replication" }),
      ok(),
    ])
    const sdk = client(impl)
    try {
      await sdk.db().unsafe("insert into t values (1)")
    } finally {
      sdk.close()
    }
    expect(calls[1]?.url).toBe("http://b:4321/v1/db/acme/query")
  })

  test("it replays once and no more", async () => {
    const { fetch: impl, calls } = stub([
      failure("NOT_PRIMARY", 503, { "BunQL-Primary": "http://b:4321" }),
      failure("NOT_PRIMARY", 503, { "BunQL-Primary": "http://c:4321" }),
    ])
    const sdk = client(impl)
    try {
      await expect(run(sdk, "insert into t values (1)")).rejects.toThrow()
    } finally {
      sdk.close()
    }
    expect(calls).toHaveLength(2)
  })

  test("a NOT_PRIMARY naming the node that just answered is not replayed at it", async () => {
    const { fetch: impl, calls } = stub([
      failure("NOT_PRIMARY", 503, { "BunQL-Primary": "http://a:4321" }),
    ])
    const sdk = client(impl)
    try {
      await expect(run(sdk, "insert into t values (1)")).rejects.toThrow()
    } finally {
      sdk.close()
    }
    expect(calls).toHaveLength(1)
  })

  test("a NOT_PRIMARY naming nowhere is not replayed", async () => {
    const { fetch: impl, calls } = stub([failure("NOT_PRIMARY", 503)])
    const sdk = client(impl)
    try {
      await expect(run(sdk, "insert into t values (1)")).rejects.toThrow()
    } finally {
      sdk.close()
    }
    expect(calls).toHaveLength(1)
  })

  test("a batch is replayed too — the server refuses it before running any of it", async () => {
    const { fetch: impl, calls } = stub([
      failure("NOT_PRIMARY", 503, { "BunQL-Primary": "http://b:4321" }),
      new Response(JSON.stringify({ results: [], txid: 9 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ])
    const sdk = client(impl)
    try {
      await sdk.db().batch([{ sql: "insert into t values (1)" }])
    } finally {
      sdk.close()
    }
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toBe("http://b:4321/v1/db/acme/batch")
  })
})

describe("what is never replayed", () => {
  const cases: [string, number][] = [
    // "may or may not have committed" — `docs/next.md`. Replaying one double-applies the write.
    ["FORWARD_TIMEOUT", 504],
    // Committed, and locally durable; only the durability promise failed.
    ["ACK_TIMEOUT", 503],
    // A different refusal that also carries `BunQL-Primary` from a replica.
    ["BUSY", 503],
    ["QUOTA_EXCEEDED", 507],
    ["SQLITE_CONSTRAINT_UNIQUE", 409],
  ]

  for (const [code, status] of cases) {
    test(`${code} reaches the caller from the node that produced it`, async () => {
      const { fetch: impl, calls } = stub([
        failure(code, status, { "BunQL-Primary": "http://b:4321" }),
      ])
      const sdk = client(impl)
      try {
        await expect(run(sdk, "insert into t values (1)")).rejects.toMatchObject({ code })
      } finally {
        sdk.close()
      }
      expect(calls).toHaveLength(1)
    })
  }

  test("nothing inside an interactive transaction, whose baton belongs to one node", async () => {
    const { fetch: impl, calls } = stub([
      new Response(JSON.stringify({ tx: "baton", expiresInMs: 5000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      failure("NOT_PRIMARY", 503, { "BunQL-Primary": "http://b:4321" }),
      new Response(JSON.stringify({ txid: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ])
    const sdk = client(impl)
    try {
      await expect(
        sdk.db().transaction(async (tx) => {
          await tx.unsafe("insert into t values (1)")
        }, { via: "http" }),
      ).rejects.toBeInstanceOf(BunQLClientError)
    } finally {
      sdk.close()
    }
    // begin, the statement, the rollback — and no replay of the statement anywhere else.
    expect(calls.map((call) => call.url)).toEqual([
      "http://a:4321/v1/db/acme/tx",
      "http://a:4321/v1/db/acme/tx/baton",
      "http://a:4321/v1/db/acme/tx/baton/rollback",
    ])
  })
})
