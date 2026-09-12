// Invariant: this is an interpreter over the published JSON Schema tree and nothing else, so what
// it accepts is exactly what `src/openapi/` says the API accepts. It reads the same object the
// document is emitted from (`schema.ts`), which is why the two cannot drift.
//
// No exceptions on the hot path: a failure is a returned `{ ok: false, problems }`, and problems
// are collected up to `maxProblems` rather than thrown at the first one, because a query string
// with three mistakes should report three. `path` is a dotted path — `"user.tags.0"` — with `""`
// for the root.
//
// The returned value is always new: defaults are filled in, `{"$i"}` and `{"$b"}` are decoded,
// and the caller's input is never mutated. That last one matters because the HTTP layer hands us
// the parsed body and then logs it.
//
// `coerce` is for values that arrived as text — path and query parameters. It parses a string
// according to the node's own schema (`"12"` for an `integer`, `"true"` for a `boolean`) and
// leaves everything else alone; it never guesses, so `"banana"` for an integer is a problem and
// not a `NaN`. Decoding the tagged encodings of design §6.1 is *not* conditional on `coerce`:
// `{"$i": "…"}` is the wire form of an int64 in a JSON body, so a node built by `s.int64()` always
// yields a `number | bigint` and `s.blob()` always yields a `Uint8Array`.
//
// The `CODEC` mark is consulted *after* the nullability check, and that order is load-bearing. A
// decoder knows only its own tagged form, so handing it the `null` that `.nullable()` published
// would have it refuse a value the document promises to accept — the document and the validator
// disagreeing about what the API accepts, which is the one thing this design exists to prevent.
// A nullable INTEGER or BLOB column is completely ordinary, so the data API meets this on the
// first row. Nullability is settled against `type` and the `anyOf` branches, the same keywords a
// client reads, so the two answers come from one object as they must.
//
// `format` stays an annotation, as draft 2020-12 specifies. It is published for clients and not
// enforced here; a half-right email regular expression rejecting real addresses would be worse
// than the document simply saying what the field means.
//
// Keywords understood: `$ref` (by name, resolved against the root's `.id()` schemas), `type`,
// `enum`, `const`, `anyOf`, `oneOf`, `allOf`, `not`, `properties`, `required`,
// `additionalProperties`, `items`, `minItems`, `maxItems`, `uniqueItems`, `minLength`,
// `maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
// `multipleOf` and `default`. Anything else is an annotation and is ignored.

import {
  codecOf,
  collectNamed,
  cloneValue,
  keyword,
  type Infer,
  type JsonSchemaNode,
  type JsonSchemaType,
  type Schema,
} from "./schema.ts"

export interface Problem {
  /** Dotted path to the offending value; `""` is the root. */
  path: string
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; problems: Problem[] }

export interface ValidateOptions {
  /** Parse strings according to the node's schema, for path and query parameters. */
  coerce?: boolean
  /** Stop collecting after this many problems. Default 20. */
  maxProblems?: number
}

const INVALID = Symbol("bunql.validate.invalid")
type Outcome = unknown | typeof INVALID

const INT_TEXT = /^[+-]?[0-9]+$/
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const patterns = new Map<string, RegExp>()

class Run {
  readonly problems: Problem[] = []
  #named: Map<string, Schema> | null = null

  constructor(
    readonly root: JsonSchemaNode,
    readonly coerce: boolean,
    readonly maxProblems: number,
  ) {}

  fail(path: string, message: string): typeof INVALID {
    if (this.problems.length < this.maxProblems) this.problems.push({ path, message })
    return INVALID
  }

  get full(): boolean {
    return this.problems.length >= this.maxProblems
  }

  resolve(name: string): JsonSchemaNode | undefined {
    this.#named ??= collectNamed(this.root as Schema)
    return this.#named.get(name) as JsonSchemaNode | undefined
  }
}

/**
 * Checks `value` against `schema`, returning either the typed value or the problems with it.
 * Never throws for bad input; a throw from here is a bug in the schema, not in the request.
 */
export function validate<S extends Schema>(
  schema: S,
  value: unknown,
  options: ValidateOptions = {},
): Result<Infer<S>> {
  const run = new Run(schema as JsonSchemaNode, options.coerce === true, options.maxProblems ?? 20)
  const out = walk(schema as JsonSchemaNode, value, "", run)
  if (out === INVALID || run.problems.length > 0) return { ok: false, problems: run.problems }
  return { ok: true, value: out as Infer<S> }
}

function walk(schema: JsonSchemaNode, value: unknown, path: string, run: Run): Outcome {
  const reference = keyword<string>(schema, "$ref")
  if (typeof reference === "string") {
    const target = run.resolve(reference)
    if (!target) return run.fail(path, `refers to the unknown schema "${reference}"`)
    return walk(target, value, path, run)
  }

  const codec = codecOf(schema)
  if (codec !== undefined) {
    // Nullability is settled against the published keywords before the codec is consulted: a
    // decoder only knows its own tagged form and would refuse the `null` the document promises.
    if (value === null && admitsNull(schema)) return null
    if (codec === "int64") return decodeInt64(value, path, run)
    if (codec === "blob") return decodeBlob(value, path, run)
    if (codec === "sqlite") return decodeSqliteValue(value, path, run)
  }

  const types = typeList(schema)
  const coerced = run.coerce ? coerceScalar(types, value) : value

  if (types.length > 0 && !matchesType(types, coerced)) {
    return run.fail(path, `expected ${article(types)}, got ${describe(coerced)}`)
  }

  if (Object.hasOwn(schema, "const") && !sameValue(schema.const, coerced)) {
    return run.fail(path, `must be ${JSON.stringify(schema.const)}`)
  }
  const members = keyword<unknown[]>(schema, "enum")
  if (Array.isArray(members) && !members.some((m) => sameValue(m, coerced))) {
    return run.fail(path, `must be one of ${members.map((m) => JSON.stringify(m)).join(", ")}`)
  }

  const branches =
    keyword<JsonSchemaNode[]>(schema, "anyOf") ?? keyword<JsonSchemaNode[]>(schema, "oneOf")
  if (Array.isArray(branches)) {
    const picked = firstMatch(branches, coerced, path, run)
    if (picked === INVALID) {
      return run.fail(path, `does not match any of the ${branches.length} accepted shapes`)
    }
    return picked
  }

  const every = keyword<JsonSchemaNode[]>(schema, "allOf")
  if (Array.isArray(every)) {
    let threaded: unknown = coerced
    for (const member of every) {
      const next = walk(member, threaded, path, run)
      if (next === INVALID) return INVALID
      threaded = next
    }
    return threaded
  }

  const excluded = keyword<JsonSchemaNode>(schema, "not")
  if (excluded) {
    const scratch = new Run(run.root, run.coerce, 1)
    if (walk(excluded, coerced, path, scratch) !== INVALID) {
      return run.fail(path, "matches a shape this schema excludes")
    }
  }

  if (typeof coerced === "string") return checkString(schema, coerced, path, run)
  if (typeof coerced === "number" || typeof coerced === "bigint") {
    return checkNumber(schema, coerced, path, run)
  }
  if (Array.isArray(coerced)) return walkArray(schema, coerced, path, run)
  if (isPlainObject(coerced)) return walkObject(schema, coerced, path, run)
  return coerced
}

/** The first branch that accepts the value, with that branch's own coercion and decoding. */
function firstMatch(
  branches: JsonSchemaNode[],
  value: unknown,
  path: string,
  run: Run,
): Outcome {
  for (const branch of branches) {
    const scratch = new Run(run.root, run.coerce, 1)
    const out = walk(branch, value, path, scratch)
    if (out !== INVALID && scratch.problems.length === 0) return out
  }
  return INVALID
}

function walkObject(
  schema: JsonSchemaNode,
  value: Record<string, unknown>,
  path: string,
  run: Run,
): Outcome {
  const props = keyword<Record<string, JsonSchemaNode>>(schema, "properties")
  const required = keyword<string[]>(schema, "required")
  const additional = keyword(schema, "additionalProperties")
  const out: Record<string, unknown> = {}
  let bad = false

  if (props) {
    for (const key of Object.keys(props)) {
      const child = props[key] as JsonSchemaNode
      const raw = Object.hasOwn(value, key) ? value[key] : undefined
      if (raw === undefined) {
        if (Object.hasOwn(child, "default")) {
          out[key] = cloneValue(child.default)
        } else if (required?.includes(key)) {
          run.fail(join(path, key), "is required")
          bad = true
        }
        continue
      }
      const got = walk(child, raw, join(path, key), run)
      if (got === INVALID) bad = true
      else out[key] = got
      if (run.full) return INVALID
    }
  }

  for (const key of Object.keys(value)) {
    if (props && Object.hasOwn(props, key)) continue
    if (additional === false) {
      run.fail(join(path, key), "is not allowed here")
      bad = true
      continue
    }
    if (isPlainObject(additional)) {
      const got = walk(additional as JsonSchemaNode, value[key], join(path, key), run)
      if (got === INVALID) bad = true
      else out[key] = got
      continue
    }
    out[key] = value[key]
  }

  // A `required` name with no `properties` entry still has to be present.
  if (required) {
    for (const key of required) {
      if (props && Object.hasOwn(props, key)) continue
      if (Object.hasOwn(value, key)) continue
      run.fail(join(path, key), "is required")
      bad = true
    }
  }

  return bad ? INVALID : out
}

function walkArray(schema: JsonSchemaNode, value: unknown[], path: string, run: Run): Outcome {
  let bad = false
  const min = numberKeyword(schema, "minItems")
  if (min !== undefined && value.length < min) {
    run.fail(path, `must have at least ${min} item${min === 1 ? "" : "s"}`)
    bad = true
  }
  const max = numberKeyword(schema, "maxItems")
  if (max !== undefined && value.length > max) {
    run.fail(path, `must have at most ${max} item${max === 1 ? "" : "s"}`)
    bad = true
  }
  if (keyword(schema, "uniqueItems") === true) {
    const seen = new Set<string>()
    for (const item of value) {
      const key = JSON.stringify(item) ?? "undefined"
      if (seen.has(key)) {
        run.fail(path, "must not repeat an item")
        bad = true
        break
      }
      seen.add(key)
    }
  }
  const items = keyword<JsonSchemaNode>(schema, "items")
  if (!items) return bad ? INVALID : [...value]
  const out: unknown[] = new Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const got = walk(items, value[i], join(path, i), run)
    if (got === INVALID) bad = true
    else out[i] = got
    if (run.full) return INVALID
  }
  return bad ? INVALID : out
}

function checkString(schema: JsonSchemaNode, value: string, path: string, run: Run): Outcome {
  let bad = false
  const min = numberKeyword(schema, "minLength")
  if (min !== undefined && codePoints(value) < min) {
    run.fail(path, `must be at least ${min} character${min === 1 ? "" : "s"}`)
    bad = true
  }
  const max = numberKeyword(schema, "maxLength")
  if (max !== undefined && codePoints(value) > max) {
    run.fail(path, `must be at most ${max} character${max === 1 ? "" : "s"}`)
    bad = true
  }
  const source = keyword<string>(schema, "pattern")
  if (typeof source === "string" && !regexp(source).test(value)) {
    run.fail(path, `must match ${source}`)
    bad = true
  }
  return bad ? INVALID : value
}

function checkNumber(
  schema: JsonSchemaNode,
  value: number | bigint,
  path: string,
  run: Run,
): Outcome {
  let bad = false
  const n = typeof value === "bigint" ? Number(value) : value
  const minimum = keyword<number>(schema, "minimum")
  if (typeof minimum === "number" && n < minimum) {
    run.fail(path, `must be at least ${minimum}`)
    bad = true
  }
  const maximum = keyword<number>(schema, "maximum")
  if (typeof maximum === "number" && n > maximum) {
    run.fail(path, `must be at most ${maximum}`)
    bad = true
  }
  const exclusiveMinimum = keyword<number>(schema, "exclusiveMinimum")
  if (typeof exclusiveMinimum === "number" && n <= exclusiveMinimum) {
    run.fail(path, `must be greater than ${exclusiveMinimum}`)
    bad = true
  }
  const exclusiveMaximum = keyword<number>(schema, "exclusiveMaximum")
  if (typeof exclusiveMaximum === "number" && n >= exclusiveMaximum) {
    run.fail(path, `must be less than ${exclusiveMaximum}`)
    bad = true
  }
  const step = numberKeyword(schema, "multipleOf")
  if (step !== undefined && step > 0 && !isMultipleOf(n, step)) {
    run.fail(path, `must be a multiple of ${step}`)
    bad = true
  }
  return bad ? INVALID : value
}

// ── the encodings of design §6.1 ───────────────────────────────────────────────────────────────

function decodeInt64(value: unknown, path: string, run: Run): Outcome {
  if (typeof value === "bigint") return value
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return run.fail(path, `expected an integer, got ${describe(value)}`)
    return value
  }
  const text = intText(value, run.coerce)
  if (text === undefined) {
    return run.fail(path, `expected an integer or {"$i": "<decimal>"}, got ${describe(value)}`)
  }
  if (!INT_TEXT.test(text)) return run.fail(path, `"${text}" is not an integer`)
  return narrow(BigInt(text))
}

function intText(value: unknown, coerce: boolean): string | undefined {
  if (coerce && typeof value === "string") return value
  if (!isPlainObject(value)) return undefined
  const tag = value.$i
  return typeof tag === "string" ? tag : undefined
}

function decodeBlob(value: unknown, path: string, run: Run): Outcome {
  if (value instanceof Uint8Array) return value
  const text = run.coerce && typeof value === "string" ? value : blobText(value)
  if (text === undefined) {
    return run.fail(path, `expected {"$b": "<base64>"}, got ${describe(value)}`)
  }
  const bytes = fromBase64(text)
  if (!bytes) return run.fail(path, "is not valid base64")
  return bytes
}

function blobText(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined
  const tag = value.$b
  return typeof tag === "string" ? tag : undefined
}

function decodeSqliteValue(value: unknown, path: string, run: Run): Outcome {
  if (value === null) return null
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
      return value
    // SQLite has no boolean storage class; the write path binds one as 0 or 1, so the document
    // accepts it and this hands back what will actually be stored.
    case "boolean":
      return value ? 1 : 0
    case "object": {
      if (value instanceof Uint8Array) return value
      if (isPlainObject(value)) {
        if (typeof value.$i === "string") {
          return INT_TEXT.test(value.$i) ? narrow(BigInt(value.$i)) : run.fail(path, `"${value.$i}" is not an integer`)
        }
        if (typeof value.$b === "string") {
          const bytes = fromBase64(value.$b)
          return bytes ?? run.fail(path, "is not valid base64")
        }
        if (typeof value.$f === "string") {
          if (value.$f === "inf") return Number.POSITIVE_INFINITY
          if (value.$f === "-inf") return Number.NEGATIVE_INFINITY
          if (value.$f === "nan") return Number.NaN
        }
      }
      break
    }
    default:
      break
  }
  return run.fail(path, `is not a SQLite value: ${describe(value)}`)
}

function narrow(value: bigint): number | bigint {
  return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value
}

/** Standard-alphabet base64, using only globals the browser and Bun both have. */
function fromBase64(text: string): Uint8Array | undefined {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/")
  const padded =
    normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4))
  try {
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff
    return out
  } catch {
    return undefined
  }
}

// ── coercion and type checking ─────────────────────────────────────────────────────────────────

/**
 * Whether the node's own published schema admits `null`, read off the keywords a client reads —
 * `type`, or a branch of `anyOf`/`oneOf` — so the answer cannot differ from the document's.
 */
function admitsNull(schema: JsonSchemaNode): boolean {
  const type = keyword<JsonSchemaType | JsonSchemaType[]>(schema, "type")
  if (type === "null") return true
  if (Array.isArray(type) && type.includes("null")) return true
  const branches =
    keyword<JsonSchemaNode[]>(schema, "anyOf") ?? keyword<JsonSchemaNode[]>(schema, "oneOf")
  return Array.isArray(branches) && branches.some(admitsNull)
}

function typeList(schema: JsonSchemaNode): JsonSchemaType[] {
  const type = keyword<JsonSchemaType | JsonSchemaType[]>(schema, "type")
  if (typeof type === "string") return [type]
  if (Array.isArray(type)) return type as JsonSchemaType[]
  return []
}

/** Parses a string per the node's own type. Anything it cannot parse is left for the type check. */
function coerceScalar(types: JsonSchemaType[], value: unknown): unknown {
  if (typeof value !== "string" || types.length === 0) return value
  if (types.includes("string")) return value
  if (types.includes("integer") && INT_TEXT.test(value)) return narrow(BigInt(value))
  if (types.includes("number") && value.trim() !== "") {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  if (types.includes("boolean")) {
    if (value === "true" || value === "1") return true
    if (value === "false" || value === "0") return false
  }
  return value
}

function matchesType(types: JsonSchemaType[], value: unknown): boolean {
  for (const type of types) {
    switch (type) {
      case "null":
        if (value === null) return true
        break
      case "string":
        if (typeof value === "string") return true
        break
      case "boolean":
        if (typeof value === "boolean") return true
        break
      case "integer":
        if (typeof value === "bigint") return true
        if (typeof value === "number" && Number.isInteger(value)) return true
        break
      case "number":
        if (typeof value === "bigint") return true
        if (typeof value === "number" && Number.isFinite(value)) return true
        break
      case "array":
        if (Array.isArray(value)) return true
        break
      case "object":
        if (isPlainObject(value)) return true
        break
    }
  }
  return false
}

function article(types: JsonSchemaType[]): string {
  const names = types.map((t) => (t === "integer" || t === "object" || t === "array" ? `an ${t}` : `a ${t}`))
  if (names.length === 1) return names[0] as string
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "nothing"
  if (Array.isArray(value)) return "an array"
  if (value instanceof Uint8Array) return "bytes"
  switch (typeof value) {
    case "string":
      return `a string`
    case "number":
      return Number.isFinite(value) ? "a number" : String(value)
    case "bigint":
      return "an integer"
    case "boolean":
      return "a boolean"
    default:
      return "an object"
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === "bigint" || typeof b === "bigint") {
    const left = typeof a === "bigint" ? a : typeof a === "number" && Number.isInteger(a) ? BigInt(a) : undefined
    const right = typeof b === "bigint" ? b : typeof b === "number" && Number.isInteger(b) ? BigInt(b) : undefined
    return left !== undefined && right !== undefined && left === right
  }
  return false
}

function numberKeyword(schema: JsonSchemaNode, name: string): number | undefined {
  const value = keyword(schema, name)
  return typeof value === "number" ? value : undefined
}

function regexp(source: string): RegExp {
  let compiled = patterns.get(source)
  if (!compiled) {
    compiled = new RegExp(source, "u")
    patterns.set(source, compiled)
  }
  return compiled
}

function isMultipleOf(value: number, step: number): boolean {
  const ratio = value / step
  return Number.isFinite(ratio) && Math.abs(ratio - Math.round(ratio)) < 1e-9
}

/** JSON Schema counts string length in code points, not UTF-16 code units. */
function codePoints(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    n++
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) i++
  }
  return n
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  )
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`
}
