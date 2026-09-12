// A tenant's own SQLite schema, turned into core `Operation`s: REST from `src/http/`, an OpenAPI
// 3.1 document from `src/openapi/`, and a GraphQL schema generated from that document. One
// introspection, three surfaces (`docs/plan-surfaces.md`, milestone H4; as-built notes in
// `docs/h4-dataapi.md`).
//
// Invariant, and the security boundary of the whole surface: **every identifier in the generated
// SQL comes from introspection, and every value is a bound parameter.** `src/dataapi/sql.ts` is
// the one function that turns a request into `{sql, args}`, and it takes `TableInfo` and
// `ColumnInfo` records rather than names — so a string from a request cannot be represented in
// its argument type, let alone reach the SQL text. A `select=`, an `order=` or a filter naming a
// column the table does not have is a `400` from `src/dataapi/filter.ts` and never a query.
//
// Second invariant: **nothing here runs a statement.** Every statement goes to the `exec` on the
// context, which the server closes over `src/server/exec.ts` — so the data API inherits the
// token's per-table ACLs, the deadline, the row cap, `vmSteps`, the quota, the txid, the ack
// level and write forwarding, rather than reimplementing any of them.

export { DataApiCache, type DataApiCacheOptions, type DataApiEntry, schemaVersion } from "./cache.ts"
export {
  type DataApiContext,
  type DataRows,
  type DataStatement,
  type DataValue,
  type Execute,
  rowObjects,
} from "./context.ts"
export {
  bindValue,
  type Condition,
  type IsLiteral,
  type ListLimits,
  type ListPlan,
  type Operator,
  OPERATORS,
  type OrderTerm,
  parseListQuery,
  parseSelect,
  readableColumns,
  RESERVED_QUERY_KEYS,
  resolveColumn,
} from "./filter.ts"
export {
  affinityOf,
  type Affinity,
  type ColumnInfo,
  type ColumnSchema,
  columnOf,
  type ForeignKeyInfo,
  type IndexInfo,
  introspect,
  type IntrospectOptions,
  schemaForColumn,
  type TableInfo,
  tableOf,
  type TenantSchema,
} from "./introspect.ts"
export { nameTables, type NameOverride, pascalCase, singularize, type TableNames } from "./names.ts"
export { dataApiRegistry, type DataApiOptions } from "./operations.ts"
export { type Assignment, buildStatement, type Command } from "./sql.ts"
