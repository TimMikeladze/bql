// One real bql.sh server for both ORM suites, plus an embedded engine for the in-process leg. The
// server is the one `test/server/harness.ts` starts, so the adapters are exercised against exactly
// the routes everything else is tested against.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createClient, type Client, type Db } from "../../src/client/index.ts"
import { Bql } from "../../src/embedded.ts"
import { createDb, startTestServer, stopAll as stopServers, type TestServer } from "../server/harness.ts"
import { removeTempDir } from "../tmpdir.ts"

const clients: Client[] = []
const embedded: Bql[] = []
const dirs: string[] = []

export interface OrmFixture {
  server: TestServer
  client: Client
  db: Db
}

/**
 * A server, a database on it, and a client pointed at it. `intMode: "bigint"` is what the adapters
 * default to when they build a client of their own, so the tests run under the same codec.
 */
export async function startOrmFixture(name: string): Promise<OrmFixture> {
  const server = await startTestServer({
    // A parked transaction is idle between the ORM's statements; the 1 s leash the server harness
    // sets by default would expire one mid-test.
    limits: { txIdleTimeoutMs: 15_000 },
  })
  await createDb(server, name)
  const client = createClient({
    url: server.url,
    token: server.adminKey,
    db: name,
    intMode: "bigint",
    retryMs: 20,
  })
  clients.push(client)
  return { server, client, db: client.db(name) }
}

/** A second database on the fixture's server, for a test that wants a schema to itself. */
export async function anotherDb(fixture: OrmFixture, name: string): Promise<Db> {
  await createDb(fixture.server, name)
  return fixture.client.db(name)
}

/** An in-process engine with one database on it, for the embedded leg of the Kysely suite. */
export async function startEmbedded(name: string): Promise<Db> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-orm-"))
  dirs.push(dir)
  const bq = await Bql.open({ dir, intMode: "bigint", realtime: { idleRetainMs: 0 } })
  embedded.push(bq)
  return bq.create(name)
}

export async function stopAll(): Promise<void> {
  for (const client of clients.splice(0)) client.close()
  for (const bq of embedded.splice(0)) await bq.close()
  await stopServers()
  for (const dir of dirs.splice(0)) removeTempDir(dir)
}

/** The error a promise rejected with. Fails the test when it resolved instead. */
export async function failure(promise: PromiseLike<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (err) {
    return err as Error & { code?: string }
  }
  throw new Error("expected the call to fail, and it did not")
}
