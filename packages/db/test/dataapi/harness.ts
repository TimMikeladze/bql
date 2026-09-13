// A real tenant, a real `src/server/exec.ts` and a real data API over both. Nothing here is a
// mock: the point of these tests is that the generated statements survive SQLite and that the
// token's ACL still applies, and neither can be shown against a fake.

import { createDb, startTestServer, type TestServer } from "../server/harness.ts"
import type { Args } from "../../src/client/protocol.ts"
import { ADMIN, claimsFor, type Principal, tokenPrincipal } from "../../src/server/auth.ts"
import { executeStatement, resolveOptions } from "../../src/server/exec.ts"
import {
  DataApiCache,
  type DataApiContext,
  type DataApiEntry,
  type DataStatement,
  type Execute,
} from "../../src/dataapi/index.ts"
import type { DataApiOptions } from "../../src/dataapi/operations.ts"
import { createDispatcher, type Dispatcher } from "../../src/http/index.ts"

export interface DataApiFixture {
  server: TestServer
  db: string
  entry: DataApiEntry
  /** An exec with the server's own rights, as introspection needs. */
  admin: Execute
  /** An exec as `principal`, which is what a request gets. */
  execAs(principal: Principal): Execute
  /** A dispatcher over the generated registry, running as `principal`. */
  dispatchAs(principal: Principal): Dispatcher
  /** A token principal scoped to `db` with an optional per-table ACL. */
  token(tables?: Record<string, "r" | "rw">): Principal
  close(): Promise<void>
}

export async function dataApiFixture(
  db: string,
  schema: string,
  options: DataApiOptions = {},
): Promise<DataApiFixture> {
  const server = await startTestServer()
  await createDb(server, db, schema)
  const runtime = server.handle.runtime
  const resolved = resolveOptions(undefined, null, server.handle.config)

  const execAs = (principal: Principal): Execute => {
    return (statement: DataStatement) => {
      const tenant = runtime.tenant(db)
      const { result } = executeStatement(
        runtime,
        tenant,
        principal,
        { sql: statement.sql, args: statement.args as unknown as Args },
        resolved,
      )
      return {
        columns: result.columns,
        rows: result.rows as unknown[],
        rowsAffected: result.rowsAffected,
        txid: result.txid,
      }
    }
  }

  const admin = execAs(ADMIN)
  const entry = await new DataApiCache(options).for(db, admin)

  return {
    server,
    db,
    entry,
    admin,
    execAs,
    dispatchAs(principal: Principal): Dispatcher {
      const context: DataApiContext = { db, exec: execAs(principal) }
      return createDispatcher(entry.registry, () => context, {
        origin: "http://dataapi.test",
        onError: () => {},
      })
    },
    token(tables?: Record<string, "r" | "rw">): Principal {
      return tokenPrincipal(
        claimsFor(tables ? { rw: [db], tables } : { rw: [db] }),
      )
    },
    async close(): Promise<void> {
      await server.close()
    },
  }
}

/** The JSON body of a response, with its status alongside. */
export async function read<T = unknown>(
  response: Response,
): Promise<{ status: number; body: T }> {
  const text = await response.text()
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : null) as T }
}
