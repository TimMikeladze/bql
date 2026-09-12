// Invariant: a name identifies one schema. A node carrying `.id("User")` becomes
// `components/schemas/User` and is replaced by a `$ref` *everywhere else it appears*, at any depth
// and in any operation; two different schemas claiming one name is refused by name, with both
// origins in the message, rather than one of them silently winning. That matters more than it
// looks: H5 feeds this document to `openapi-x-graphql`, so a component name is the name of a
// generated GraphQL type, and the wrong one is a wrong field on a type someone will import.
//
// Reading a keyword off a live core node is the trap this module walks past twice. Nine builder
// methods share their names with keywords, so `node.format` is a *function* on a string schema
// that has no format. Everything here reads own keys only — `Object.keys`, which sees keywords and
// not prototype methods — or goes through core's `keyword()` guard rail.
//
// `CHILD_*` below mirrors the traversal of `collectNamed()` in `src/core/schema.ts`. A keyword core
// teaches that function about has to be added here too; the failure if it is not is a named schema
// left inline instead of hoisted, which is degraded rather than wrong.

import { keyword, type JsonSchemaNode, type Schema } from "../core/index.ts"
import type { ReferenceObject, SchemaObject } from "./types.ts"

/** Keywords whose value is one schema. `additionalProperties` may also be a boolean. */
const CHILD_SCHEMA = ["items", "contains", "not", "propertyNames", "additionalProperties"]
/** Keywords whose value is a list of schemas. */
const CHILD_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"]
/** Keywords whose value is a map of name to schema. */
const CHILD_MAP = ["properties", "$defs"]

export function componentPointer(name: string): string {
  return `#/components/schemas/${name}`
}

interface Claim {
  schema: JsonSchemaNode
  origin: string
}

interface Entry extends Claim {
  /** Other nodes that claimed the same name; each is compared against `schema` on `seal()`. */
  rivals: Claim[]
}

/**
 * The `components/schemas` of one document, and the only thing that turns a core schema into
 * something an OpenAPI consumer may read.
 *
 * Three phases, in order: `collect` every root, `seal` once the name set is final, then `convert`
 * each position. `convert` before `seal` would have to guess whether a `$ref` resolves.
 */
export class Components {
  readonly #names = new Map<string, Entry>()
  readonly #definitions = new Map<string, SchemaObject>()
  readonly #seen = new Set<JsonSchemaNode>()
  readonly #errorName: string
  #sealed = false

  /** `errorName` only shapes the message when the collision is with the error component. */
  constructor(errorName: string) {
    this.#errorName = errorName
  }

  /** Records every `.id(name)` node reachable from `root`. Cycle-safe. */
  collect(root: Schema, origin: string): void {
    this.#walk(root as JsonSchemaNode, origin)
  }

  /** Fixes the name set and converts every definition, refusing two schemas under one name. */
  seal(): void {
    if (this.#sealed) return
    this.#sealed = true
    for (const [name, entry] of this.#names) {
      const definition = this.#node(entry.schema, true) as SchemaObject
      this.#definitions.set(name, definition)
      const canonical = stable(definition)
      for (const rival of entry.rivals) {
        if (stable(this.#node(rival.schema, true)) === canonical) continue
        throw new Error(
          `openapi: two different schemas are both named "${name}" — one reached from ` +
            `${entry.origin}, one from ${rival.origin}. A component name must identify one ` +
            `schema.${
              name === this.#errorName
                ? " Pass options.errorSchemaName to move the error component out of the way."
                : ""
            }`,
        )
      }
    }
  }

  get size(): number {
    return this.#names.size
  }

  /** The `components/schemas` map, by name, or `undefined` when nothing was named. */
  definitions(): Record<string, SchemaObject> | undefined {
    if (this.#definitions.size === 0) return undefined
    const out: Record<string, SchemaObject> = {}
    for (const name of [...this.#definitions.keys()].sort()) {
      out[name] = this.#definitions.get(name) as SchemaObject
    }
    return out
  }

  /** A schema as it appears in a parameter, a body or a response: a `$ref` when it is named. */
  convert(schema: Schema): SchemaObject | ReferenceObject {
    if (!this.#sealed) throw new Error("openapi: convert() before seal()")
    return this.#node(schema as JsonSchemaNode, false)
  }

  /** `{"$ref": …}` for a name this document defines; throws when it does not. */
  reference(name: string): ReferenceObject {
    if (!this.#names.has(name)) {
      throw new Error(`openapi: no schema is named "${name}"`)
    }
    return { $ref: componentPointer(name) }
  }

  #walk(node: JsonSchemaNode, origin: string): void {
    if (this.#seen.has(node)) return
    this.#seen.add(node)
    const id = keyword<string>(node, "$id")
    if (typeof id === "string") this.#claim(id, node, origin)
    forEachChild(node, (child) => this.#walk(child, origin))
  }

  #claim(name: string, schema: JsonSchemaNode, origin: string): void {
    const entry = this.#names.get(name)
    if (entry === undefined) {
      this.#names.set(name, { schema, origin, rivals: [] })
      return
    }
    if (entry.schema === schema) return
    if (!entry.rivals.some((rival) => rival.schema === schema)) {
      entry.rivals.push({ schema, origin })
    }
  }

  /**
   * One node as plain JSON. `asDefinition` is true only for the body of a component, where the
   * node's own `$id` is what is being defined rather than a reason to point elsewhere.
   */
  #node(node: JsonSchemaNode, asDefinition: boolean): SchemaObject | ReferenceObject {
    if (!asDefinition) {
      const id = keyword<string>(node, "$id")
      if (typeof id === "string") return { $ref: componentPointer(id) }
    }
    const bare = keyword<string>(node, "$ref")
    if (typeof bare === "string") {
      if (!this.#names.has(bare)) {
        throw new Error(
          `openapi: ref("${bare}") points at a schema no operation in this registry names ` +
            `with .id("${bare}")`,
        )
      }
      return { $ref: componentPointer(bare) }
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(node)) {
      if (key === "$id") continue
      out[key] = this.#value(key, node[key])
    }
    return out as SchemaObject
  }

  #value(key: string, value: unknown): unknown {
    if (CHILD_MAP.includes(key) && isPlainObject(value)) {
      const out: Record<string, unknown> = {}
      for (const name of Object.keys(value)) {
        const child = value[name]
        out[name] = isPlainObject(child) ? this.#node(child as JsonSchemaNode, false) : plain(child)
      }
      return out
    }
    if (CHILD_LIST.includes(key) && Array.isArray(value)) {
      return value.map((child) =>
        isPlainObject(child) ? this.#node(child as JsonSchemaNode, false) : plain(child),
      )
    }
    if (CHILD_SCHEMA.includes(key) && isPlainObject(value)) {
      return this.#node(value as JsonSchemaNode, false)
    }
    return plain(value)
  }
}

function forEachChild(node: JsonSchemaNode, fn: (child: JsonSchemaNode) => void): void {
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (CHILD_MAP.includes(key) && isPlainObject(value)) {
      for (const name of Object.keys(value)) {
        const child = value[name]
        if (isPlainObject(child)) fn(child as JsonSchemaNode)
      }
    } else if (CHILD_LIST.includes(key) && Array.isArray(value)) {
      for (const child of value) if (isPlainObject(child)) fn(child as JsonSchemaNode)
    } else if (CHILD_SCHEMA.includes(key) && isPlainObject(value)) {
      fn(value as JsonSchemaNode)
    }
  }
}

/** A deep copy over plain objects, so nothing in the document carries core's builder prototype. */
export function plain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(plain) as unknown as T
  if (value instanceof Uint8Array) return value
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = plain(value[key])
    return out as T
  }
  return value
}

/** JSON with object keys sorted, so key order never reads as a conflict between two claims. */
function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
