// Invariant: a value crossing this codec keeps its SQLite storage class wherever the storage
// class survived the trip out of `exec.ts` at all. That qualifier is the whole story of this
// module: the driver hands back a JS `number` for both `SQLITE_INTEGER` and `SQLITE_FLOAT`, so
// INTEGER and REAL are told apart by the column's declared affinity first and by
// `Number.isInteger` second. Everything else — text, blobs, nulls, integers past 2^53 — is exact,
// because those arrive as `string`, `{$b}` and `{$i}` and carry their own type.
//
// Inbound arguments reuse `decodeArg` from `../json.ts`, which already understands the Hrana
// `{type, value}` shape; only `named_args` needs unpacking here.

import type { Args, IntValue, Value } from "../../client/protocol.ts"
import { BunQLError } from "../errors.ts"
import { toBase64 } from "../json.ts"
import type { HranaNamedArg, HranaStmt, HranaValue } from "./proto.ts"

const NULL_VALUE: HranaValue = { type: "null" }

/**
 * SQLite's own REAL-affinity test (datatype3.html §3.1 rule 2): a declared type containing REAL,
 * FLOA or DOUB has REAL affinity, whatever else it says. `encodeRows` upper-cases the declared
 * type before we see it, and falls back to the storage class of the first non-null cell, so an
 * expression column only reports REAL when a non-integral value actually appeared in it.
 */
export function isFloatColumn(declared: string | undefined): boolean {
  if (!declared) return false
  return declared.includes("REAL") || declared.includes("FLOA") || declared.includes("DOUB")
}

/**
 * One BunQL wire value as a Hrana value. `float` is chosen when the column has REAL affinity or
 * the number is not an integer; a non-finite double is left as the raw number, which
 * `JSON.stringify` writes as `null` — the same thing serde_json does on libsql-server.
 */
export function toHranaValue(value: Value, float: boolean): HranaValue {
  switch (typeof value) {
    case "string":
      return { type: "text", value }
    case "number":
      if (!Number.isFinite(value)) return { type: "float", value }
      return float || !Number.isInteger(value)
        ? { type: "float", value }
        : { type: "integer", value: value.toFixed(0) }
    case "boolean":
      return { type: "integer", value: value ? "1" : "0" }
    case "bigint":
      return { type: "integer", value: (value as bigint).toString() }
    case "object": {
      if (value === null) return NULL_VALUE
      const tagged = value as IntValue & { $b?: string; $f?: string }
      if (typeof tagged.$i === "string") return { type: "integer", value: tagged.$i }
      if (typeof tagged.$b === "string") return { type: "blob", base64: tagged.$b }
      if (typeof tagged.$f === "string") {
        return { type: "float", value: tagged.$f === "nan" ? Number.NaN : tagged.$f === "-inf" ? -Infinity : Infinity }
      }
      if (value instanceof Uint8Array) return { type: "blob", base64: toBase64(value) }
      break
    }
    default:
      break
  }
  throw new BunQLError("INTERNAL", "unencodable value on the Hrana path", 500)
}

/** `last_insert_rowid` and `replication_index`: decimal text, or null. */
export function toDecimalString(value: number | IntValue | bigint | null): string | null {
  if (value === null) return null
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number") return value.toFixed(0)
  return value.$i
}

/**
 * The arguments of a Hrana statement as BunQL `Args`. Positional and named are mutually exclusive
 * on the wire; a request that sends both is refused rather than silently losing one, because
 * binding half a statement's parameters is the kind of failure that shows up as wrong data.
 */
export function argsOf(stmt: HranaStmt): Args | undefined {
  const positional = stmt.args
  const named = stmt.named_args
  const hasPositional = Array.isArray(positional) && positional.length > 0
  const hasNamed = Array.isArray(named) && named.length > 0
  if (hasPositional && hasNamed) {
    throw BunQLError.badRequest("a statement may have args or named_args, not both")
  }
  if (hasNamed) {
    const out: Record<string, Value> = {}
    for (const arg of named as HranaNamedArg[]) {
      if (!arg || typeof arg.name !== "string") {
        throw BunQLError.badRequest("every named_args entry needs a name")
      }
      // `decodeArg` in ../json.ts reads the Hrana `{type, value}` shape directly, so the value is
      // passed through untouched and decoded once, at bind time.
      out[arg.name] = arg.value as unknown as Value
    }
    return out
  }
  if (hasPositional) return positional as unknown as Value[]
  return undefined
}
