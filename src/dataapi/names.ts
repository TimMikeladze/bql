// Invariant: every name this module mints is a valid GraphQL name, and no two tables in one
// database are given the same one. An operation's `id` becomes the `operationId`, and
// `openapi-x-graphql` turns that into a GraphQL field name; a component name becomes a GraphQL
// type name. So a table called `order-items`, or `2fa_codes`, or one whose singular collides with
// another table's, has to be resolved *here* — a duplicate would otherwise surface as
// `Registry.add` throwing at startup, or as a document that cannot be generated from.
//
// Tables are named in sorted order (`introspect` sorts them), so the same schema always produces
// the same ids: a collision is broken the same way on every node and across restarts.
//
// The singular rule is deliberately small — five suffixes of English — because the alternative is
// an inflection library, which is a runtime dependency and still wrong about `people`. When it is
// wrong, `DataApiOptions.names` overrides it for that table.

import type { TableInfo } from "./introspect.ts"

export interface TableNames {
  /** `users` -> `Users`; the list operation reads `listUsers`. */
  plural: string
  /** `users` -> `User`; the row component and the single-row operations. */
  singular: string
  /** Component names. */
  row: string
  insert: string
  patch: string
  /** Operation ids. */
  list: string
  get: string
  create: string
  update: string
  delete: string
}

export interface NameOverride {
  singular?: string
  plural?: string
}

/** A GraphQL name from an arbitrary SQLite identifier: `order-items` -> `OrderItems`. */
export function pascalCase(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0)
  const joined = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")
  if (joined.length === 0) return "Table"
  // A GraphQL name may not start with a digit, and `_` is the one legal prefix.
  return /^[0-9]/.test(joined) ? `_${joined}` : joined
}

/** The small English rule. `Users` -> `User`, `Categories` -> `Category`, `Status` -> `Status`. */
export function singularize(word: string): string {
  if (/ies$/i.test(word) && word.length > 3) return `${word.slice(0, -3)}y`
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.slice(0, -2)
  if (/(ss|us|is)$/i.test(word)) return word
  if (/s$/i.test(word) && word.length > 1) return word.slice(0, -1)
  return word
}

function candidate(plural: string, singular: string, suffix: string): TableNames {
  const p = `${plural}${suffix}`
  const one = `${singular}${suffix}`
  return {
    plural: p,
    singular: one,
    row: one,
    insert: `New${one}`,
    patch: `${one}Patch`,
    list: `list${p}`,
    get: `get${one}`,
    create: `create${one}`,
    update: `update${one}`,
    delete: `delete${one}`,
  }
}

function claimed(names: TableNames): string[] {
  return [names.row, names.insert, names.patch, names.list, names.get, names.create, names.update, names.delete]
}

/**
 * Names for every table, with collisions broken deterministically: a table whose singular is
 * already taken keeps its plural as its singular (`user` and `users` become `User` and `Users`),
 * and if that is taken too a counter is appended.
 */
export function nameTables(
  tables: readonly TableInfo[],
  overrides: Readonly<Record<string, NameOverride>> = {},
): Map<string, TableNames> {
  const used = new Set<string>()
  const out = new Map<string, TableNames>()
  for (const table of tables) {
    const override = overrides[table.name]
    const plural = override?.plural ? pascalCase(override.plural) : pascalCase(table.name)
    const singular = override?.singular ? pascalCase(override.singular) : singularize(plural)
    let names = candidate(plural, singular, "")
    if (clashes(names, used)) names = candidate(plural, plural, "")
    for (let n = 2; clashes(names, used); n++) names = candidate(plural, singular, String(n))
    for (const name of claimed(names)) used.add(name)
    out.set(table.name, names)
  }
  return out
}

function clashes(names: TableNames, used: ReadonlySet<string>): boolean {
  return claimed(names).some((name) => used.has(name))
}
