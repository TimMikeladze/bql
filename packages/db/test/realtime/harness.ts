// Shared scaffolding for the realtime tests: a real driver connection on a temp file, and the
// `execute` the live registry expects — the route layer's job in production, a closure here.

import { decodeArgs, encodeRows } from "../../src/server/json.ts"
import type { Args, RowsMode } from "../../src/client/protocol.ts"
import type { LiveExecute } from "../../src/realtime/index.ts"
import { Database } from "../../src/sqlite/index.ts"
import { tempDb } from "../sqlite/tmp.ts"

export function open(...schema: string[]): Database {
  const db = Database.open(tempDb())
  for (const sql of schema) db.exec(sql)
  return db
}

/** Runs a statement the way a route would: bind, step, encode. */
export function runner(db: Database, mode: RowsMode = "array"): LiveExecute {
  return (sql: string, args: Args | undefined) => {
    const stmt = db.prepare(sql)
    const params = decodeArgs(args ?? [])
    const rows = stmt.values(...params)
    return encodeRows(stmt, rows, mode)
  }
}

/** Lets every queued microtask and timer callback run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
