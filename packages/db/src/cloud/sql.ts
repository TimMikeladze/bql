import type { StatementBoundary } from "../server/runtime.ts"
import * as sqlite from "../sqlite/constants.ts"
import { CloudError } from "./errors.ts"

const forbidden = new Set([
  sqlite.SQLITE_TRANSACTION, sqlite.SQLITE_SAVEPOINT, sqlite.SQLITE_ATTACH, sqlite.SQLITE_DETACH,
  sqlite.SQLITE_PRAGMA, sqlite.SQLITE_CREATE_TEMP_TABLE, sqlite.SQLITE_CREATE_TEMP_INDEX,
  sqlite.SQLITE_CREATE_TEMP_VIEW, sqlite.SQLITE_CREATE_TEMP_TRIGGER,
  sqlite.SQLITE_DROP_TEMP_TABLE, sqlite.SQLITE_DROP_TEMP_INDEX, sqlite.SQLITE_DROP_TEMP_VIEW,
  sqlite.SQLITE_DROP_TEMP_TRIGGER,
])
const sessionFunctions = new Set(["last_insert_rowid", "changes", "total_changes", "load_extension"])
/** Wrap only client SQL, including preparation and stepping. Internal BEGIN,
 * snapshots and connection configuration run outside this boundary. */
export const cloudStatementBoundary: StatementBoundary = (_db, hub, execute) => {
  let denied = false
  const remove = hub.addLayer((action, _arg1, arg2, dbName) => {
    if (forbidden.has(action) || dbName === "temp" || (action === sqlite.SQLITE_FUNCTION && sessionFunctions.has((arg2 ?? "").toLowerCase()))) {
      denied = true
      return sqlite.SQLITE_DENY
    }
    return sqlite.SQLITE_OK
  })
  try { return execute() }
  catch (error) {
    if (denied) throw new CloudError("CLOUD_UNSUPPORTED", "Session SQL, PRAGMA and attached or temporary databases are not supported in cloud mode")
    throw error
  } finally { remove() }
}
