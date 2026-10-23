// Typed SQL without a generator: `tsc` reads the schema out of DDL string literals and each
// query's row and parameter types out of the query string. See docs/plan-typed-sql.md.
//
// At runtime there is nothing here: `query(sql, args)` is `execute(sql, args)`. The types need a
// string literal, which a tagged template can't provide (TypeScript types its strings as
// `TemplateStringsArray`), so this is a call and the values travel as `:name` or `?` placeholders.

import { LiveQuery } from "../client/feed.ts"
import type { TransactionOptions, Tx } from "../client/index.ts"
import type { StatementRequest } from "../client/protocol.ts"
import { fromArgs, type QueryArgs, type Query } from "../client/sql.ts"
import type { JsRow } from "../client/values.ts"
import type { Col, ParseSchema, Schema } from "./ddl.ts"
import type { Lex } from "./lex.ts"
import type { Complete } from "./complete.ts"
import { desiredSchema, hashDdl, planLive, pushTo, type Desired, type Plan, type PushOptions } from "./push.ts"
import type { Analyzed, Entry, Param, Statement } from "./query.ts"

export type { Col, Schema } from "./ddl.ts"
export type { Param } from "./query.ts"
export type { Plan, PushOptions } from "./push.ts"

/** DDL strings, with the schema they declare attached as a type. */
export interface SchemaDef<S extends Schema = Schema, D extends readonly string[] = readonly string[]> {
  /** The strings as given, typed as a tuple so `schema(...app.ddl, "alter table …")` extends a schema. */
  readonly ddl: D
  /** Type-only. Holds the parsed schema; never set at runtime. */
  readonly __schema?: S
  /**
   * `db` with typed `query`, `live` and `transaction`. The first of them brings the database in
   * step with the schema (see `push`), once per `db`; after that each goes straight through.
   */
  typed<E extends Executor>(db: E, options?: TypedOptions): TypedDb<S, E>
  /**
   * What `typed` does on first use, run now, with the options a deploy step needs. Creates what's
   * missing and tightens a column the schema says is not null; leaves anything extra or stricter
   * alone; throws on a change that would lose data or change a column's type unless
   * `allowDataLoss` is set.
   */
  push<E extends Executor & Transactional>(db: E, options?: PushOptions): Promise<TypedDb<S, E>>
  /** What `push` would run and what it would refuse, without running anything. */
  plan(db: Executor, options?: PushOptions): Promise<Plan>
}

export interface TypedOptions {
  /**
   * Bring the database in step on first use. Defaults to true in Bun on a db with transactions
   * (a client `Db` or an embedded one), false elsewhere: a browser can't build the schema to
   * compare against. Pass false for a read-only token.
   */
  sync?: boolean
  /** Renames for that first sync; see `PushOptions.rename`. */
  rename?: Record<string, string>
}

/**
 * The schema `ddl` declares: the `create` statements as they should be now, edited in place.
 * Strings are applied in order, so an `alter` still works, but nothing needs one.
 */
export function schema<const D extends readonly string[]>(...ddl: D): SchemaDef<ParseSchema<D>, D> {
  type S = ParseSchema<D>
  const hash = hashDdl(ddl)
  let desired: Promise<Desired> | undefined
  const want = () => (desired ??= desiredSchema(ddl))
  // One sync per db object, shared by every `typed()` over it. A failure is forgotten so the next
  // query tries again, which is what lets a deploy step fix the database under running code.
  const synced = new WeakMap<object, Promise<void>>()
  const sync = (db: Executor & Transactional, options: PushOptions): Promise<void> => {
    let pending = synced.get(db)
    if (!pending) {
      pending = pushTo(db, hash, want, options).catch((err) => {
        synced.delete(db)
        throw err
      })
      synced.set(db, pending)
    }
    return pending
  }
  return {
    ddl,
    typed: <E extends Executor>(db: E, options: TypedOptions = {}) => {
      const can = typeof (db as Partial<Transactional>).transaction === "function" && "Bun" in globalThis
      const ensure = options.sync ?? can ? () => sync(db as E & Transactional, { rename: options.rename }) : null
      return bind<S, E>(db, ensure)
    },
    plan: async (db: Executor, options: PushOptions = {}) => planLive(db, await want(), options),
    push: async <E extends Executor & Transactional>(db: E, options: PushOptions = {}) => {
      await pushTo(db, hash, want, options)
      synced.set(db, Promise.resolve())
      return bind<S, E>(db, null)
    },
  }
}

type Trim<T extends string[]> = T extends [...infer R extends string[], ";"] ? Trim<R> : T

/** Every bare `?` as `?N`, numbered from 1 as SQLite numbers them, so a position survives being looked at alone. */
type Number_<T extends string[], N extends unknown[] = [0], Acc extends string[] = []> = T extends [
  infer H extends string,
  ...infer R extends string[],
]
  ? H extends "?"
    ? Number_<R, [...N, 0], [...Acc, `?${N["length"]}`]>
    : Number_<R, N, [...Acc, H]>
  : Acc

/** What the parser makes of `Q`. A non-literal string is untyped. */
export type Analyze<S extends Schema, Q extends string> = string extends Q
  ? { untyped: true }
  : Statement<Number_<Trim<Lex<Q>>>, S>

type Prettify<T> = { [K in keyof T]: T[K] } & {}

export type RowOf<A extends Analyzed> = A extends { cols: infer C extends Col[] }
  ? Prettify<{ [K in C[number] as K["name"]]: K["nullable"] extends true ? K["type"] | null : K["type"] }>
  : JsRow

type Pick_<E extends Entry[], K extends string> =
  [Extract<E[number], [K, unknown, true]>] extends [never]
    ? Param
    : Extract<E[number], [K, unknown, true]>[1]

type Positional<E extends Entry[], I extends unknown[] = []> =
  `#${I["length"]}` extends E[number][0] ? [Pick_<E, `#${I["length"]}`>, ...Positional<E, [...I, 0]>] : []

/** The arguments after the SQL: none, a named-parameter object, or a positional tuple. */
export type ArgsOf<A extends Analyzed> = A extends { params: infer E extends Entry[] }
  ? [E[number]] extends [never]
    ? []
    : [E[number][0] & `#${number}`] extends [never]
      ? [args: Prettify<{ [K in E[number][0]]: Pick_<E, K> }>]
      : [Exclude<E[number][0], `#${number}`>] extends [never]
        ? [args: Positional<E>]
        : [args?: QueryArgs]
  : [args?: QueryArgs]

/**
 * `Q` itself when it checks, otherwise the error message, which then fails to match the argument.
 * Either way joined with whole-query completions (`complete.ts`), which an editor offers inside the
 * string.
 */
export type Checked<S extends Schema, Q extends string> =
  Analyze<S, Q> extends infer A extends Analyzed
    ? A extends { error: infer M extends string }
      ? M | NoInfer<Complete<Q, A, S>>
      : Q | NoInfer<Complete<Q, A, S>>
    : Q

/** Anything with `execute`: a client `Db`, an embedded one, or a `Tx` inside either. */
export interface Executor {
  execute(sql: string, args?: QueryArgs): Query<unknown>
}

interface Live {
  live(sql: string, args?: QueryArgs): LiveQuery<unknown>
}

interface Transactional {
  transaction<T>(fn: (tx: Tx) => Promise<T> | T, options?: TransactionOptions): Promise<T>
}

/** What `query` returns: a `Query`, or one that waits for the first sync before it runs. */
export type TypedQuery<T> = Pick<Query<T>, "sql" | "then" | "catch" | "finally" | "values" | "raw" | "first" | "run" | "toJSON">

/** Typed `query` always; `live` and `transaction` when the executor has them, which a `Tx` doesn't. */
export type TypedDb<S extends Schema, E = Executor> = {
  /** The executor underneath, for the untyped `sql` tag, `batch` and the rest. */
  readonly raw: E
  query<const Q extends string>(sql: Checked<S, Q>, ...args: ArgsOf<Analyze<S, Q>>): TypedQuery<RowOf<Analyze<S, Q>>>
} & (E extends Live
  ? { live<const Q extends string>(sql: Checked<S, Q>, ...args: ArgsOf<Analyze<S, Q>>): LiveQuery<RowOf<Analyze<S, Q>>> }
  : {}) &
  (E extends Transactional
    ? { transaction<T>(fn: (tx: TypedDb<S, Tx>) => Promise<T> | T, options?: TransactionOptions): Promise<T> }
    : {})

/** A query that runs once `ready` settles. Same surface as `Query`. */
class Pending<T> implements TypedQuery<T> {
  readonly sql: string
  #request: StatementRequest
  // Boxed: a promise resolved with a `Query` would adopt it as a thenable and run it.
  #query: Promise<{ q: Query<T> }>

  constructor(ready: Promise<void>, make: () => Query<T>, sql: string, args: QueryArgs | undefined) {
    this.sql = sql
    this.#request = fromArgs(sql, args)
    this.#query = ready.then(() => ({ q: make() }))
  }

  toJSON(): StatementRequest {
    return this.#request
  }

  then<R1 = Awaited<Query<T>>, R2 = never>(
    onfulfilled?: ((value: Awaited<Query<T>>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#query.then(({ q }) => q.then(onfulfilled, onrejected), onrejected)
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null) {
    return this.#query.then(({ q }) => q.catch(onrejected), onrejected)
  }

  finally(onfinally?: (() => void) | null) {
    return this.#query.then(({ q }) => q.finally(onfinally), (err) => {
      onfinally?.()
      throw err
    })
  }

  values() {
    return this.#query.then(({ q }) => q.values())
  }

  raw() {
    return this.#query.then(({ q }) => q.raw())
  }

  first() {
    return this.#query.then(({ q }) => q.first())
  }

  run() {
    return this.#query.then(({ q }) => q.run())
  }
}

/** A live query that subscribes once `ready` settles, forwarding the inner subscription's events. */
function pendingLive<T>(ready: Promise<void>, make: () => LiveQuery<T>): LiveQuery<T> {
  return new LiveQuery<T>((sink, { key }) => {
    let inner: LiveQuery<T> | null = null
    let stopped = false
    ready.then(
      () => {
        if (stopped) return
        inner = make()
        if (key !== null) inner.key(key)
        inner.on("rows", (e) => sink.rows(e)).on("diff", (e) => sink.diff(e)).on("error", (e) => sink.error(e))
      },
      (err) => sink.error(err),
    )
    return () => {
      stopped = true
      inner?.close()
    }
  })
}

function bind<S extends Schema, E extends Executor>(raw: E, ensure: (() => Promise<void>) | null): TypedDb<S, E> {
  let ready = ensure === null
  // Null once the sync has succeeded, so every later call is the executor's own.
  const gate = (): Promise<void> | null => (ready || !ensure ? null : ensure().then(() => void (ready = true)))
  const db: Record<string, unknown> = {
    raw,
    query: (sql: string, args?: QueryArgs) => {
      const wait = gate()
      return wait ? new Pending(wait, () => raw.execute(sql, args), sql, args) : raw.execute(sql, args)
    },
  }
  const live = (raw as Partial<Live>).live
  if (typeof live === "function") {
    db.live = (sql: string, args?: QueryArgs) => {
      const wait = gate()
      return wait ? pendingLive(wait, () => live.call(raw, sql, args)) : live.call(raw, sql, args)
    }
  }
  const transaction = (raw as Partial<Transactional>).transaction
  if (typeof transaction === "function") {
    db.transaction = async <T>(fn: (tx: TypedDb<S, Tx>) => Promise<T> | T, options?: TransactionOptions) => {
      await gate()
      return transaction.call(raw, (tx: Tx) => fn(bind<S, Tx>(tx, null)), options)
    }
  }
  return db as TypedDb<S, E>
}

type SchemaOf<D> = D extends SchemaDef<infer S, readonly string[]> ? S : never

/** A table's row: `Table<typeof app, "users">`. The name is lower case, as SQLite compares it. */
export type Table<D extends SchemaDef<any, any>, T extends keyof SchemaOf<D> & string> = SchemaOf<D>[T]["cols"] extends infer C extends Record<
  string,
  Col
>
  ? Prettify<{ [K in keyof C as C[K]["name"]]: C[K]["nullable"] extends true ? C[K]["type"] | null : C[K]["type"] }>
  : never

/** A query's row: `Row<typeof app, "select id, name from users">`. */
export type Row<D extends SchemaDef<any, any>, Q extends string> = RowOf<Analyze<SchemaOf<D>, Q>>
