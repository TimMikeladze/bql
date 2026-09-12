// Invariant: `src/dataapi/` never runs a statement itself. It builds one, hands it to the
// `exec` on the context it was instantiated with, and reads the rows back. That `exec` is a
// closure over `src/server/exec.ts` — the only path in BunQL that steps a statement, and where
// the token's per-table ACLs, the deadline, the row cap, `vmSteps`, the quota, the txid, the ack
// level and write forwarding all already live. Going around it would be a second execution
// engine, which `docs/plan-surfaces.md` says must not exist; inheriting it means the data API
// gets every one of those without a line of new code.
//
// The context type is declared *here*, naming only what a generated operation needs, and not
// imported from `src/server/`. The dependency direction of `docs/plan-surfaces.md` is strictly
// downward: the server knows about the data API, the data API does not know about the server.
// `src/server/routes.ts` builds a `DataApiContext` per request out of its own `RouteContext`,
// and that wiring is the server's to write.

/** A value this API binds to a statement parameter. `decodeArg` in `src/server/json.ts` takes each of these. */
export type DataValue = null | boolean | number | bigint | string | Uint8Array

/** One statement, in the shape `src/server/exec.ts` already takes. */
export interface DataStatement {
  readonly sql: string
  /** Positional parameters, always. No value ever reaches `sql`. */
  readonly args: readonly DataValue[]
}

/**
 * What a statement produced, as `src/server/json.ts` encodes it: an integer beyond +/-2^53 is
 * `{"$i": "<decimal>"}`, a BLOB is `{"$b": "<base64>"}` and a non-finite double is `{"$f": …}`.
 * Those encoded values are handed back to the client untouched, which is how a 64-bit rowid
 * survives the data API without being narrowed.
 *
 * `rows` are arrays in `columns` order — `exec.ts`'s default `rows: "array"` mode. A context that
 * runs in `"object"` mode is tolerated: `rowObjects` reads either.
 */
export interface DataRows {
  readonly columns: readonly string[]
  readonly rows: readonly unknown[]
  readonly rowsAffected: number
  readonly txid: number
}

export type Execute = (statement: DataStatement) => DataRows | Promise<DataRows>

/** What a generated operation's handler is given. */
export interface DataApiContext {
  /** The database the request addressed, so a mis-routed request fails loudly rather than quietly. */
  readonly db: string
  /** Runs one statement through `src/server/exec.ts`, as the request's own principal. */
  readonly exec: Execute
}

/** A result's rows as objects keyed by column name, from either `rows` mode. */
export function rowObjects(result: DataRows): Record<string, unknown>[] {
  const columns = result.columns
  return result.rows.map((row) => {
    if (!Array.isArray(row)) return row as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (let i = 0; i < columns.length; i++) out[columns[i] as string] = row[i]
    return out
  })
}
