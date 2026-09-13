// Invariant: values crossing the FFI boundary are copied, never aliased. Text and blobs are
// bound with SQLITE_TRANSIENT so SQLite owns its copy, and blobs are read out through a copy of
// the column buffer, so no JS value ever points at memory SQLite may reuse on the next step.

import { CString, toArrayBuffer } from "bun:ffi"
import {
  SQLITE_BLOB,
  SQLITE_FLOAT,
  SQLITE_INTEGER,
  SQLITE_TEXT,
} from "./constants.ts"
import type { CoreSymbols, SqliteLibrary } from "./lib.ts"

/** A value as it comes back out of SQLite. */
export type SqliteValue = number | bigint | string | Uint8Array | null

/** A value that may be bound to a parameter. */
export type BindValue = SqliteValue | boolean | ArrayBuffer | ArrayBufferView | undefined

/** A named-parameter object: keys with or without the `:`, `@` or `$` prefix. */
export type NamedParams = Record<string, BindValue>

/**
 * One argument to a statement verb: a positional value, or — as the only argument — an object of
 * named parameters. The two are one type because TypeScript cannot express "either a list of
 * values or exactly one object" in a rest parameter without losing object-literal checking.
 */
export type BindArg = BindValue | NamedParams

/** Positional parameters, or a single object of named parameters. */
export type BindParams = readonly BindValue[] | [NamedParams]

const SQLITE_TRANSIENT = -1n
const EMPTY = new Uint8Array(1)
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

/**
 * Binds one value to a 1-based parameter slot. Returns the SQLite result code, so the caller
 * decides how to raise it.
 */
export function bindOne(
  s: CoreSymbols,
  stmt: number,
  index: number,
  value: BindValue,
): number {
  switch (typeof value) {
    case "number":
      if (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX) {
        return s.sqlite3_bind_int(stmt, index, value)
      }
      if (Number.isSafeInteger(value)) {
        return s.sqlite3_bind_int64(stmt, index, BigInt(value))
      }
      return s.sqlite3_bind_double(stmt, index, value)
    case "bigint":
      return s.sqlite3_bind_int64(stmt, index, value)
    case "string": {
      const bytes = Buffer.from(value, "utf8")
      return s.sqlite3_bind_text(
        stmt,
        index,
        bytes.byteLength === 0 ? EMPTY : bytes,
        bytes.byteLength,
        SQLITE_TRANSIENT,
      )
    }
    case "boolean":
      return s.sqlite3_bind_int(stmt, index, value ? 1 : 0)
    case "undefined":
      return s.sqlite3_bind_null(stmt, index)
    case "object": {
      if (value === null) return s.sqlite3_bind_null(stmt, index)
      if (value instanceof ArrayBuffer) {
        const view = new Uint8Array(value)
        return s.sqlite3_bind_blob(
          stmt,
          index,
          view.byteLength === 0 ? EMPTY : view,
          view.byteLength,
          SQLITE_TRANSIENT,
        )
      }
      if (ArrayBuffer.isView(value)) {
        const view =
          value instanceof Uint8Array
            ? value
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        return s.sqlite3_bind_blob(
          stmt,
          index,
          view.byteLength === 0 ? EMPTY : view,
          view.byteLength,
          SQLITE_TRANSIENT,
        )
      }
      break
    }
    default:
      break
  }
  throw new TypeError(
    `cannot bind ${Object.prototype.toString.call(value)} to SQLite parameter ${index}`,
  )
}

/**
 * Reads column `i` of the current row. `safeIntegers` forces every INTEGER to a bigint; the
 * default hands back a number whenever the value fits without loss.
 */
export function columnValue(
  lib: SqliteLibrary,
  stmt: number,
  i: number,
  safeIntegers: boolean,
): SqliteValue {
  const s = lib.symbols
  switch (s.sqlite3_column_type(stmt, i)) {
    case SQLITE_INTEGER:
      return safeIntegers
        ? lib.wide.sqlite3_column_int64(stmt, i)
        : s.sqlite3_column_int64(stmt, i)
    case SQLITE_FLOAT:
      return s.sqlite3_column_double(stmt, i)
    case SQLITE_TEXT: {
      const p = s.sqlite3_column_text(stmt, i)
      if (!p) return ""
      const n = s.sqlite3_column_bytes(stmt, i)
      return n === 0 ? "" : new CString(p, 0, n).toString()
    }
    case SQLITE_BLOB: {
      const p = s.sqlite3_column_blob(stmt, i)
      const n = s.sqlite3_column_bytes(stmt, i)
      if (!p || n === 0) return new Uint8Array(0)
      const out = new Uint8Array(n)
      out.set(new Uint8Array(toArrayBufferUnsafe(p, n)))
      return out
    }
    default:
      return null
  }
}

/** Reads an `sqlite3_value *`, used by the preupdate accessors. */
export function protectedValue(
  lib: SqliteLibrary,
  value: number,
  safeIntegers: boolean,
): SqliteValue {
  if (!value) return null
  const s = lib.symbols
  switch (s.sqlite3_value_type(value)) {
    case SQLITE_INTEGER:
      return safeIntegers ? lib.wide.sqlite3_value_int64(value) : s.sqlite3_value_int64(value)
    case SQLITE_FLOAT:
      return s.sqlite3_value_double(value)
    case SQLITE_TEXT: {
      const p = s.sqlite3_value_text(value)
      if (!p) return ""
      const n = s.sqlite3_value_bytes(value)
      return n === 0 ? "" : new CString(p, 0, n).toString()
    }
    case SQLITE_BLOB: {
      const p = s.sqlite3_value_blob(value)
      const n = s.sqlite3_value_bytes(value)
      if (!p || n === 0) return new Uint8Array(0)
      const out = new Uint8Array(n)
      out.set(new Uint8Array(toArrayBufferUnsafe(p, n)))
      return out
    }
    default:
      return null
  }
}

/** A view over SQLite-owned memory. Only ever read from immediately, never retained. */
function toArrayBufferUnsafe(p: number, n: number): ArrayBuffer {
  return toArrayBuffer(p, 0, n)
}
