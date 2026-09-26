// Invariant: a value that survives a round trip through this codec is the same SQLite value it
// started as. JSON cannot carry three of SQLite's five storage classes faithfully — integers
// beyond 2^53, blobs, and non-finite doubles — so exactly those are tagged (`$i`, `$b`, `$f`)
// and everything else stays plain JSON (design §6.1, decision 3).
//
// The row encoder is on the hot path, so a row whose cells are all plain JSON already is handed
// back as-is rather than copied. Callers must treat the rows they pass in as given away.

import type {
  ArrayRow,
  Args,
  ObjectRow,
  ResultRows,
  RowsMode,
  Value,
} from "../client/protocol.ts"
import type { BindValue, NamedParams, SqliteValue } from "../sqlite/values.ts"
import { BqlError } from "./errors.ts"

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const INTEGER_TEXT = /^[+-]?\d+$/

interface Base64Methods {
  toBase64?: (options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }) => string
}
interface Base64Statics {
  fromBase64?: (
    text: string,
    options?: { alphabet?: "base64" | "base64url" },
  ) => Uint8Array
}

const nativeToBase64 = (Uint8Array.prototype as Base64Methods).toBase64
const nativeFromBase64 = (Uint8Array as unknown as Base64Statics).fromBase64

/** Standard-alphabet, padded base64 of `bytes`. */
export function toBase64(bytes: Uint8Array): string {
  if (nativeToBase64) return nativeToBase64.call(bytes)
  return btoa(binaryString(bytes))
}

/** URL-alphabet base64 without padding, as JWT segments are written. */
export function toBase64Url(bytes: Uint8Array): string {
  if (nativeToBase64) return nativeToBase64.call(bytes, { alphabet: "base64url", omitPadding: true })
  return btoa(binaryString(bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** Decodes either base64 alphabet, with or without padding. */
export function fromBase64(text: string): Uint8Array {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/")
  const padded =
    normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4))
  try {
    if (nativeFromBase64) return nativeFromBase64(padded)
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff
    return out
  } catch {
    throw BqlError.badRequest("value is not valid base64")
  }
}

/** Alias of `fromBase64`, which already accepts the URL alphabet. */
export const fromBase64Url = fromBase64

function binaryString(bytes: Uint8Array): string {
  let out = ""
  // String.fromCharCode has an argument-count ceiling, so feed it in chunks.
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return out
}

/** Wire form of a double JSON cannot hold. */
function encodeNonFinite(v: number): Value {
  if (Number.isNaN(v)) return { $f: "nan" }
  return v > 0 ? { $f: "inf" } : { $f: "-inf" }
}

/** Wire form of an integer, tagged only when a JSON number would lose precision. */
export function encodeInteger(v: number | bigint): Value {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : { $i: v.toFixed(0) }
  return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : { $i: v.toString() }
}

/** One value on its way out of SQLite and onto the wire. */
export function encodeValue(v: SqliteValue): Value {
  switch (typeof v) {
    case "string":
      return v
    case "number":
      return Number.isFinite(v) ? v : encodeNonFinite(v)
    case "bigint":
      return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : { $i: v.toString() }
    case "object": {
      if (v === null) return null
      if (v instanceof Uint8Array) return { $b: toBase64(v) }
      if (ArrayBuffer.isView(v)) {
        const view = v as ArrayBufferView
        return { $b: toBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) }
      }
      break
    }
    default:
      break
  }
  throw new BqlError("INTERNAL", "unencodable value from SQLite", 500)
}

function bigIntFromText(text: string): bigint {
  if (!INTEGER_TEXT.test(text)) {
    throw BqlError.badRequest(`"$i" must be an integer in decimal text, got ${JSON.stringify(text)}`)
  }
  return BigInt(text)
}

function nonFiniteFromTag(tag: string): number {
  switch (tag) {
    case "inf":
      return Number.POSITIVE_INFINITY
    case "-inf":
      return Number.NEGATIVE_INFINITY
    case "nan":
      return Number.NaN
    default:
      throw BqlError.badRequest(`"$f" must be "inf", "-inf" or "nan", got ${JSON.stringify(tag)}`)
  }
}

/**
 * Hrana writes every value as `{type, value}`. Accepting that shape here costs nothing and means
 * the compat layer (§6.7) and this codec can share one argument decoder.
 */
function decodeHrana(o: Record<string, unknown>): BindValue {
  switch (o.type) {
    case "null":
      return null
    case "integer": {
      const raw = o.value
      if (typeof raw === "number") return raw
      if (typeof raw === "string") return narrowBigInt(bigIntFromText(raw))
      break
    }
    case "float": {
      if (typeof o.value === "number") return o.value
      if (typeof o.value === "string") return Number(o.value)
      break
    }
    case "text":
      if (typeof o.value === "string") return o.value
      break
    case "blob": {
      const b64 = typeof o.base64 === "string" ? o.base64 : o.value
      if (typeof b64 === "string") return fromBase64(b64)
      break
    }
    default:
      break
  }
  throw BqlError.badRequest(`unsupported typed value: ${JSON.stringify(o)}`)
}

function narrowBigInt(v: bigint): number | bigint {
  return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : v
}

/** One value arriving from the wire, ready to bind to a statement parameter. */
export function decodeArg(v: unknown): BindValue {
  switch (typeof v) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return v
    case "undefined":
      return null
    case "object": {
      if (v === null) return null
      if (v instanceof Uint8Array) return v
      const o = v as Record<string, unknown>
      if (typeof o.$i === "string") return bigIntFromText(o.$i)
      if (typeof o.$b === "string") return fromBase64(o.$b)
      if (typeof o.$f === "string") return nonFiniteFromTag(o.$f)
      if (typeof o.type === "string") return decodeHrana(o)
      break
    }
    default:
      break
  }
  throw BqlError.badRequest(`cannot bind ${JSON.stringify(v) ?? typeof v} as a SQLite value`)
}

/**
 * Request `args` as the driver's bind arguments: a positional list, or a single object of named
 * parameters. Named keys may be written with or without their `:`, `@` or `$` sigil.
 */
export function decodeArgs(args: Args | undefined | null): BindValue[] | [NamedParams] {
  if (args === undefined || args === null) return []
  if (Array.isArray(args)) {
    const out: BindValue[] = new Array(args.length)
    for (let i = 0; i < args.length; i++) out[i] = decodeArg(args[i])
    return out
  }
  if (typeof args !== "object") {
    throw BqlError.badRequest("args must be an array or an object of named parameters")
  }
  const named: NamedParams = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    named[key] = decodeArg(value)
  }
  return [named]
}

/** The part of a prepared statement the row encoder reads. `Statement` satisfies it as it is. */
export interface RowSource {
  readonly columnNames: readonly string[]
  readonly declaredTypes: readonly (string | null)[]
}

export interface EncodedRows {
  columns: string[]
  types: string[]
  rows: ResultRows
}

function storageClass(v: SqliteValue): string | null {
  switch (typeof v) {
    case "string":
      return "TEXT"
    case "bigint":
      return "INTEGER"
    case "number":
      return Number.isInteger(v) ? "INTEGER" : "REAL"
    case "object":
      return v === null ? null : "BLOB"
    default:
      return null
  }
}

/**
 * Column types for the result. A declared type wins; otherwise the storage class of the first
 * non-null value in that column, which is all an expression column has. INTEGER and REAL are
 * told apart by the JS value, so a REAL holding a whole number reports INTEGER.
 */
function columnTypes(
  declared: readonly (string | null)[],
  columns: number,
  rows: readonly (readonly SqliteValue[])[],
): string[] {
  const types: string[] = new Array(columns)
  for (let i = 0; i < columns; i++) {
    const d = declared[i]
    if (d) {
      types[i] = d.toUpperCase()
      continue
    }
    let found: string | null = null
    for (let r = 0; r < rows.length && found === null; r++) {
      const row = rows[r]
      if (row) found = storageClass(row[i] as SqliteValue)
    }
    types[i] = found ?? "NULL"
  }
  return types
}

function encodeArrayRow(row: readonly SqliteValue[]): ArrayRow {
  const n = row.length
  for (let i = 0; i < n; i++) {
    const cell = row[i]
    if (cell === null) continue
    const t = typeof cell
    if (t === "string") continue
    if (t === "number" && Number.isFinite(cell as number)) continue
    const out: ArrayRow = new Array(n)
    for (let j = 0; j < i; j++) out[j] = row[j] as Value
    for (let j = i; j < n; j++) out[j] = encodeValue(row[j] as SqliteValue)
    return out
  }
  // Already valid JSON in every cell: hand the driver's own array straight through.
  return row as unknown as ArrayRow
}

function encodeObjectRow(row: readonly SqliteValue[], columns: readonly string[]): ObjectRow {
  const out: ObjectRow = {}
  for (let i = 0; i < columns.length; i++) {
    out[columns[i] as string] = encodeValue(row[i] as SqliteValue)
  }
  return out
}

/**
 * Encodes a result set. `rows` are the driver's `values()` output — arrays in column order — and
 * `mode` chooses between the compact array form (default, decision 4) and objects.
 */
export function encodeRows(
  source: RowSource,
  rows: readonly (readonly SqliteValue[])[],
  mode: RowsMode = "array",
): EncodedRows {
  const columns = source.columnNames as string[]
  const types = columnTypes(source.declaredTypes, columns.length, rows)
  if (mode === "object") {
    const out: ObjectRow[] = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) {
      out[i] = encodeObjectRow(rows[i] as readonly SqliteValue[], columns)
    }
    return { columns: [...columns], types, rows: out }
  }
  const out: ArrayRow[] = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) out[i] = encodeArrayRow(rows[i] as readonly SqliteValue[])
  return { columns: [...columns], types, rows: out }
}
