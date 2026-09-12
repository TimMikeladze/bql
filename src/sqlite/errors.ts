// Invariant: a non-zero SQLite return code never escapes this module as a bare number. Every
// failure surfaces as a SqliteError carrying the extended result code, its sqlite3.h name, and
// the library's own error message.

import { RESULT_CODE_NAMES } from "./constants.ts"

export class SqliteError extends Error {
  /** Extended result code name, e.g. `"SQLITE_CONSTRAINT_UNIQUE"`. */
  readonly code: string
  /** Extended result code as a number. */
  readonly rc: number

  constructor(message: string, rc: number) {
    super(message)
    this.name = "SqliteError"
    this.rc = rc
    this.code = codeName(rc)
  }
}

/** Raised when the loaded libsqlite3 does not provide a capability the caller asked for. */
export class FeatureUnavailableError extends Error {
  readonly feature: string

  constructor(feature: string, detail: string) {
    super(`${feature} is not available in the loaded SQLite library: ${detail}`)
    this.name = "FeatureUnavailableError"
    this.feature = feature
  }
}

/**
 * Name for a result code. Extended codes fall back to their primary code's name when the
 * library reports an extension we do not have a constant for.
 */
export function codeName(rc: number): string {
  const exact = RESULT_CODE_NAMES[rc]
  if (exact !== undefined) return exact
  const primary = RESULT_CODE_NAMES[rc & 0xff]
  if (primary !== undefined) return primary
  return `SQLITE_UNKNOWN_${rc}`
}
