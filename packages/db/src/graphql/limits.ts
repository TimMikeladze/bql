// Invariant: every operation is measured **before** it is executed, and an operation past a limit
// runs nothing at all — no dispatch, no statement, no row. A GraphQL endpoint with no depth limit
// is a denial-of-service surface: one recursive query on a schema with related types costs the
// server arbitrarily much, and the caller pays for a few hundred bytes of text.
//
// Two measurements, both static over the parsed document with fragments resolved:
//
//   * **depth** — a root field is depth 1, a field selected on it is depth 2. `[graphql] maxDepth`
//     (12) is the ceiling. Variables cannot change a depth, so this is exact.
//   * **complexity** — every field costs one *per row of its parent*, and a field whose type is a
//     list multiplies the rows its children are counted at. The row count of a list field is its
//     own `limit` argument when the query names one (a literal or a variable), the argument's
//     default when it has one, and `defaultRows` (100, `[api] defaultLimit`) otherwise.
//     `[graphql] maxComplexity` (10000) is the ceiling.
//
// What complexity is, stated plainly so nobody reads more into it: **a bound on the rows an
// operation can ask for, read off the query and the schema.** It is not a cost model of SQLite —
// it does not know what a statement will scan, and a single `listUsers(limit: 1)` over a table
// with a million rows and no index is cheap by this measure and expensive in fact. That is what
// `src/server/exec.ts`'s deadline, row cap and `vmSteps` accounting are for, and they still apply
// to every dispatch this admits. This measure exists to refuse the *shape* of a query that would
// fan out, before any of those are reached.
//
// This runs after `validate` with the specified rules, which is what makes the walk safe: a
// fragment cycle is already rejected there. The guard here is belt and braces.
//
// It is not a validation rule, deliberately: a `limit: $rows` variable is only known once the
// request's variables are in hand, and a rule cannot see them.

import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLField,
  GraphQLNamedType,
  GraphQLOutputType,
  GraphQLSchema,
  SelectionSetNode,
  ValueNode,
} from "graphql"
import type { Peers } from "./peers.ts"

/** `[graphql] maxDepth` in `docs/plan-surfaces.md`. */
export const DEFAULT_MAX_DEPTH = 12
/** `[graphql] maxComplexity`. */
export const DEFAULT_MAX_COMPLEXITY = 10000
/** `[api] defaultLimit`: the rows a list field returns when the query does not say. */
export const DEFAULT_ROWS = 100

/** What an operation measured, whether or not it was refused. */
export interface LimitReport {
  depth: number
  complexity: number
  problems: LimitProblem[]
}

/** A refusal, in the vocabulary of `src/server/errors.ts`: a `BAD_REQUEST`, before anything ran. */
export interface LimitProblem {
  message: string
  /** `"depth"` or `"complexity"`, for the error's extensions. */
  limit: "depth" | "complexity"
  max: number
  actual: number
}

export interface LimitOptions {
  maxDepth?: number
  maxComplexity?: number
  /** Rows a list field is counted at when neither the query nor the schema says. Default 100. */
  defaultRows?: number
  /** The request's variables, uncoerced, for a `limit: $rows` argument. */
  variables?: Record<string, unknown> | null
  /** Which operation to measure, when the document carries more than one. */
  operationName?: string | null
}

interface Walk {
  graphql: Peers["graphql"]
  schema: GraphQLSchema
  fragments: Map<string, FragmentDefinitionNode>
  variables: Record<string, unknown> | null
  defaultRows: number
  maxDepth: number
  complexity: number
  depth: number
}

/**
 * Measures the operation and returns what it found. The caller refuses when `problems` is
 * non-empty; nothing here throws, because a refusal is an answer to the client and not a fault.
 */
export function checkLimits(
  graphql: Peers["graphql"],
  schema: GraphQLSchema,
  document: DocumentNode,
  options: LimitOptions = {},
): LimitReport {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxComplexity = options.maxComplexity ?? DEFAULT_MAX_COMPLEXITY
  const operation = graphql.getOperationAST(document, options.operationName ?? undefined)
  if (!operation) return { depth: 0, complexity: 0, problems: [] }

  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of document.definitions) {
    if (definition.kind === "FragmentDefinition") fragments.set(definition.name.value, definition)
  }

  const root =
    operation.operation === "mutation"
      ? schema.getMutationType()
      : operation.operation === "subscription"
        ? schema.getSubscriptionType()
        : schema.getQueryType()

  const walk: Walk = {
    graphql,
    schema,
    fragments,
    variables: options.variables ?? null,
    defaultRows: options.defaultRows ?? DEFAULT_ROWS,
    maxDepth,
    complexity: 0,
    depth: 0,
  }
  measure(walk, operation.selectionSet, root ?? undefined, 1, 1, new Set())

  const problems: LimitProblem[] = []
  if (walk.depth > maxDepth) {
    problems.push({
      message: `query is ${walk.depth} levels deep; this server allows ${maxDepth}`,
      limit: "depth",
      max: maxDepth,
      actual: walk.depth,
    })
  }
  if (walk.complexity > maxComplexity) {
    problems.push({
      message: `query has a complexity of ${walk.complexity}; this server allows ${maxComplexity}`,
      limit: "complexity",
      max: maxComplexity,
      actual: walk.complexity,
    })
  }
  return { depth: walk.depth, complexity: walk.complexity, problems }
}

/**
 * One selection set. `rows` is how many times each field in it is counted; `depth` is the level
 * its fields sit at. `seen` is the fragment path, so a cycle `validate` somehow admitted still
 * terminates.
 */
function measure(
  walk: Walk,
  selectionSet: SelectionSetNode,
  parent: GraphQLNamedType | undefined,
  rows: number,
  depth: number,
  seen: Set<string>,
): void {
  if (depth > walk.depth) walk.depth = depth
  // Past the ceiling the answer cannot change, and the walk is the caller's to pay for.
  if (depth > walk.maxDepth + 1) return

  for (const selection of selectionSet.selections) {
    if (selection.kind === "Field") {
      walk.complexity += rows
      if (!selection.selectionSet) continue
      const field = fieldDef(walk, parent, selection.name.value)
      const childRows = field ? rows * rowsFor(walk, selection, field) : rows
      measure(walk, selection.selectionSet, namedType(walk, field?.type), childRows, depth + 1, seen)
      continue
    }
    if (selection.kind === "InlineFragment") {
      const condition = selection.typeCondition?.name.value
      const on = condition ? (walk.schema.getType(condition) ?? parent) : parent
      measure(walk, selection.selectionSet, on, rows, depth, seen)
      continue
    }
    const name = selection.name.value
    if (seen.has(name)) continue
    const fragment = walk.fragments.get(name)
    if (!fragment) continue
    const on = walk.schema.getType(fragment.typeCondition.name.value) ?? parent
    seen.add(name)
    measure(walk, fragment.selectionSet, on, rows, depth, seen)
    seen.delete(name)
  }
}

/** The field definition on `parent`, when `parent` is a type that has fields. */
function fieldDef(
  walk: Walk,
  parent: GraphQLNamedType | undefined,
  name: string,
): GraphQLField<unknown, unknown> | undefined {
  if (!parent) return undefined
  const { isObjectType, isInterfaceType } = walk.graphql
  if (!isObjectType(parent) && !isInterfaceType(parent)) return undefined
  return parent.getFields()[name]
}

/** The named type under any number of `!` and `[]` wrappers. */
function namedType(walk: Walk, type: GraphQLOutputType | undefined): GraphQLNamedType | undefined {
  if (!type) return undefined
  return walk.graphql.getNamedType(type)
}

/** How many rows a field's children are counted at: 1 unless the field returns a list. */
function rowsFor(
  walk: Walk,
  node: FieldNode,
  field: GraphQLField<unknown, unknown>,
): number {
  const { isListType, isNonNullType } = walk.graphql
  let type: GraphQLOutputType = field.type
  if (isNonNullType(type)) type = type.ofType as GraphQLOutputType
  if (!isListType(type)) return 1

  const argument = node.arguments?.find((given) => given.name.value === "limit")
  const asked = argument ? valueOf(walk, argument.value) : undefined
  if (typeof asked === "number" && Number.isFinite(asked) && asked >= 0) return Math.ceil(asked)

  // graphql 17 carries an argument's default as `{value}` or `{literal}`; `defaultValue` is its
  // deprecated spelling and is not read here.
  const declared = field.args.find((arg) => arg.name === "limit")?.default
  const fallback = declared && "value" in declared ? declared.value : undefined
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0) {
    return Math.ceil(fallback)
  }
  return walk.defaultRows
}

/** An argument value, resolving a variable against the request's own variables. */
function valueOf(walk: Walk, value: ValueNode): unknown {
  if (value.kind === "IntValue") return Number(value.value)
  if (value.kind === "FloatValue") return Number(value.value)
  if (value.kind === "Variable") return walk.variables?.[value.name.value]
  return undefined
}
