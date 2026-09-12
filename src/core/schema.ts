// Invariant: a schema node *is* a JSON Schema object — draft 2020-12, the dialect OpenAPI 3.1
// uses — carrying a phantom type parameter for TypeScript. `toJsonSchema()` is therefore the
// identity function modulo a prototype, and `validate()` is an interpreter over the very same
// tree the OpenAPI document publishes. The validator and the document cannot disagree about what
// an operation accepts, because there is one object rather than two descriptions of it
// (`docs/plan-surfaces.md`, "src/core/ — the schema, and why it is a JSON Schema node").
//
// Nothing here may be mutated: every builder copies the node's own keys onto a fresh object over
// a shared prototype and freezes it. The chaining methods therefore live on that prototype and
// are never own properties, so `JSON.stringify(node)` emits the JSON Schema keywords and nothing
// else.
//
// The cost of that trick, and the reason `toJsonSchema()` copies rather than returns its
// argument: on a live node, a keyword the node does *not* carry resolves to the builder method of
// the same name, so `node.minLength` is a function rather than `undefined`. Read keywords off the
// result of `toJsonSchema()`, or guard every read by type as this module and `validate.ts` do.
//
// Two things ride on symbol keys, which `JSON.stringify`, `Object.keys` and any copy of a
// published document ignore, so they cost the document nothing:
//
//   OPTIONAL  `.optional()` is a statement about the *parent*: JSON Schema puts requiredness in
//             the parent's `required` array, not in the child. The child carries the mark until
//             `s.object()` reads it and writes `required`. `.nullable()` is the different thing
//             that widens the child's own type, and an OpenAPI client cares about the difference.
//   CODEC     the wire encoding of `s.int64()`, `s.blob()` and `s.sqliteValue()` (design §6.1).
//             The `anyOf` those emit is the honest published form; the mark is how the validator
//             knows to hand back a `bigint` or a `Uint8Array` rather than the tagged object.
//
// A node with a `default` is left out of its parent's `required` — a value that need not be sent
// is not required — but stays non-optional in the inferred type, because validation fills it in
// and the caller always sees it.
//
// `JsonSchemaNode` names every keyword it can, but not `minLength`, `maxLength`, `pattern`,
// `format`, `minItems`, `maxItems`, `uniqueItems`, `multipleOf` or `deprecated`: the builders
// hang methods of exactly those names off the node and one name cannot be both a `number` and a
// `(n) => Schema`. They travel under the index signature, which is also what carries OpenAPI's
// `x-` extensions and any keyword this file has not heard of.

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null"

/** One JSON Schema (draft 2020-12) object. */
export interface JsonSchemaNode {
  $id?: string
  /** A bare name, not a URI: `src/openapi/` rewrites it to `#/components/schemas/<name>`. */
  $ref?: string
  $comment?: string
  $defs?: Record<string, JsonSchemaNode>
  type?: JsonSchemaType | JsonSchemaType[]
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
  not?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean | JsonSchemaNode
  items?: JsonSchemaNode
  prefixItems?: JsonSchemaNode[]
  contains?: JsonSchemaNode
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  contentEncoding?: string
  contentMediaType?: string
  title?: string
  description?: string
  default?: unknown
  examples?: unknown[]
  readOnly?: boolean
  writeOnly?: boolean
  [keyword: string]: unknown
}

/** A JSON Schema node that also says, at the type level, what it describes. */
export type Schema<T = unknown> = JsonSchemaNode & { readonly __type?: T }

/** The TypeScript type a schema describes. */
export type Infer<S> = S extends Schema<infer T> ? T : never

/** Flattens an intersection so editors show one object rather than `A & B`. */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

export type Props = Record<string, Schema<any>>

type OptionalKeys<P> = {
  [K in keyof P]: P[K] extends { readonly __optional: true } ? K : never
}[keyof P]

/** `{ a: s.string().optional() }` → `{ a?: string }`; `.nullable()` → `{ a: string | null }`. */
export type InferProps<P> = Simplify<
  { [K in Exclude<keyof P, OptionalKeys<P>>]: Infer<P[K]> } & {
    [K in OptionalKeys<P>]?: Infer<P[K]>
  }
>

/** A node whose parent leaves it out of `required`. The mark is a type-level phantom. */
export interface OptionalSchema<T = unknown> extends Schema<T> {
  readonly __optional: true
  default(value: T): OptionalSchema<T>
  describe(text: string): OptionalSchema<T>
  example(value: T): OptionalSchema<T>
  deprecated(): OptionalSchema<T>
  id(name: string): OptionalSchema<T>
  optional(): OptionalSchema<T>
  nullable(): OptionalSchema<T | null>
}

/** Any node without constraints of its own: unions, records, literals, the encoded values. */
export interface SchemaNode<T = unknown> extends Schema<T> {
  default(value: T): SchemaNode<T>
  describe(text: string): SchemaNode<T>
  example(value: T): SchemaNode<T>
  deprecated(): SchemaNode<T>
  id(name: string): SchemaNode<T>
  optional(): OptionalSchema<T>
  nullable(): SchemaNode<T | null>
}

export interface StringSchema<T extends string | null = string> extends Schema<T> {
  minLength(n: number): StringSchema<T>
  maxLength(n: number): StringSchema<T>
  pattern(re: string | RegExp): StringSchema<T>
  format(name: string): StringSchema<T>
  default(value: T): StringSchema<T>
  describe(text: string): StringSchema<T>
  example(value: T): StringSchema<T>
  deprecated(): StringSchema<T>
  id(name: string): StringSchema<T>
  optional(): OptionalSchema<T>
  nullable(): StringSchema<T | null>
}

export interface NumberSchema<T extends number | null = number> extends Schema<T> {
  min(n: number): NumberSchema<T>
  max(n: number): NumberSchema<T>
  multipleOf(n: number): NumberSchema<T>
  default(value: T): NumberSchema<T>
  describe(text: string): NumberSchema<T>
  example(value: T): NumberSchema<T>
  deprecated(): NumberSchema<T>
  id(name: string): NumberSchema<T>
  optional(): OptionalSchema<T>
  nullable(): NumberSchema<T | null>
}

export interface ArraySchema<E> extends Schema<E[]> {
  minItems(n: number): ArraySchema<E>
  maxItems(n: number): ArraySchema<E>
  uniqueItems(): ArraySchema<E>
  default(value: E[]): ArraySchema<E>
  describe(text: string): ArraySchema<E>
  example(value: E[]): ArraySchema<E>
  deprecated(): ArraySchema<E>
  id(name: string): ArraySchema<E>
  optional(): OptionalSchema<E[]>
  nullable(): SchemaNode<E[] | null>
}

export interface ObjectSchema<P = Props> extends Schema<InferProps<P>> {
  /** `additionalProperties: false`. */
  strict(): ObjectSchema<P>
  /** Drops `additionalProperties`, which is JSON Schema's own default. */
  passthrough(): ObjectSchema<P>
  partial(): ObjectSchema<{ [K in keyof P]: OptionalSchema<Infer<P[K]>> }>
  extend<Q extends Props>(props: Q): ObjectSchema<Simplify<Omit<P, keyof Q> & Q>>
  pick<K extends keyof P>(keys: readonly K[]): ObjectSchema<Pick<P, K>>
  omit<K extends keyof P>(keys: readonly K[]): ObjectSchema<Omit<P, K>>
  default(value: InferProps<P>): ObjectSchema<P>
  describe(text: string): ObjectSchema<P>
  example(value: InferProps<P>): ObjectSchema<P>
  deprecated(): ObjectSchema<P>
  id(name: string): ObjectSchema<P>
  optional(): OptionalSchema<InferProps<P>>
  nullable(): SchemaNode<InferProps<P> | null>
}

export type EnumMember = string | number | boolean | null

/** How a node's values are encoded on the wire, for the three that are not plain JSON. */
export type Codec = "int64" | "blob" | "sqlite"

const OPTIONAL = Symbol("bunql.schema.optional")
const CODEC = Symbol("bunql.schema.codec")

/** The `{"$i": "<decimal>"}` of design §6.1, as a JSON Schema branch. */
const INT_TAG: JsonSchemaNode = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    $i: Object.freeze({ type: "string" as const, pattern: "^[+-]?[0-9]+$" }),
  }),
  required: Object.freeze(["$i"]) as unknown as string[],
  additionalProperties: false,
})

const BLOB_TAG: JsonSchemaNode = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    $b: Object.freeze({ type: "string" as const, contentEncoding: "base64" }),
  }),
  required: Object.freeze(["$b"]) as unknown as string[],
  additionalProperties: false,
})

const FLOAT_TAG: JsonSchemaNode = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    $f: Object.freeze({ enum: Object.freeze(["inf", "-inf", "nan"]) as unknown as unknown[] }),
  }),
  required: Object.freeze(["$f"]) as unknown as string[],
  additionalProperties: false,
})

const proto = {
  minLength(this: JsonSchemaNode, n: number) {
    return derive(this, { minLength: n })
  },
  maxLength(this: JsonSchemaNode, n: number) {
    return derive(this, { maxLength: n })
  },
  pattern(this: JsonSchemaNode, re: string | RegExp) {
    return derive(this, { pattern: typeof re === "string" ? re : re.source })
  },
  format(this: JsonSchemaNode, name: string) {
    return derive(this, { format: name })
  },
  min(this: JsonSchemaNode, n: number) {
    return derive(this, { minimum: n })
  },
  max(this: JsonSchemaNode, n: number) {
    return derive(this, { maximum: n })
  },
  multipleOf(this: JsonSchemaNode, n: number) {
    return derive(this, { multipleOf: n })
  },
  minItems(this: JsonSchemaNode, n: number) {
    return derive(this, { minItems: n })
  },
  maxItems(this: JsonSchemaNode, n: number) {
    return derive(this, { maxItems: n })
  },
  uniqueItems(this: JsonSchemaNode) {
    return derive(this, { uniqueItems: true })
  },

  strict(this: JsonSchemaNode) {
    return derive(this, { additionalProperties: false })
  },
  passthrough(this: JsonSchemaNode) {
    return derive(this, { additionalProperties: undefined })
  },
  partial(this: JsonSchemaNode) {
    const props = ownProperties(this)
    if (!props) return derive(this, { required: undefined })
    const next: Record<string, JsonSchemaNode> = {}
    for (const key of Object.keys(props)) next[key] = markOptional(props[key] as JsonSchemaNode)
    return derive(this, { properties: Object.freeze(next), required: undefined })
  },
  extend(this: JsonSchemaNode, props: Record<string, JsonSchemaNode>) {
    return withProperties(this, { ...(ownProperties(this) ?? {}), ...props })
  },
  pick(this: JsonSchemaNode, keys: readonly string[]) {
    const props = ownProperties(this) ?? {}
    const next: Record<string, JsonSchemaNode> = {}
    for (const key of keys) if (key in props) next[key] = props[key] as JsonSchemaNode
    return withProperties(this, next)
  },
  omit(this: JsonSchemaNode, keys: readonly string[]) {
    const drop = new Set(keys)
    const props = ownProperties(this) ?? {}
    const next: Record<string, JsonSchemaNode> = {}
    for (const key of Object.keys(props)) {
      if (!drop.has(key)) next[key] = props[key] as JsonSchemaNode
    }
    return withProperties(this, next)
  },

  default(this: JsonSchemaNode, value: unknown) {
    return derive(this, { default: value })
  },
  describe(this: JsonSchemaNode, text: string) {
    return derive(this, { description: text })
  },
  example(this: JsonSchemaNode, value: unknown) {
    const had = Object.hasOwn(this, "examples") ? (this.examples as unknown[]) : []
    return derive(this, { examples: Object.freeze([...had, value]) })
  },
  deprecated(this: JsonSchemaNode) {
    return derive(this, { deprecated: true })
  },
  id(this: JsonSchemaNode, name: string) {
    return derive(this, { $id: name })
  },
  optional(this: JsonSchemaNode) {
    return markOptional(this)
  },
  nullable(this: JsonSchemaNode) {
    return withNull(this)
  },
}

function node(source: object): JsonSchemaNode {
  return Object.freeze(Object.assign(Object.create(proto), source)) as JsonSchemaNode
}

/** A copy of `from` with `patch` applied; an `undefined` in `patch` removes the keyword. */
function derive(from: JsonSchemaNode, patch: Record<string, unknown>): JsonSchemaNode {
  const next: Record<string, unknown> = { ...from }
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return node(next)
}

function ownProperties(from: JsonSchemaNode): Record<string, JsonSchemaNode> | undefined {
  return Object.hasOwn(from, "properties")
    ? (from.properties as Record<string, JsonSchemaNode>)
    : undefined
}

function markOptional(from: JsonSchemaNode): JsonSchemaNode {
  return node({ ...from, [OPTIONAL]: true })
}

/** True when `.optional()` marked this node, which is what keeps it out of a parent's `required`. */
export function isOptional(schema: Schema<any>): boolean {
  return (schema as Record<symbol, unknown>)[OPTIONAL] === true
}

/** The wire encoding of a node's values, for the three that JSON cannot carry plainly. */
export function codecOf(schema: JsonSchemaNode): Codec | undefined {
  return (schema as Record<symbol, unknown>)[CODEC] as Codec | undefined
}

function tagged(source: JsonSchemaNode, codec: Codec): JsonSchemaNode {
  return node({ ...source, [CODEC]: codec })
}

/**
 * Widens a node to accept `null`. A `type` grows into a list, an `anyOf` gets a branch, and an
 * `enum` or `const` has to gain the member as well or it would reject the null it now admits.
 */
function withNull(from: JsonSchemaNode): JsonSchemaNode {
  const next: Record<string, unknown> = { ...from }
  if (Object.hasOwn(from, "const")) {
    next.enum = Object.freeze([from.const, null])
    delete next.const
  } else if (Array.isArray(next.enum) && !(next.enum as unknown[]).includes(null)) {
    next.enum = Object.freeze([...(next.enum as unknown[]), null])
  }
  const type = next.type
  if (typeof type === "string") {
    if (type !== "null") next.type = Object.freeze([type, "null"])
    return node(next)
  }
  if (Array.isArray(type)) {
    if (!type.includes("null")) next.type = Object.freeze([...type, "null"])
    return node(next)
  }
  const branches = next.anyOf
  if (Array.isArray(branches)) {
    const already = (branches as JsonSchemaNode[]).some((b) => b.type === "null")
    if (!already) next.anyOf = Object.freeze([...(branches as JsonSchemaNode[]), { type: "null" }])
    return node(next)
  }
  if (Array.isArray(next.enum)) return node(next)
  // Nothing to widen — a `$ref` or an unconstrained node — so wrap it instead.
  return node({ anyOf: Object.freeze([from, { type: "null" }]) })
}

/** Keys a parent must be sent: everything that is neither `.optional()` nor defaulted. */
function requiredOf(props: Record<string, JsonSchemaNode>): readonly string[] | undefined {
  const out: string[] = []
  for (const key of Object.keys(props)) {
    const child = props[key] as JsonSchemaNode
    if (isOptional(child) || Object.hasOwn(child, "default")) continue
    out.push(key)
  }
  return out.length > 0 ? Object.freeze(out) : undefined
}

function withProperties(from: JsonSchemaNode, props: Record<string, JsonSchemaNode>): JsonSchemaNode {
  return derive(from, { properties: Object.freeze(props), required: requiredOf(props) })
}

/** The builders. Every one returns a new frozen node; chaining never mutates. */
export const s = {
  string(): StringSchema {
    return node({ type: "string" }) as StringSchema
  },
  /** `{"type": "integer"}` — a plain JSON integer, not BunQL's int64 encoding. */
  int(): NumberSchema {
    return node({ type: "integer" }) as NumberSchema
  },
  number(): NumberSchema {
    return node({ type: "number" }) as NumberSchema
  },
  boolean(): SchemaNode<boolean> {
    return node({ type: "boolean" }) as SchemaNode<boolean>
  },
  null(): SchemaNode<null> {
    return node({ type: "null" }) as SchemaNode<null>
  },
  /** An unconstrained node, inferred as `any`. */
  any(): SchemaNode<any> {
    return node({}) as SchemaNode<any>
  },
  /** The same empty node, inferred as `unknown`, which is what a caller usually wants. */
  unknown(): SchemaNode<unknown> {
    return node({}) as SchemaNode<unknown>
  },
  literal<const V extends EnumMember>(value: V): SchemaNode<V> {
    return node({ const: value }) as SchemaNode<V>
  },
  enum<const V extends readonly EnumMember[]>(values: V): SchemaNode<V[number]> {
    const list = Object.freeze([...values])
    const kinds = new Set(list.map((v) => (v === null ? "null" : typeof v)))
    const only = kinds.size === 1 ? [...kinds][0] : undefined
    const source: Record<string, unknown> = {}
    if (only === "string" || only === "number" || only === "boolean") source.type = only
    source.enum = list
    return node(source) as SchemaNode<V[number]>
  },
  array<S extends Schema<any>>(items: S): ArraySchema<Infer<S>> {
    return node({ type: "array", items }) as ArraySchema<Infer<S>>
  },
  object<P extends Props>(props: P): ObjectSchema<P> {
    const properties: Record<string, JsonSchemaNode> = { ...(props as Record<string, JsonSchemaNode>) }
    return withProperties(node({ type: "object" }), properties) as ObjectSchema<P>
  },
  record<V extends Schema<any>>(value: V): SchemaNode<Record<string, Infer<V>>> {
    return node({ type: "object", additionalProperties: value }) as SchemaNode<
      Record<string, Infer<V>>
    >
  },
  union<const M extends readonly Schema<any>[]>(members: M): SchemaNode<Infer<M[number]>> {
    return node({ anyOf: Object.freeze([...members]) }) as SchemaNode<Infer<M[number]>>
  },
  /**
   * A SQLite integer as BunQL puts it on the wire (design §6.1): a JSON number while it survives
   * one, and `{"$i": "<decimal>"}` beyond ±2^53. Both branches are published, so a client reading
   * the document knows it has to handle the tagged form.
   */
  int64(): SchemaNode<number | bigint> {
    return tagged(
      node({
        anyOf: Object.freeze([{ type: "integer" }, INT_TAG]),
        description: 'A 64-bit integer; one outside ±2^53 travels as {"$i": "<decimal>"}.',
      }),
      "int64",
    ) as SchemaNode<number | bigint>
  },
  /** A BLOB, always `{"$b": "<base64>"}` on the wire; a `Uint8Array` once validated. */
  blob(): SchemaNode<Uint8Array> {
    return tagged(
      node({ ...BLOB_TAG, description: 'A BLOB as {"$b": "<base64>"}.' }),
      "blob",
    ) as SchemaNode<Uint8Array>
  },
  /** Any one SQLite value, in BunQL's encoding. A `boolean` is accepted and stored as 0 or 1. */
  sqliteValue(): SchemaNode<null | number | bigint | string | Uint8Array> {
    return tagged(
      node({
        anyOf: Object.freeze([
          { type: "null" },
          { type: "number" },
          { type: "string" },
          { type: "boolean" },
          INT_TAG,
          BLOB_TAG,
          FLOAT_TAG,
        ]),
        description: "One SQLite value in BunQL's encoding (design §6.1).",
      }),
      "sqlite",
    ) as SchemaNode<null | number | bigint | string | Uint8Array>
  },
}

/**
 * A reference to a schema named with `.id(name)`. The `$ref` is the bare name: `src/openapi/`
 * rewrites it to `#/components/schemas/<name>`, and `validate()` resolves it against the named
 * schemas of the tree it was handed, which is what lets a schema refer to itself.
 */
export function ref<T = unknown>(name: string): SchemaNode<T> {
  return node({ $ref: name }) as SchemaNode<T>
}

const CHILD_KEYS = ["items", "contains", "not", "propertyNames"] as const
const CHILD_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const
const CHILD_MAP_KEYS = ["properties", "$defs"] as const

function visit(
  from: JsonSchemaNode,
  out: Map<string, Schema>,
  seen: Set<JsonSchemaNode>,
): void {
  if (seen.has(from)) return
  seen.add(from)
  const id = from.$id
  if (typeof id === "string" && !out.has(id)) out.set(id, from as Schema)
  for (const key of CHILD_MAP_KEYS) {
    const map = from[key]
    if (!isPlainObject(map)) continue
    for (const name of Object.keys(map)) {
      const child = map[name]
      if (isPlainObject(child)) visit(child as JsonSchemaNode, out, seen)
    }
  }
  for (const key of CHILD_LIST_KEYS) {
    const list = from[key]
    if (!Array.isArray(list)) continue
    for (const child of list) if (isPlainObject(child)) visit(child as JsonSchemaNode, out, seen)
  }
  for (const key of CHILD_KEYS) {
    const child = Object.hasOwn(from, key) ? from[key] : undefined
    if (isPlainObject(child)) visit(child as JsonSchemaNode, out, seen)
  }
  const additional = from.additionalProperties
  if (isPlainObject(additional)) visit(additional as JsonSchemaNode, out, seen)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Every `.id(name)` node in a tree, so `src/openapi/` can emit `components/schemas` and `$ref`
 * them. Cycle-safe: a node is visited once, so a schema that reaches itself terminates.
 */
export function collectNamed(schema: Schema<any>): Map<string, Schema> {
  const out = new Map<string, Schema>()
  visit(schema as JsonSchemaNode, out, new Set())
  return out
}

/**
 * The node as plain JSON Schema: the identity function but for dropping the builder prototype and
 * the symbol marks. Emitters should read keywords off this, never off a live node, where an
 * absent keyword resolves to the method of the same name.
 */
export function toJsonSchema(schema: Schema<any>): JsonSchemaNode {
  return plain(schema) as JsonSchemaNode
}

function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (value instanceof Uint8Array) return value
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = plain(value[key])
    return out
  }
  return value
}

/** A deep copy of a `default`, so a caller never gets a reference into the schema. */
export function cloneValue<T>(value: T): T {
  return plain(value) as T
}

export function isSchema(value: unknown): value is Schema {
  return isPlainObject(value)
}
