// Invariant: a value a handler returns reaches the wire as the encoding of design §6.1, using the
// *same* leaf encoder BunQL's own routes use. `JSON.stringify` cannot carry a `bigint` — it throws
// — and turns a `Uint8Array` into `{"0":1,"1":2}`, which is silent data loss. Core's `s.int64()`
// and `s.blob()` hand a handler real `bigint` and `Uint8Array` values, so every response that
// carries one has to be walked before it is stringified.
//
// The leaf cases delegate to `encodeValue` in `src/server/json.ts` rather than repeating its
// `{"$i"}` / `{"$b"}` / `{"$f"}` rules. A second copy of those rules is a copy that drifts, and the
// two encoders answering differently for the same row is exactly the divergence this design
// exists to prevent.
//
// A value that needs nothing is handed back by reference: `encode` returns its own argument when
// no leaf under it changed, so the common response — plain JSON already — is not copied.

import { encodeValue } from "../server/json.ts"

/**
 * `value` with every `bigint`, byte array and non-finite double rewritten into its wire form.
 * The argument is never mutated; an untouched subtree is returned by reference.
 */
export function encode(value: unknown): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "bigint":
      return encodeValue(value)
    case "number":
      return Number.isFinite(value) ? value : encodeValue(value)
    case "object":
      break
    default:
      // `undefined`, a function, a symbol — what `JSON.stringify` drops from an object and turns
      // into `null` in an array. Leaving them alone keeps that behaviour.
      return value
  }
  if (value === null) return null
  if (value instanceof Uint8Array) return encodeValue(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return encodeValue(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  }
  if (value instanceof ArrayBuffer) return encodeValue(new Uint8Array(value))
  const custom = (value as { toJSON?: unknown }).toJSON
  // A `Date`, and anything else that already says how it wants to be JSON. Encoding the result
  // rather than returning it keeps a `toJSON` that yields a bigint honest.
  if (typeof custom === "function") return encode((custom as () => unknown).call(value))
  if (Array.isArray(value)) return encodeArray(value)
  return encodeObject(value as Record<string, unknown>)
}

function encodeArray(list: unknown[]): unknown[] {
  let out: unknown[] | null = null
  for (let i = 0; i < list.length; i++) {
    const got = encode(list[i])
    if (out) out[i] = got
    else if (got !== list[i]) {
      out = list.slice(0, i)
      out[i] = got
    }
  }
  return out ?? list
}

function encodeObject(source: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null
  const keys = Object.keys(source)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string
    const got = encode(source[key])
    if (out) out[key] = got
    else if (got !== source[key]) {
      out = {}
      for (let j = 0; j < i; j++) out[keys[j] as string] = source[keys[j] as string]
      out[key] = got
    }
  }
  return out ?? source
}

/** The encoded value as a JSON string, which is what a response body actually needs. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(encode(value)) ?? "null"
}
