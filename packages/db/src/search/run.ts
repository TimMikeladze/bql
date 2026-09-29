// What every helper in `bql.sh/search` runs its SQL through, and the two ways it refuses.
//
// Invariant: the helpers build SQL and nothing else. They take anything shaped like a `Db` — the
// client's `createClient().db()`, the embedded `bq.db()`, its `.sync`, a `Tx` — and send ordinary
// statements through it, so there is one code path for embedded, server, replica reads and cloud
// mode, and no route of their own.
//
// Second invariant: an identifier reaches SQL only after `ident` has checked it against a plain
// `[A-Za-z_][A-Za-z0-9_]*` and quoted it. Table and column names cannot be bound parameters, so
// this is the one place injection through a name could happen, and it cannot.

import { BqlClientError } from "../client/errors.ts"
import type { BatchItem } from "../client/index.ts"
import { fromArgs, type QueryArgs } from "../client/sql.ts"
import type { JsRow } from "../client/values.ts"

/**
 * The part of a `Db` the helpers use. `execute` may answer with a promise-like (the client, the
 * embedded async handle, a `Tx`) or with something that has `all()` (the embedded `.sync`).
 * `batch` is optional: without it a multi-statement step runs one statement at a time.
 */
export interface SearchDb {
  execute(
    sql: string,
    args?: QueryArgs,
  ): PromiseLike<readonly JsRow[]> | { all(): readonly JsRow[] }
  batch?(items: BatchItem[]): PromiseLike<unknown> | unknown
}

/** A capability the helpers need and the server's libsqlite3 lacks. */
export type SearchFeature = "vec" | "geo" | "fts5" | "rtree"

/**
 * The library the server runs on does not have what this helper needs — sqlite-vec and the geo
 * functions exist only in the build `bun run db sqlite:build` produces. Never a silent fallback:
 * a vector search that quietly became a table scan would be a worse bug than this error.
 */
export class FeatureUnavailableError extends BqlClientError {
  readonly feature: SearchFeature

  constructor(feature: SearchFeature, detail?: string) {
    super({
      code: "FEATURE_UNAVAILABLE",
      message:
        `${WHAT[feature]} is not available on this database's SQLite. It is compiled into the ` +
        "library `bun run db sqlite:build` produces (or `bun run node_modules/bql.sh/packages/db/" +
        "scripts/sqlite.ts` from an installed package); restart the server on that library." +
        (detail ? ` (${detail})` : ""),
      status: 0,
    })
    this.name = "FeatureUnavailableError"
    this.feature = feature
  }
}

const WHAT: Record<SearchFeature, string> = {
  vec: "sqlite-vec (vec0)",
  geo: "bql.sh's geo functions (bql_haversine)",
  fts5: "FTS5",
  rtree: "R*Tree",
}

/** A cheap statement that fails, or answers 0, exactly when the feature is missing. */
const PROBES: Record<SearchFeature, string> = {
  vec: "select vec_version() as ok",
  geo: "select bql_haversine(0, 0, 0, 0) = 0 as ok",
  fts5: "select sqlite_compileoption_used('ENABLE_FTS5') as ok",
  rtree: "select sqlite_compileoption_used('ENABLE_RTREE') as ok",
}

/** What SQLite says when a statement names something the library does not have. */
const MISSING: readonly [RegExp, SearchFeature][] = [
  [/no such (?:module: vec0|function: vec_)/i, "vec"],
  [/no such function: bql_(?:haversine|bbox)/i, "geo"],
  [/no such module: fts5/i, "fts5"],
  [/no such module: rtree/i, "rtree"],
]

/** Runs one statement and returns its rows as objects. */
export async function run(db: SearchDb, sql: string, args?: readonly unknown[]): Promise<JsRow[]> {
  try {
    const query = db.execute(sql, args)
    const rows =
      typeof (query as PromiseLike<unknown>).then === "function"
        ? await (query as PromiseLike<readonly JsRow[]>)
        : (query as { all(): readonly JsRow[] }).all()
    // A plain array: the result metadata the handle hangs off its rows describes the helper's
    // generated statement, which is not the caller's business.
    return Array.from(rows)
  } catch (err) {
    throw mapMissing(err)
  }
}

/** Runs statements in one atomic batch when the handle has one, one by one when it does not. */
export async function runAll(
  db: SearchDb,
  statements: readonly { sql: string; args?: readonly unknown[] }[],
): Promise<void> {
  if (typeof db.batch !== "function") {
    for (const { sql, args } of statements) await run(db, sql, args)
    return
  }
  try {
    await db.batch(statements.map(({ sql, args }) => fromArgs(sql, args)))
  } catch (err) {
    throw mapMissing(err)
  }
}

function mapMissing(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err)
  for (const [pattern, feature] of MISSING) {
    if (pattern.test(message)) return new FeatureUnavailableError(feature, message)
  }
  return err
}

/** Throws `FeatureUnavailableError` unless the database behind `db` has every one of `features`. */
export async function requireFeatures(db: SearchDb, ...features: SearchFeature[]): Promise<void> {
  const have = await searchFeatures(db, features)
  for (const feature of features) {
    if (!have[feature]) throw new FeatureUnavailableError(feature)
  }
}

/**
 * Which of the helpers' capabilities the database behind `db` has. One statement per feature
 * asked about; each either answers or fails with "no such function".
 */
export async function searchFeatures(
  db: SearchDb,
  features: readonly SearchFeature[] = ["vec", "geo", "fts5", "rtree"],
): Promise<Record<SearchFeature, boolean>> {
  const out: Record<SearchFeature, boolean> = { vec: false, geo: false, fts5: false, rtree: false }
  for (const feature of features) {
    try {
      const rows = await run(db, PROBES[feature])
      const ok = rows[0]?.ok
      out[feature] = ok !== null && ok !== undefined && ok !== 0 && ok !== false
    } catch (err) {
      if (err instanceof FeatureUnavailableError || /no such (function|module)/i.test(String(err))) {
        continue
      }
      throw err
    }
  }
  return out
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A table or column name, checked and double-quoted. Anything but a plain identifier is refused
 * rather than escaped: a name the helpers derive others from (`<table>_ai`, `<table>_data`) has to
 * stay a plain identifier all the way down, and `sqlite_` is SQLite's own namespace.
 */
export function ident(name: string, what = "identifier"): string {
  if (typeof name !== "string" || !IDENT.test(name) || name.length > 128) {
    throw BqlClientError.client(
      `${what} ${JSON.stringify(name)} must be a plain identifier ([A-Za-z_][A-Za-z0-9_]*)`,
    )
  }
  if (name.toLowerCase().startsWith("sqlite_")) {
    throw BqlClientError.client(`${what} ${JSON.stringify(name)} is in SQLite's reserved sqlite_ namespace`)
  }
  return `"${name}"`
}

/** A SQL string literal. For the few places SQL takes a string that cannot be a parameter (DDL). */
export function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`
}

/** A positive integer no larger than `max`, or a `CLIENT` error naming the option. */
export function positiveInt(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw BqlClientError.client(`${name} must be an integer from 1 to ${max}, got ${value}`)
  }
  return value
}
