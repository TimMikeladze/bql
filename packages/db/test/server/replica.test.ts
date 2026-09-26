// The lifecycle routes on a replica. A replica's files are a copy the primary owns, so a route
// that mutates the database set or the bytes of a database has to refuse rather than act: before
// this, `POST /v1/db` on a replica made a local primary-role database the cluster never heard
// about, and `DELETE /v1/db/{db}` removed the copy the applier needs and stopped that replica
// following the database for good.
//
// The refusal is the one statement writes already give when forwarding is off — `503 NOT_PRIMARY`
// with `BQL-Primary` — so nothing new reaches a client. The cluster harness is the replication
// one, because a replica that is genuinely following a primary is the only setup in which the
// "and it is still there on both nodes, still following" half of the claim means anything.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HEADERS } from "../../src/client/protocol.ts"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  untilSynced,
  untilTxid,
  type Node,
} from "../replication/harness.ts"

const SCHEMA = "create table t (id integer primary key, v text)"

let open: { close(): Promise<void> }[] = []

function track<T extends { close(): Promise<void> }>(thing: T): T {
  open.push(thing)
  return thing
}

afterEach(async () => {
  const current = open
  open = []
  for (const thing of current.reverse()) {
    try {
      await thing.close()
    } catch {
      // Already closed by the test itself.
    }
  }
})

afterAll(stopAll)

interface ErrorBody {
  error: { code: string; message: string; status: number; primary?: string }
}

async function pair(): Promise<{ primary: Node; replica: Node }> {
  const primary = track(await startPrimary())
  await createDb(primary, "acme", SCHEMA)
  const replica = track(await startReplica(primary))
  await untilSynced(primary, replica, "acme")
  return { primary, replica }
}

/** Asserts the `503 NOT_PRIMARY` shape, including where the client is told to go instead. */
async function expectNotPrimary(response: Response, primary: Node): Promise<void> {
  expect(response.status).toBe(503)
  const body = (await response.json()) as ErrorBody
  expect(body.error.code).toBe("NOT_PRIMARY")
  expect(body.error.primary).toBe(primary.replicationUrl)
  expect(response.headers.get(HEADERS.primary)).toBe(primary.replicationUrl)
}

async function names(node: Node): Promise<string[]> {
  const body = await node.json<{ databases: { name: string }[] }>("/v1/db")
  return body.databases.map((row) => row.name)
}

describe("admin routes on a replica", () => {
  test("POST /v1/db is refused and creates nothing", async () => {
    const { primary, replica } = await pair()

    const response = await replica.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "local" }),
    })
    await expectNotPrimary(response, primary)

    expect(await names(replica)).toEqual(["acme"])
    expect(await names(primary)).toEqual(["acme"])
  })

  test("DELETE /v1/db/:db is refused and the replica keeps following", async () => {
    const { primary, replica } = await pair()

    await expectNotPrimary(await replica.fetch("/v1/db/acme", { method: "DELETE" }), primary)

    expect(await names(replica)).toEqual(["acme"])
    expect(await names(primary)).toEqual(["acme"])

    // The point of the refusal: a commit made after it still reaches this replica.
    const written = await query(primary, "acme", "insert into t (v) values ('after')")
    await untilTxid(replica, "acme", written.txid)
    const read = await query(replica, "acme", "select v from t")
    expect(read.rows).toEqual([["after"]])
  })

  test("restore and import are refused too", async () => {
    const { primary, replica } = await pair()

    await expectNotPrimary(
      await replica.fetch("/v1/db/acme/restore", { method: "POST", body: JSON.stringify({}) }),
      primary,
    )
    await expectNotPrimary(
      await replica.fetch("/v1/db/fresh/import", { method: "POST", body: "not a database" }),
      primary,
    )
    expect(await names(replica)).toEqual(["acme"])
  })

  test("reads, snapshot and checkpoint still work on a replica", async () => {
    const { replica } = await pair()

    expect((await replica.fetch("/v1/db/acme")).status).toBe(200)
    expect((await replica.fetch("/v1/db/acme/replication")).status).toBe(200)
    expect((await replica.fetch("/v1/db/acme/dump")).status).toBe(200)

    const snapshot = await replica.fetch("/v1/db/acme/snapshot", {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(snapshot.status).toBe(200)

    const checkpoint = await replica.fetch("/v1/db/acme/checkpoint", {
      method: "POST",
      body: JSON.stringify({ mode: "PASSIVE" }),
    })
    expect(checkpoint.status).toBe(200)

    const minted = await replica.fetch("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ db: "acme" }),
    })
    expect(minted.status).toBe(201)
  })

  test("an unauthenticated request is still 401, not 503", async () => {
    const { replica } = await pair()
    const response = await replica.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "local" }),
      token: null,
    })
    // The role must not be something an anonymous caller can probe for.
    expect(response.status).toBe(401)
  })

  test("the same routes on a primary still work", async () => {
    const { primary } = await pair()

    const created = await primary.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "beta" }),
    })
    expect(created.status).toBe(201)

    const deleted = await primary.fetch("/v1/db/beta", { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect((await deleted.json()) as { deleted: boolean }).toMatchObject({ deleted: true })

    expect(await names(primary)).toEqual(["acme"])
  })
})
