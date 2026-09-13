// The test this milestone exists for.
//
// The schema, its resolvers and the dispatcher behind them are built once per tenant and cached.
// The token is per request. If the token were *captured* anywhere in that cached structure —
// baked into the generator's `headers`, or closed over by the in-process `fetch` — then two
// callers overlapping on one database would run with one set of rights, and nothing would say so.
//
// So: two requests, two tokens with disjoint table ACLs, deliberately interleaved. Neither can
// finish until the other has begun, which means the second request's context was built while the
// first was still resolving. Each must see only its own rights. An implementation that captured a
// token would answer both requests the same way and fail here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { currentCall, peekCall } from "../../src/graphql/index.ts"
import { graphqlFixture, type GraphQLFixture } from "./harness.ts"
import { stopAll } from "../server/harness.ts"

const SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL);
  INSERT INTO users (id, name) VALUES (1, 'ann');
  INSERT INTO orders (id, total) VALUES (1, 12.5)`

const BOTH = `{ listUsers { id } listOrders { id } }`

/** Releases only once every tag has arrived, so two requests cannot run one after the other. */
class Barrier {
  readonly #tags = new Set<string>()
  readonly #waiting: (() => void)[] = []
  readonly #needed: number
  timedOut = false

  constructor(needed: number) {
    this.#needed = needed
  }

  get arrived(): string[] {
    return [...this.#tags]
  }

  async arrive(tag: string): Promise<void> {
    this.#tags.add(tag)
    if (this.#tags.size >= this.#needed) {
      for (const release of this.#waiting.splice(0)) release()
      return
    }
    await new Promise<void>((release) => {
      this.#waiting.push(release)
      // A hang is a failure, not a stall: release late and let the assertions report it.
      setTimeout(() => {
        this.timedOut = true
        release()
      }, 5000).unref?.()
    })
  }
}

let fixture: GraphQLFixture
let barrier: Barrier
let dispatches: string[]

beforeAll(async () => {
  barrier = new Barrier(2)
  dispatches = []
  fixture = await graphqlFixture("gqlambient", SCHEMA, {
    wrapExec: (exec, as) => async (statement) => {
      // Every statement waits for the other caller to arrive, so the two requests are in flight
      // at once and their resolver chains are interleaved rather than sequential.
      await barrier.arrive(as)
      dispatches.push(`${as}: ${statement.sql.split(" ").slice(0, 4).join(" ")}`)
      return exec(statement)
    },
  })
  fixture.grant("ann", { users: "rw" })
  fixture.grant("bo", { orders: "rw" })
})

afterAll(async () => {
  await stopAll()
})

describe("the per-request token", () => {
  test("two interleaved callers each see only their own rights", async () => {
    type Both = { listUsers: { id: number }[] | null; listOrders: { id: number }[] | null }
    const [ann, bo] = await Promise.all([
      fixture.ask<Both>(BOTH, { as: "ann" }),
      fixture.ask<Both>(BOTH, { as: "bo" }),
    ])

    expect(barrier.timedOut).toBe(false)
    expect(barrier.arrived.sort()).toEqual(["ann", "bo"])
    // Both callers really were in flight together: neither request's statements are contiguous.
    expect(new Set(dispatches.map((line) => line.split(":")[0])).size).toBe(2)

    // ann may read users and not orders.
    expect(ann.body.data?.listUsers).toEqual([{ id: 1 }])
    expect(ann.body.data?.listOrders).toBeNull()
    expect(ann.body.errors?.[0]?.extensions?.code).toBe("NOT_AUTHORIZED")
    expect(ann.body.errors?.[0]?.path?.[0]).toBe("listOrders")

    // bo may read orders and not users — on the same cached schema, at the same time.
    expect(bo.body.data?.listOrders).toEqual([{ id: 1 }])
    expect(bo.body.data?.listUsers).toBeNull()
    expect(bo.body.errors?.[0]?.extensions?.code).toBe("NOT_AUTHORIZED")
    expect(bo.body.errors?.[0]?.path?.[0]).toBe("listUsers")

    // One schema served both, which is what makes the above a statement about a *shared* schema.
    expect(fixture.handler.schemas.size).toBe(1)
  })

  test("the cached dispatcher has no rights of its own outside a request", async () => {
    const tenant = await fixture.handler.schemas.for(fixture.db)
    // The very function the resolvers call, used with no request in flight. If it held a token —
    // anyone's — this would answer with rows.
    const response = await tenant.dispatch(`/v1/db/${fixture.db}/api/users`)
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: "INTERNAL" } })
  })

  test("the store is gone once the request is answered", () => {
    expect(peekCall()).toBeUndefined()
    expect(() => currentCall()).toThrow(/no request is in flight/)
  })
})
