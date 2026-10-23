// Types only. A schema, read out of the same DDL strings the database runs.
//
// The affinity rules are SQLite's own "determination of column affinity", the ones
// `dataapi/introspect.ts` applies at runtime, plus one exception: a NUMERIC column declared `date`,
// `datetime`, `timestamp` or `time` is a string. `current_timestamp` is text that NUMERIC can't
// convert, so SQLite stores it as text.
//
// Non-null is `not null`, or a primary key that SQLite actually refuses NULL in: `integer primary
// key` (the rowid; not `int primary key`, not `integer primary key desc`), or any primary key of a
// STRICT or WITHOUT ROWID table. Every other primary key accepts NULL. That is a SQLite quirk kept
// for compatibility, and it is checked.

import type { JsValue } from "../client/values.ts"
import type { Group, Has, HasPair, Lex, Skip, SplitTop, Top, Unquote, Until } from "./lex.ts"
import type { SelectCols, ToTable } from "./query.ts"

/** One result or table column. `name` is the spelling SQLite reports; lookups are by lower case. */
export interface Col {
  name: string
  type: unknown
  nullable: boolean
}

export interface TableDef {
  /** Keyed by lower-cased column name. */
  cols: Record<string, Col>
  /** Lower-cased column names in declaration order, which is what `*` and `insert` without a column list follow. */
  order: string[]
  /** Whether `rowid`, `oid` and `_rowid_` exist. */
  rowid: boolean
  /** A table whose columns aren't known: a non-FTS virtual table, a table-valued function. */
  loose: boolean
}

/** Keyed by lower-cased table name. */
export type Schema = Record<string, TableDef>

export type LooseTable = { cols: {}; order: []; rowid: true; loose: true }

export type ParseSchema<D extends readonly string[], S extends Schema = {}> = D extends readonly [
  infer H extends string,
  ...infer R extends readonly string[],
]
  ? ParseSchema<R, ApplyAll<S, SplitTop<Lex<H>, ";">>>
  : S

type ApplyAll<S extends Schema, T extends string[][]> = T extends [
  infer H extends string[],
  ...infer R extends string[][],
]
  ? ApplyAll<Apply<S, H>, R>
  : S

/** A table name without its schema prefix or quotes, lower case. */
export type TableName<W extends string> =
  Unquote<W> extends `${"main" | "temp"}.${infer N}` ? Lowercase<Unquote<N>> : Lowercase<Unquote<W>>

export type Put<S extends Schema, K extends string, T extends TableDef> = {
  [P in keyof S | K]: P extends K ? T : S[P & keyof S]
}

type Remove<S extends Schema, K extends string> = { [P in keyof S as P extends K ? never : P]: S[P] }

type IfNotExists<T extends string[]> = T extends [
  infer A extends string,
  infer B extends string,
  infer C extends string,
  ...infer R extends string[],
]
  ? [Lowercase<A>, Lowercase<B>, Lowercase<C>] extends ["if", "not", "exists"]
    ? R
    : T
  : T

type IfExists<T extends string[]> = T extends [infer A extends string, infer B extends string, ...infer R extends string[]]
  ? [Lowercase<A>, Lowercase<B>] extends ["if", "exists"]
    ? R
    : T
  : T

type Apply<S extends Schema, T extends string[]> = T extends [infer K extends string, ...infer R extends string[]]
  ? Lowercase<K> extends "create"
    ? Create<S, Skip<R, "temp" | "temporary">>
    : Lowercase<K> extends "alter"
      ? Alter<S, R>
      : Lowercase<K> extends "drop"
        ? Drop<S, R>
        : S
  : S

type Create<S extends Schema, T extends string[]> = T extends [infer K extends string, ...infer R extends string[]]
  ? Lowercase<K> extends "table"
    ? CreateTable<S, IfNotExists<R>>
    : Lowercase<K> extends "view"
      ? CreateView<S, IfNotExists<R>>
      : Lowercase<K> extends "virtual"
        ? R extends [string, ...infer V extends string[]]
          ? CreateVirtual<S, IfNotExists<V>>
          : S
        : S
  : S

type CreateTable<S extends Schema, T extends string[]> = T extends [infer N extends string, ...infer R extends string[]]
  ? R extends ["(", ...string[]]
    ? Group<R> extends [infer Body extends string[], infer After extends string[]]
      ? Put<S, TableName<N>, Columns<SplitTop<Body>, Has<After, "strict"> | Has<After, "without">>>
      : S
    : R extends [infer As extends string, ...infer Sel extends string[]]
      ? Lowercase<As> extends "as"
        ? Put<S, TableName<N>, FromSelect<S, Sel>>
        : S
      : S
  : S

type CreateView<S extends Schema, T extends string[]> = T extends [infer N extends string, ...infer R extends string[]]
  ? R extends [infer As extends string, ...infer Sel extends string[]]
    ? Lowercase<As> extends "as"
      ? Put<S, TableName<N>, FromSelect<S, Sel>>
      : Put<S, TableName<N>, LooseTable>
    : S
  : S

/** A table whose columns are a select's: `create view`, `create table … as`, a CTE. */
export type FromSelect<S extends Schema, Sel extends string[]> = SelectCols<Sel, S, []> extends infer C
  ? C extends Col[]
    ? ToTable<C>
    : LooseTable
  : never

/** FTS3/4/5 columns are text and may be NULL. Anything else is a module whose columns we don't know. */
type CreateVirtual<S extends Schema, T extends string[]> = T extends [
  infer N extends string,
  infer U extends string,
  infer M extends string,
  "(",
  ...infer R extends string[],
]
  ? Lowercase<U> extends "using"
    ? Lowercase<M> extends "fts3" | "fts4" | "fts5"
      ? Group<["(", ...R]> extends [infer Body extends string[], string[]]
        ? Put<S, TableName<N>, FtsColumns<SplitTop<Body>>>
        : S
      : Put<S, TableName<N>, LooseTable>
    : S
  : S

type FtsColumns<Items extends string[][], Cols extends Record<string, Col> = {}, Order extends string[] = []> = Items extends [
  infer H extends string[],
  ...infer R extends string[][],
]
  ? H extends [infer Name extends string, ...string[]]
    ? Has<H, "="> extends true
      ? FtsColumns<R, Cols, Order>
      : FtsColumns<
          R,
          Cols & { [K in Lowercase<Unquote<Name>>]: { name: Unquote<Name>; type: string; nullable: true } },
          [...Order, Lowercase<Unquote<Name>>]
        >
    : FtsColumns<R, Cols, Order>
  : { cols: { [K in keyof Cols]: Cols[K] }; order: Order; rowid: true; loose: false }

type TableConstraint = "constraint" | "primary" | "unique" | "check" | "foreign"
type ColumnConstraint =
  | "constraint"
  | "primary"
  | "not"
  | "null"
  | "unique"
  | "check"
  | "default"
  | "collate"
  | "references"
  | "generated"
  | "as"

/** `PkNotNull` is true for a STRICT or WITHOUT ROWID table, where every primary key refuses NULL. */
type Columns<
  Items extends string[][],
  PkNotNull extends boolean,
  Cols extends Record<string, Col> = {},
  Order extends string[] = [],
> = Items extends [infer H extends string[], ...infer R extends string[][]]
  ? H extends [infer Name extends string, ...infer Rest extends string[]]
    ? Lowercase<Name> extends TableConstraint
      ? Columns<R, PkNotNull, Cols, Order>
      : ColumnOf<Unquote<Name>, Rest, PkNotNull> extends infer C extends Col
        ? Columns<R, PkNotNull, Cols & { [K in Lowercase<C["name"]>]: C }, [...Order, Lowercase<C["name"]>]>
        : never
    : Columns<R, PkNotNull, Cols, Order>
  : { cols: { [K in keyof Cols]: Cols[K] }; order: Order; rowid: true; loose: false }

export type ColumnOf<Name extends string, Rest extends string[], PkNotNull extends boolean> =
  Until<Rest, ColumnConstraint> extends [infer TypeToks extends string[], infer Cons extends string[]]
    ? Declared<TypeToks> extends infer D extends string
      ? {
          name: Name
          type: Affinity<D>
          nullable: HasPair<Top<Cons>, "not", "null"> extends true
            ? false
            : Has<Top<Cons>, "primary"> extends true
              ? true extends PkNotNull
                ? false
                : D extends "integer"
                  ? Has<Top<Cons>, "desc"> extends true
                    ? true
                    : false
                  : true
              : true
        }
      : never
    : never

/** The declared type as one lower-case string, without its `(10)`. */
type Declared<T extends string[], Acc extends string = ""> = T extends [infer H extends string, ...infer R extends string[]]
  ? H extends "(" | ")" | "," | `${number}`
    ? Declared<R, Acc>
    : Declared<R, Acc extends "" ? Lowercase<H> : `${Acc} ${Lowercase<H>}`>
  : Acc

export type Affinity<D extends string> = D extends `${string}int${string}`
  ? number
  : D extends `${string}char${string}` | `${string}clob${string}` | `${string}text${string}`
    ? string
    : D extends `${string}blob${string}`
      ? Uint8Array
      : D extends "" | "any"
        ? JsValue
        : D extends `${string}real${string}` | `${string}floa${string}` | `${string}doub${string}`
          ? number
          : D extends `${string}date${string}` | `${string}time${string}`
            ? string
            : number

type Alter<S extends Schema, T extends string[]> = T extends [
  infer K extends string,
  infer N extends string,
  infer Op extends string,
  ...infer R extends string[],
]
  ? Lowercase<K> extends "table"
    ? TableName<N> extends infer Name extends keyof S & string
      ? Lowercase<Op> extends "add"
        ? AddColumn<S, Name, Skip<R, "column">>
        : Lowercase<Op> extends "drop"
          ? DropColumn<S, Name, Skip<R, "column">>
          : Lowercase<Op> extends "rename"
            ? Rename<S, Name, R>
            : S
      : S
    : S
  : S

type AddColumn<S extends Schema, Name extends keyof S & string, T extends string[]> = T extends [
  infer C extends string,
  ...infer Rest extends string[],
]
  ? ColumnOf<Unquote<C>, Rest, false> extends infer Def extends Col
    ? Put<
        S,
        Name,
        {
          cols: S[Name]["cols"] & { [K in Lowercase<Def["name"]>]: Def }
          order: [...S[Name]["order"], Lowercase<Def["name"]>]
          rowid: S[Name]["rowid"]
          loose: S[Name]["loose"]
        }
      >
    : S
  : S

type Without<O extends string[], C extends string> = O extends [infer H extends string, ...infer R extends string[]]
  ? H extends C
    ? Without<R, C>
    : [H, ...Without<R, C>]
  : []

type DropColumn<S extends Schema, Name extends keyof S & string, T extends string[]> = T extends [
  infer C extends string,
  ...string[],
]
  ? Put<
      S,
      Name,
      {
        cols: { [K in keyof S[Name]["cols"] as K extends Lowercase<Unquote<C>> ? never : K]: S[Name]["cols"][K] }
        order: Without<S[Name]["order"], Lowercase<Unquote<C>>>
        rowid: S[Name]["rowid"]
        loose: S[Name]["loose"]
      }
    >
  : S

type Renamed<O extends string[], From extends string, To extends string> = { [I in keyof O]: O[I] extends From ? To : O[I] }

/** `rename to t2` and `rename [column] a to b`. */
type Rename<S extends Schema, Name extends keyof S & string, T extends string[]> = T extends [
  infer A extends string,
  infer B extends string,
  ...infer R extends string[],
]
  ? Lowercase<A> extends "to"
    ? Put<Remove<S, Name>, TableName<B>, S[Name]>
    : Skip<T, "column"> extends [infer From extends string, infer To_ extends string, infer To extends string, ...string[]]
      ? Lowercase<To_> extends "to"
        ? Put<
            S,
            Name,
            {
              cols: {
                [K in keyof S[Name]["cols"] as K extends Lowercase<Unquote<From>> ? Lowercase<Unquote<To>> : K]: K extends Lowercase<
                  Unquote<From>
                >
                  ? { name: Unquote<To>; type: S[Name]["cols"][K]["type"]; nullable: S[Name]["cols"][K]["nullable"] }
                  : S[Name]["cols"][K]
              }
              order: Renamed<S[Name]["order"], Lowercase<Unquote<From>>, Lowercase<Unquote<To>>>
              rowid: S[Name]["rowid"]
              loose: S[Name]["loose"]
            }
          >
        : S
      : S
  : S

type Drop<S extends Schema, T extends string[]> = T extends [infer K extends string, ...infer R extends string[]]
  ? Lowercase<K> extends "table" | "view"
    ? IfExists<R> extends [infer N extends string, ...string[]]
      ? Remove<S, TableName<N>>
      : S
    : S
  : S
