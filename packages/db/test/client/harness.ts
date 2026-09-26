// A live server plus a client pointed at it. The server is the one `test/server/harness.ts`
// starts, so the SDK is tested against exactly the routes the route tests cover.

import type { BqlClientError } from "../../src/client/errors.ts"
import { createClient, type Client, type ClientOptions } from "../../src/client/index.ts"
import type { FetchLike } from "../../src/client/http.ts"
import { createDb, startTestServer, type TestServer } from "../server/harness.ts"

export { createDb, stopAll, type TestServer } from "../server/harness.ts"

export interface ClientFixture {
  server: TestServer
  client: Client
  /** Every HTTP request the client made, in order. */
  requests: { url: string; headers: Headers }[]
}

/** Starts a server, creates `acme` with a small schema, and points a client at it. */
export async function startClientFixture(
  options: Partial<ClientOptions> = {},
  schema = `create table todos(id integer primary key, title text, done integer default 0);
            create table notes(id integer primary key, body text)`,
): Promise<ClientFixture> {
  const server = await startTestServer()
  await createDb(server, "acme", schema)
  const requests: { url: string; headers: Headers }[] = []
  const recording: FetchLike = (url, init) => {
    requests.push({ url, headers: new Headers(init?.headers) })
    return fetch(url, init)
  }
  const client = createClient({
    url: server.url,
    token: server.adminKey,
    fetch: recording,
    retryMs: 20,
    ...options,
  })
  return { server, client, requests }
}

/** The error a promise rejected with. Fails the test when it resolved instead. */
export async function failure(promise: PromiseLike<unknown>): Promise<BqlClientError> {
  try {
    await promise
  } catch (err) {
    return err as BqlClientError
  }
  throw new Error("expected the call to fail, and it did not")
}

/** A result array as a plain one, which is what `toEqual` wants to compare against a literal. */
export function plain<T>(rows: readonly T[]): T[] {
  return [...rows]
}

/** Waits until `check` is true, polling the event loop. */
export async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
