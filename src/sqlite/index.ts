// The public surface of the driver. Everything below is synchronous: SQLite calls block, and
// the server layers above decide when to yield.

export { Database } from "./database.ts"
export type {
  Authorizer,
  ChangesetSession,
  CheckpointResult,
  CommitHook,
  ConflictPolicy,
  OpenOptions,
  PreupdateAccessor,
  PreupdateHook,
  RollbackHook,
  TransactionMode,
  UpdateHook,
  WalHook,
} from "./database.ts"
export { Statement } from "./statement.ts"
export type { Row, RunResult } from "./statement.ts"
export { codeName, FeatureUnavailableError, SqliteError } from "./errors.ts"
export { candidatePaths, loadFrom, sqlite } from "./lib.ts"
export type { SqliteFeatures, SqliteLibrary, WalsumSymbols } from "./lib.ts"
export type { BindArg, BindParams, BindValue, NamedParams, SqliteValue } from "./values.ts"
export * from "./constants.ts"
