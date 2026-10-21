// What `db.sync.write` and `db.sync.read` let a callback do with a tenant connection it is lent.
//
// The callback gets the driver's `Database` itself, so it keeps cached statements and SAVEPOINT
// nesting, and so it could also end the tenant's transaction, flip a connection pragma the tenant
// relies on, or attach another file. The guard refuses those at compile time through the driver's
// `Database.guard` slot, which sits beside the authorizer rather than in it: switching the
// authorizer expires every cached statement on the connection, and the point of lending the
// connection is that its cache survives. The driver re-asks the guard on a cache hit for any
// statement whose program has a guarded action, so a `commit` some other path prepared on the
// writer is refused here as well.

import { SQLITE_ATTACH, SQLITE_DETACH, SQLITE_DENY, SQLITE_OK, SQLITE_PRAGMA, SQLITE_TRANSACTION } from "../sqlite/constants.ts"
import { SqliteError } from "../sqlite/errors.ts"
import type { Database } from "../sqlite/index.ts"
import { PRAGMA_READ, PRAGMA_SUBJECT } from "./auth.ts"
import { BqlError } from "./errors.ts"

/** Checks and repairs that change nothing outside the open transaction, or write the header. */
const PRAGMA_TX: ReadonlySet<string> = new Set([
  "defer_foreign_keys",
  "foreign_key_check",
  "integrity_check",
  "quick_check",
  "user_version",
])

export interface GuardOptions {
  /**
   * Let the callback open its own transaction. True on a reader, where a `d.transaction()` is how
   * a callback reads a consistent snapshot; the lender rolls back whatever is still open after.
   * False on the writer, whose transaction belongs to the tenant.
   */
  transactions: boolean
}

class Guard {
  active = false
  refused: string | null = null

  constructor(readonly options: GuardOptions) {}

  check = (action: number, arg1: string | null, arg2: string | null): number => {
    if (!this.active) return SQLITE_OK
    const why = refusal(action, arg1, arg2, this.options)
    if (why === null) return SQLITE_OK
    this.refused = why
    return SQLITE_DENY
  }
}

const guards = new WeakMap<Database, Guard>()

function refusal(
  action: number,
  arg1: string | null,
  arg2: string | null,
  options: GuardOptions,
): string | null {
  switch (action) {
    case SQLITE_TRANSACTION:
      if (options.transactions) return null
      return `${arg1 ?? "BEGIN"}: the transaction belongs to sync.write; nest with d.transaction(), which uses a SAVEPOINT`
    case SQLITE_ATTACH:
    case SQLITE_DETACH:
      return "ATTACH and DETACH are not allowed on a tenant connection"
    case SQLITE_PRAGMA: {
      const name = arg1?.toLowerCase() ?? ""
      if (PRAGMA_SUBJECT.has(name) || PRAGMA_TX.has(name)) return null
      if (PRAGMA_READ.has(name) && arg2 === null) return null
      return `PRAGMA ${name}${arg2 === null ? "" : ` = ${arg2}`}: the tenant owns its connection settings`
    }
    default:
      return null
  }
}

/**
 * Runs `fn` with `db`'s guard on. A statement it refuses fails with `SQLITE_AUTH`; if that
 * failure is what `fn` throws, it comes out as `NOT_AUTHORIZED` naming what was refused.
 */
export function guarded<T>(db: Database, options: GuardOptions, fn: () => T): T {
  let guard = guards.get(db)
  if (!guard) {
    guard = new Guard(options)
    guards.set(db, guard)
    db.guard(guard.check)
  }
  if (guard.active) return fn()
  guard.active = true
  guard.refused = null
  try {
    return fn()
  } catch (err) {
    if (guard.refused !== null && err instanceof SqliteError && err.code === "SQLITE_AUTH") {
      throw BqlError.notAuthorized(guard.refused)
    }
    throw err
  } finally {
    guard.active = false
  }
}
