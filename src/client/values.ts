// Invariant: this module is the only place a wire value becomes a JavaScript value or the other
// way round, and nothing in it may touch a Bun or Node global. The client runs in browsers,
// Workers, Node and Bun, so `atob`/`btoa`, `TextDecoder` and the standard `Uint8Array` base64
// methods are the whole toolbox.
//
// Design §6.1: ordinary rows are plain JSON, and only the three things JSON cannot carry are
// tagged — integers outside the double-safe range (`$i`), blobs (`$b`) and non-finite doubles
// (`$f`).

import type {
  ArrayRow,
  ObjectRow,
  ResultRows,
  Value,
} from "./protocol.ts"

/**
 * What an integer beyond `Number.MAX_SAFE_INTEGER` becomes. `"number"` has no representation for
 * it, so it throws rather than handing back a value that is quietly wrong.
 */
export type IntMode = "number" | "bigint" | "string"

/** A SQLite value as this client hands it to the caller. */
export type JsValue = null | number | string | boolean | bigint | Uint8Array

export type JsRow = Record<string, JsValue>

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

interface Base64Methods {
  toBase64?: (options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }) => string
}
interface Base64Statics {
  fromBase64?: (text: string, options?: { alphabet?: "base64" | "base64url" }) => Uint8Array
}

const nativeToBase64 = (Uint8Array.prototype as Base64Methods).toBase64
const nativeFromBase64 = (Uint8Array as unknown as Base64Statics).fromBase64

export function toBase64(bytes: Uint8Array): string {
  if (nativeToBase64) return nativeToBase64.call(bytes)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/")
  const padded =
    normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4))
  if (nativeFromBase64) return nativeFromBase64(padded)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff
  return out
}

/** Thrown when a value cannot cross the boundary; the caller sees it as a `BunQLClientError`. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValueError"
  }
}

function decodeInt(text: string, intMode: IntMode): JsValue {
  if (intMode === "string") return text
  if (intMode === "bigint") return BigInt(text)
  throw new ValueError(
    `${text} does not fit a JavaScript number; open the client with intMode "bigint" or "string"`,
  )
}

/** One value arriving from the server. */
export function decodeValue(value: Value, intMode: IntMode): JsValue {
  if (value === null) return null
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value
    case "object": {
      const tagged = value as unknown as Record<string, unknown>
      if (typeof tagged.$i === "string") return decodeInt(tagged.$i, intMode)
      if (typeof tagged.$b === "string") return fromBase64(tagged.$b)
      if (typeof tagged.$f === "string") {
        if (tagged.$f === "inf") return Number.POSITIVE_INFINITY
        if (tagged.$f === "-inf") return Number.NEGATIVE_INFINITY
        return Number.NaN
      }
      break
    }
    default:
      break
  }
  throw new ValueError(`unrecognised value from the server: ${JSON.stringify(value)}`)
}

/** One value on its way to the server, as a bound parameter. */
export function encodeValue(value: unknown): Value {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      if (Number.isFinite(value)) return value
      if (Number.isNaN(value)) return { $f: "nan" }
      return value > 0 ? { $f: "inf" } : { $f: "-inf" }
    case "bigint":
      return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : { $i: value.toString() }
    case "undefined":
      return null
    case "object": {
      if (value === null) return null
      if (value instanceof Uint8Array) return { $b: toBase64(value) }
      if (value instanceof Date) return value.toISOString()
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView
        return { $b: toBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) }
      }
      if (value instanceof ArrayBuffer) return { $b: toBase64(new Uint8Array(value)) }
      break
    }
    default:
      break
  }
  throw new ValueError(`cannot bind ${JSON.stringify(value) ?? typeof value} as a SQLite value`)
}

/** Positional arguments for a request. */
export function encodeArgs(args: readonly unknown[]): Value[] {
  const out: Value[] = new Array(args.length)
  for (let i = 0; i < args.length; i++) out[i] = encodeValue(args[i])
  return out
}

/** Named arguments for a request; keys keep whatever sigil the caller wrote. */
export function encodeNamed(args: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (const key of Object.keys(args)) out[key] = encodeValue(args[key])
  return out
}

/** Arguments in either shape, as the wire wants them. */
export function encodeAnyArgs(
  args: readonly unknown[] | Record<string, unknown> | undefined | null,
): Value[] | Record<string, Value> | undefined {
  if (args === undefined || args === null) return undefined
  if (Array.isArray(args)) return encodeArgs(args)
  return encodeNamed(args as Record<string, unknown>)
}

export function decodeArrayRow(row: ArrayRow, intMode: IntMode): JsValue[] {
  const out: JsValue[] = new Array(row.length)
  for (let i = 0; i < row.length; i++) out[i] = decodeValue(row[i] as Value, intMode)
  return out
}

export function decodeObjectRow(row: ObjectRow, intMode: IntMode): JsRow {
  const out: JsRow = {}
  for (const key of Object.keys(row)) out[key] = decodeValue(row[key] as Value, intMode)
  return out
}

/** A result set in whichever shape the server sent it. */
export function decodeRows(rows: ResultRows, intMode: IntMode): JsRow[] | JsValue[][] {
  const out: unknown[] = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    out[i] = Array.isArray(row)
      ? decodeArrayRow(row as ArrayRow, intMode)
      : decodeObjectRow(row as ObjectRow, intMode)
  }
  return out as JsRow[] | JsValue[][]
}

/** `lastInsertRowid` is the one scalar outside a row that can be a tagged integer. */
export function decodeRowid(
  value: number | { $i: string } | null,
  intMode: IntMode,
): number | bigint | string | null {
  if (value === null) return null
  if (typeof value === "number") return value
  return decodeInt(value.$i, intMode) as bigint | string
}
