// Types only. A statement's result columns and parameter types, read out of its text against a
// `Schema` from `ddl.ts`.
//
// It fails open. An `Err` means the statement is wrong for sure: a table or a result column that
// doesn't exist, or a result column two tables share. Syntax this file doesn't follow yields
// `Untyped`, which `index.ts` turns into `JsRow` rows and untyped arguments. Inside an operator
// expression a column that doesn't resolve only makes the result nullable, because the operand
// scan there can't always tell a column from a keyword.

import type { JsValue } from "../client/values.ts"
import type { Affinity, Col, LooseTable, Put, Schema, TableDef, TableName } from "./ddl.ts"
import type { Group, Has, Last, Skip, SplitTop, Top, Unquote, Until } from "./lex.ts"

export type Err<M extends string = string, Miss = unknown> = { error: `bql: ${M}`; miss: Miss }

/** What an `Err` couldn't find, for `complete.ts` to offer replacements: the token as written and where it was looked for. */
export type Miss =
  | { kind: "table"; token: string }
  | { kind: "column"; token: string; scope: Src[] }
  | { kind: "ambiguous"; token: string; scope: Src[] }
export type Untyped = { untyped: true }

/** A table in scope: what it's called in this statement, and whether an outer join can null it. */
export interface Src {
  alias: string
  table: TableDef
  nullable: boolean
}

/**
 * An expression's type. `name` is set when the expression is a bare column, whose name SQLite
 * reports. An unaliased expression becomes a column named `never`: it keeps its position, for a
 * scalar subquery or a `union`, and gets no key in the row.
 */
interface Ty {
  name?: string
  type: unknown
  nullable: boolean
}

type Unknown = { type: JsValue; nullable: true }
type T_<T, N extends boolean> = { type: T; nullable: N }

type Or<A extends boolean, B extends boolean> = true extends A | B ? true : false
type Not<A extends boolean> = A extends true ? false : true

type Clause = "from" | "where" | "group" | "having" | "order" | "limit" | "window" | Compound | "returning"
type Compound = "union" | "intersect" | "except"

type Keyword =
  | Clause
  | "select" | "as" | "on" | "using" | "join" | "left" | "right" | "full" | "inner" | "cross" | "natural"
  | "outer" | "and" | "or" | "not" | "is" | "in" | "like" | "glob" | "regexp" | "match" | "between"
  | "case" | "when" | "then" | "else" | "end" | "null" | "true" | "false" | "distinct" | "all"
  | "collate" | "escape" | "exists" | "indexed" | "by" | "asc" | "desc" | "set" | "values"
  | "current_timestamp" | "current_date" | "current_time" | "filter" | "over"

type Operator =
  | "=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%" | "||" | "&" | "|"
  | "<<" | ">>" | "~" | "->" | "->>" | "!" | "." | "(" | ","

type Comparison = "=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">=" | "is" | "like" | "glob"

/** A letter or `_`: the first character of an unquoted identifier. */
type IsIdent<W extends string> = W extends `"${string}"`
  ? true
  : W extends `${infer C}${string}`
    ? C extends "_"
      ? true
      : Lowercase<C> extends Uppercase<C>
        ? false
        : true
    : false

type IsParam<W extends string> = W extends `${":" | "@" | "$" | "?"}${string}` ? true : false

// ---------------------------------------------------------------------------------------------
// select

/** A select's result columns in order, or why it can't have any. `Outer` is the enclosing scope. */
export type SelectCols<T extends string[], S extends Schema, Outer extends Src[]> = T extends [
  infer K extends string,
  ...infer R extends string[],
]
  ? Lowercase<K> extends "select"
    ? SelectBody<Skip<R, "distinct" | "all">, S, Outer>
    : Lowercase<K> extends "with"
      ? With<R, S> extends [infer S2 extends Schema, infer Main extends string[]]
        ? SelectCols<Main, S2, Outer>
        : With<R, S>
      : Untyped
  : Untyped

type SelectBody<T extends string[], S extends Schema, Outer extends Src[]> =
  Until<T, Clause> extends [infer Items extends string[], infer Rest extends string[]]
    ? Rest extends [infer F extends string, ...infer RR extends string[]]
      ? Lowercase<F> extends "from"
        ? Until<RR, Exclude<Clause, "from">> extends [infer FromToks extends string[], infer Tail extends string[]]
          ? WithScope<Items, From<FromToks, S, Outer>, Tail, S, Outer>
          : Untyped
        : WithScope<Items, [], Rest, S, Outer>
      : WithScope<Items, [], Rest, S, Outer>
    : Untyped

type WithScope<Items extends string[], Scope, Tail extends string[], S extends Schema, Outer extends Src[]> =
  Scope extends Src[]
    ? ItemCols<SplitTop<Items>, { scope: Scope; outer: Outer; grouped: Has<Top<Tail>, "group">; schema: S }> extends infer C
      ? C extends Col[]
        ? Compounded<C, Tail, S, Outer>
        : C
      : never
    : Scope

/** `union` widens each column by the matching column of the next part. */
type Compounded<C extends Col[], Tail extends string[], S extends Schema, Outer extends Src[]> =
  Until<Tail, Compound> extends [string[], [infer U extends string, ...infer Next extends string[]]]
    ? Lowercase<U> extends "union"
      ? SelectCols<Skip<Next, "all">, S, Outer> extends infer N extends Col[]
        ? { [I in keyof C]: I extends keyof N ? Widen<C[I], N[I]> : C[I] }
        : C
      : C
    : C

type Widen<A, B> = A extends Col
  ? B extends Col
    ? { name: A["name"]; type: A["type"] | B["type"]; nullable: Or<A["nullable"], B["nullable"]> }
    : A
  : A

interface Ctx {
  scope: Src[]
  outer: Src[]
  grouped: boolean
  schema: Schema
}

type ItemCols<Items extends string[][], C extends Ctx, Acc extends Col[] = []> = Items extends [
  infer H extends string[],
  ...infer R extends string[][],
]
  ? H extends ["*"]
    ? Star<C["scope"]> extends infer X
      ? X extends Col[]
        ? ItemCols<R, C, [...Acc, ...X]>
        : X
      : never
    : H extends [`${infer A}.`, "*"]
      ? FindSrc<C["scope"], Lowercase<Unquote<A>>> extends infer Found
        ? Found extends Src
          ? Found["table"]["loose"] extends true
            ? Untyped
            : StarOf<Found> extends infer X extends Col[]
              ? ItemCols<R, C, [...Acc, ...X]>
              : never
          : Err<`no such table: ${A}`, { kind: "table"; token: A }>
        : never
      : SplitAlias<H> extends [infer E extends string[], infer Alias extends string | null]
        ? ExprCol<E, C> extends infer X
          ? X extends Ty
            ? Alias extends string
              ? ItemCols<R, C, [...Acc, { name: Alias; type: X["type"]; nullable: X["nullable"] }]>
              : ItemCols<R, C, [...Acc, { name: X["name"] extends string ? X["name"] : never; type: X["type"]; nullable: X["nullable"] }]>
            : X
          : never
        : never
  : Acc

type Star<Scope extends Src[], Acc extends Col[] = []> = Scope extends [
  infer H extends Src,
  ...infer R extends Src[],
]
  ? H["table"]["loose"] extends true
    ? Untyped
    : StarOf<H> extends infer X extends Col[]
      ? Star<R, [...Acc, ...X]>
      : never
  : Acc

type StarOf<H extends Src> = StarCols<H["table"]["order"], H["table"]["cols"], H["nullable"]>

/** `Order` has to be a type parameter for the mapped type to produce a tuple. */
type StarCols<Order extends string[], Cols extends Record<string, Col>, N extends boolean> = {
  [I in keyof Order]: Cols[Order[I] & keyof Cols] extends infer K extends Col
    ? { name: K["name"]; type: K["type"]; nullable: Or<K["nullable"], N> }
    : never
}

/** `[expression, alias]`. An alias is `as x`, or a trailing identifier after something that can end an expression. */
type SplitAlias<H extends string[]> = H extends [...infer E extends string[], infer As extends string, infer A extends string]
  ? Lowercase<As> extends "as"
    ? [E, Unquote<A>]
    : Implicit<H>
  : Implicit<H>

type Implicit<H extends string[]> = H extends [...infer E extends [string, ...string[]], infer A extends string]
  ? IsIdent<A> extends true
    ? Lowercase<A> extends Keyword
      ? [H, null]
      : Last<E> extends Operator
        ? [H, null]
        : Lowercase<Last<E>> extends Keyword
          ? [H, null]
          : [E, Unquote<A>]
    : [H, null]
  : [H, null]

// ---------------------------------------------------------------------------------------------
// expressions

type ExprCol<E extends string[], C extends Ctx> = E extends [infer One extends string]
  ? Atom<One, C>
  : E extends ["(", ...string[]]
    ? Group<E> extends [infer Inner extends string[], []]
      ? Inner extends [infer K extends string, ...string[]]
        ? Lowercase<K> extends "select" | "with"
          ? Scalar<SelectCols<Inner, C["schema"], [...C["scope"], ...C["outer"]]>>
          : ExprCol<Inner, C>
        : Unknown
      : Operators<E, C>
    : E extends [infer F extends string, "(", ...infer R extends string[]]
      ? Group<["(", ...R]> extends [infer Inner extends string[], infer After extends string[]]
        ? After extends [] | [`${"over" | "filter" | "OVER" | "FILTER"}`, ...string[]]
          ? Lowercase<F> extends "cast"
            ? Cast<Inner, C>
            : Lowercase<F> extends "exists"
              ? T_<number, false>
              : Fn<Lowercase<F>, SplitTop<Inner>, C>
          : Operators<E, C>
        : Unknown
      : E extends [infer K extends string, ...infer R extends string[]]
        ? Lowercase<K> extends "case"
          ? Case<R, C>
          : Lowercase<K> extends "not"
            ? T_<number, true>
            : K extends "-" | "+"
              ? R extends [infer N extends string]
                ? N extends `${number}`
                  ? T_<number, false>
                  : Operators<E, C>
                : Operators<E, C>
              : Operators<E, C>
        : Unknown

type Scalar<X> = X extends [infer First extends Col, ...Col[]]
  ? T_<First["type"], true>
  : X extends Err
    ? X
    : Unknown

type Atom<A extends string, C extends Ctx> = A extends `'${string}'`
  ? T_<string, false>
  : A extends `${number}`
    ? T_<number, false>
    : Lowercase<A> extends "null"
      ? T_<never, true>
      : Lowercase<A> extends "true" | "false"
        ? T_<number, false>
        : Lowercase<A> extends "current_timestamp" | "current_date" | "current_time"
          ? T_<string, false>
          : IsParam<A> extends true
            ? Unknown
            : A extends `${infer T}.${infer Name}`
              ? Name extends `${string}.${string}`
                ? Unknown
                : Qualified<Lowercase<Unquote<T>>, Unquote<Name>, A, C>
              : IsIdent<A> extends true
                ? Resolve<Unquote<A>, C>
                : Unknown

type FindSrc<Scope extends Src[], Alias extends string> = Scope extends [infer H extends Src, ...infer R extends Src[]]
  ? H["alias"] extends Alias
    ? H
    : FindSrc<R, Alias>
  : null

type ColIn<H extends Src, N extends string, Written extends string> = H["table"]["loose"] extends true
  ? { name: Written; type: JsValue; nullable: true }
  : Lowercase<N> extends keyof H["table"]["cols"]
    ? H["table"]["cols"][Lowercase<N>] extends infer K extends Col
      ? { name: K["name"]; type: K["type"]; nullable: Or<K["nullable"], H["nullable"]> }
      : never
    : Lowercase<N> extends "rowid" | "oid" | "_rowid_"
      ? H["table"]["rowid"] extends true
        ? { name: Written; type: number; nullable: H["nullable"] }
        : null
      : null

type Qualified<Alias extends string, N extends string, Written extends string, C extends Ctx> =
  FindSrc<[...C["scope"], ...C["outer"]], Alias> extends infer H
    ? H extends Src
      ? ColIn<H, N, N> extends infer K
        ? K extends Ty
          ? K
          : Err<`no such column: ${Written}`, { kind: "column"; token: Written; scope: [H] }>
        : never
      : Err<`no such column: ${Written}`, { kind: "column"; token: Written; scope: [...C["scope"], ...C["outer"]] }>
    : never

type Matches<Scope extends Src[], N extends string, Acc extends Ty[] = []> = Scope extends [
  infer H extends Src,
  ...infer R extends Src[],
]
  ? H["table"]["loose"] extends true
    ? Matches<R, N, Acc>
    : ColIn<H, N, N> extends infer K
      ? K extends Ty
        ? Matches<R, N, [...Acc, K]>
        : Matches<R, N, Acc>
      : never
  : Acc

type AnyLoose<Scope extends Src[]> = true extends Scope[number]["table"]["loose"] ? true : false

/** The innermost scope that has the column wins, as in SQLite. */
type Resolve<N extends string, C extends Ctx> = Matches<C["scope"], N> extends infer M
  ? M extends [infer One extends Ty]
    ? One
    : M extends [Ty, Ty, ...Ty[]]
      ? Err<`ambiguous column name: ${N}`, { kind: "ambiguous"; token: N; scope: C["scope"] }>
      : Matches<C["outer"], N> extends [infer One extends Ty, ...Ty[]]
        ? One
        : AnyLoose<[...C["scope"], ...C["outer"]]> extends true
          ? { name: N; type: JsValue; nullable: true }
          : Err<`no such column: ${N}`, { kind: "column"; token: N; scope: [...C["scope"], ...C["outer"]] }>
  : never

type Cast<Inner extends string[], C extends Ctx> =
  Until<Inner, "as"> extends [infer X extends string[], [string, ...infer TypeToks extends string[]]]
    ? ExprCol<X, C> extends infer V
      ? V extends Ty
        ? T_<Affinity<Lowercase<Words<TypeToks>>>, V["nullable"]>
        : V
      : never
    : Unknown

type Words<T extends string[], Acc extends string = ""> = T extends [infer H extends string, ...infer R extends string[]]
  ? H extends "(" | ")" | "," | `${number}`
    ? Words<R, Acc>
    : Words<R, Acc extends "" ? H : `${Acc} ${H}`>
  : Acc

/** Result types of each `then` and the `else`; without an `else` the result can be NULL. */
type Case<T extends string[], C extends Ctx, Acc extends Ty[] = []> =
  Until<T, "then" | "else"> extends [string[], [infer K extends string, ...infer R extends string[]]]
    ? Lowercase<K> extends "then"
      ? Until<R, "when" | "else" | "end"> extends [infer Res extends string[], infer Rest extends string[]]
        ? ExprCol<Res, C> extends infer V
          ? V extends Ty
            ? Case<Rest, C, [...Acc, V]>
            : V
          : never
        : never
      : Until<R, "end"> extends [infer Res extends string[], string[]]
        ? ExprCol<Res, C> extends infer V
          ? V extends Ty
            ? T_<[...Acc, V][number]["type"], true extends [...Acc, V][number]["nullable"] ? true : false>
            : V
          : never
        : never
    : T_<Acc[number]["type"], true>

/**
 * A binary-operator expression, typed by its loosest operator. Nullable when any operand might be
 * NULL; an operand that doesn't resolve counts as nullable rather than as an error.
 */
type Operators<E extends string[], C extends Ctx> = Lowercase<Top<E>[number]> extends infer Ops
  ? [Ops & ("and" | "or" | "not" | "in" | "between" | "regexp" | "match" | "exists" | Comparison)] extends [never]
    ? [Ops & "||"] extends [never]
      ? [Ops & "->>"] extends [never]
        ? [Ops & "->"] extends [never]
          ? [Ops & ("+" | "-" | "*" | "/" | "%" | "&" | "|" | "<<" | ">>" | "~")] extends [never]
            ? [Ops & "collate"] extends [never]
              ? Unknown
              : Until<E, "collate"> extends [infer X extends string[], string[]]
                ? ExprCol<X, C>
                : Unknown
            : T_<number, OperandsNull<E, C>>
          : T_<string, true>
        : Unknown
      : T_<string, OperandsNull<E, C>>
    : T_<number, "is" extends Ops ? false : OperandsNull<E, C>>
  : never

type OperandsNull<E extends string[], C extends Ctx> = "(" extends E[number] ? true : AnyNullOperand<E, C>

type AnyNullOperand<E extends string[], C extends Ctx> = E extends [infer H extends string, ...infer R extends string[]]
  ? H extends Operator
    ? AnyNullOperand<R, C>
    : Lowercase<H> extends Exclude<Keyword, "null" | "current_timestamp" | "current_date" | "current_time" | "true" | "false">
      ? AnyNullOperand<R, C>
      : Atom<H, C> extends infer V
        ? V extends Ty
          ? V["nullable"] extends true
            ? true
            : AnyNullOperand<R, C>
          : true
        : never
  : false

// ---------------------------------------------------------------------------------------------
// functions

type ArgTys<Args extends string[][], C extends Ctx, Acc extends Ty[] = []> = Args extends [
  infer H extends string[],
  ...infer R extends string[][],
]
  ? ExprCol<Skip<H, "distinct">, C> extends infer V
    ? V extends Ty
      ? ArgTys<R, C, [...Acc, V]>
      : V
    : never
  : Acc

type Fn<F extends string, Args extends string[][], C extends Ctx> = F extends "count"
  ? T_<number, false>
  : ArgTys<Args, C> extends infer A
    ? A extends Ty[]
      ? FnOf<F, A, C["grouped"]>
      : A
    : never

type AnyNull<A extends Ty[]> = true extends A[number]["nullable"] ? true : false
type AllNull<A extends Ty[]> = false extends A[number]["nullable"] ? false : true
type At<A extends Ty[], I extends number> = A[I] extends Ty ? A[I] : Unknown

type StringFn =
  | "lower" | "upper" | "trim" | "ltrim" | "rtrim" | "replace" | "substr" | "substring" | "char"
  | "soundex" | "json_type" | "unistr" | "group_concat" | "string_agg"
type NumberFn =
  | "length" | "octet_length" | "abs" | "round" | "instr" | "unicode" | "sign" | "ceil" | "ceiling"
  | "floor" | "trunc" | "sqrt" | "exp" | "ln" | "log" | "log10" | "log2" | "pow" | "power" | "mod"
  | "acos" | "asin" | "atan" | "atan2" | "cos" | "sin" | "tan" | "degrees" | "radians" | "pi"
  | "json_array_length"
type AlwaysNumberFn =
  | "total" | "random" | "changes" | "total_changes" | "last_insert_rowid" | "row_number" | "rank"
  | "dense_rank" | "ntile" | "percent_rank" | "cume_dist" | "json_valid" | "like" | "glob"
type AlwaysStringFn =
  | "concat" | "concat_ws" | "quote" | "printf" | "format" | "typeof" | "sqlite_version" | "hex"
  | "json_object" | "json_array" | "json_group_array" | "json_group_object" | "json_quote"
type JsonFn = "json" | "json_insert" | "json_replace" | "json_set" | "json_remove" | "json_patch"

type FnOf<F extends string, A extends Ty[], G extends boolean> = F extends AlwaysNumberFn
  ? T_<number, false>
  : F extends AlwaysStringFn
    ? T_<string, false>
    : F extends "sum" | "avg"
      ? T_<number, Or<AnyNull<A>, Not<G>>>
      : F extends "min" | "max"
        ? A extends [infer X extends Ty]
          ? T_<X["type"], Or<X["nullable"], Not<G>>>
          : T_<A[number]["type"], AnyNull<A>>
        : F extends "group_concat" | "string_agg"
          ? T_<string, Or<AnyNull<A>, Not<G>>>
          : F extends "coalesce" | "ifnull"
            ? T_<A[number]["type"], AllNull<A>>
            : F extends "nullif"
              ? T_<At<A, 0>["type"], true>
              : F extends "iif"
                ? T_<At<A, 1>["type"] | At<A, 2>["type"], Or<At<A, 1>["nullable"], At<A, 2>["nullable"]>>
                : F extends StringFn | JsonFn
                  ? T_<string, AnyNull<A>>
                  : F extends NumberFn
                    ? T_<number, AnyNull<A>>
                    : F extends "date" | "time" | "datetime" | "strftime" | "timediff"
                      ? T_<string, true>
                      : F extends "julianday" | "unixepoch"
                        ? T_<number, true>
                        : F extends "lag" | "lead" | "first_value" | "last_value" | "nth_value"
                          ? T_<At<A, 0>["type"], true>
                          : F extends "likely" | "unlikely" | "likelihood"
                            ? At<A, 0>
                            : F extends "randomblob" | "zeroblob"
                              ? T_<Uint8Array, false>
                              : F extends "unhex"
                                ? T_<Uint8Array, true>
                                : Unknown

// ---------------------------------------------------------------------------------------------
// from

type JoinStart = "join" | "left" | "right" | "full" | "inner" | "cross" | "natural" | ","

type From<
  T extends string[],
  S extends Schema,
  Outer extends Src[],
  Acc extends Src[] = [],
  Kind extends string = "none",
> = T extends []
  ? Acc
  : Source<T, S, Outer> extends infer X
    ? X extends [infer Alias extends string, infer Table extends TableDef, infer Rest extends string[]]
      ? (Kind extends "right" | "full" ? NullAll<Acc> : Acc) extends infer Prev extends Src[]
        ? [...Prev, { alias: Alias; table: Table; nullable: Kind extends "left" | "full" ? true : false }] extends infer Next extends
            Src[]
          ? Until<Rest, JoinStart> extends [string[], infer Rest2 extends string[]]
            ? Rest2 extends []
              ? Next
              : JoinOp<Rest2> extends [infer K extends string, infer Rest3 extends string[]]
                ? From<Rest3, S, Outer, Next, K>
                : Next
            : Next
          : never
        : never
      : X
    : never

type NullAll<Acc extends Src[]> = { [I in keyof Acc]: { alias: Acc[I]["alias"]; table: Acc[I]["table"]; nullable: true } }

/** The join operator's kind and the tokens after it. */
type JoinOp<T extends string[], Kind extends string = "none"> = T extends [infer H extends string, ...infer R extends string[]]
  ? H extends ","
    ? [Kind, R]
    : Lowercase<H> extends "join"
      ? [Kind, R]
      : Lowercase<H> extends "left" | "right" | "full"
        ? JoinOp<R, Lowercase<H>>
        : JoinOp<R, Kind>
  : [Kind, []]

/** One table in a from clause, as `[alias, table, rest]`. */
type Source<T extends string[], S extends Schema, Outer extends Src[]> = T extends ["(", ...string[]]
  ? Group<T> extends [infer Inner extends string[], infer Rest extends string[]]
    ? Inner extends [infer K extends string, ...string[]]
      ? Lowercase<K> extends "select" | "with"
        ? SelectCols<Inner, S, Outer> extends infer Cols
          ? Cols extends Col[]
            ? [AliasOf<Rest, "">[0], ToTable<Cols>, AliasOf<Rest, "">[1]]
            : Cols extends Err
              ? Cols
              : [AliasOf<Rest, "">[0], LooseTable, AliasOf<Rest, "">[1]]
          : never
        : Untyped
      : Untyped
    : Untyped
  : T extends [infer N extends string, "(", ...infer R extends string[]]
    ? Group<["(", ...R]> extends [string[], infer Rest extends string[]]
      ? [AliasOf<Rest, Lowercase<N>>[0], LooseTable, AliasOf<Rest, Lowercase<N>>[1]]
      : Untyped
    : T extends [infer N extends string, ...infer Rest extends string[]]
      ? TableName<N> extends infer Name extends string
        ? Name extends keyof S
          ? [AliasOf<Rest, Name>[0], S[Name], AliasOf<Rest, Name>[1]]
          : Name extends `${"sqlite_" | "pragma_"}${string}`
            ? [AliasOf<Rest, Name>[0], LooseTable, AliasOf<Rest, Name>[1]]
            : Err<`no such table: ${N}`, { kind: "table"; token: N }>
        : never
      : Untyped

type AliasOf<Rest extends string[], Default extends string> = Rest extends [
  infer A extends string,
  infer B extends string,
  ...infer R extends string[],
]
  ? Lowercase<A> extends "as"
    ? [Lowercase<Unquote<B>>, R]
    : Bare<Rest, Default>
  : Bare<Rest, Default>

type Bare<Rest extends string[], Default extends string> = Rest extends [infer A extends string, ...infer R extends string[]]
  ? IsIdent<A> extends true
    ? Lowercase<A> extends Keyword
      ? [Default, Rest]
      : [Lowercase<Unquote<A>>, R]
    : [Default, Rest]
  : [Default, Rest]

export type ToTable<C extends Col[]> = {
  cols: { [K in C[number] as Lowercase<K["name"]>]: K }
  order: { [I in keyof C]: Lowercase<C[I]["name"]> }
  rowid: false
  loose: false
}

// ---------------------------------------------------------------------------------------------
// with

/** `[schema with the CTEs added, the main statement]`. */
export type With<T extends string[], S extends Schema> = Skip<T, "recursive"> extends infer R extends string[]
  ? CTEs<R, S, Has<T, "recursive">>
  : never

type CTEs<T extends string[], S extends Schema, Recursive extends boolean> = T extends [
  infer N extends string,
  ...infer R extends string[],
]
  ? (R extends ["(", ...string[]] ? Group<R> : [null, R]) extends [infer Names, infer R2 extends string[]]
    ? Skip<Skip<Skip<R2, "as">, "not">, "materialized"> extends ["(", ...infer B extends string[]]
      ? Group<["(", ...B]> extends [infer Body extends string[], infer After extends string[]]
        ? SelectCols<Body, Recursive extends true ? Put<S, TableName<N>, LooseTable> : S, []> extends infer Cols
          ? Cols extends Err
            ? Cols
            : (Cols extends Col[] ? ToTable<Names extends string[] ? Rename<Cols, SplitTop<Names>> : Cols> : LooseTable) extends infer TD extends TableDef
              ? Put<S, TableName<N>, TD> extends infer S2 extends Schema
                ? After extends [",", ...infer More extends string[]]
                  ? CTEs<More, S2, Recursive>
                  : [S2, After]
                : never
              : never
          : never
        : Untyped
      : Untyped
    : never
  : Untyped

type Rename<C extends Col[], Names extends string[][]> = {
  [I in keyof C]: I extends keyof Names
    ? Names[I] extends [infer N extends string, ...string[]]
      ? { name: Unquote<N>; type: C[I]["type"]; nullable: C[I]["nullable"] }
      : C[I]
    : C[I]
}

// ---------------------------------------------------------------------------------------------
// insert, update, delete

/** A parameter's inferred type; `typed` is false for the fallback, so a typed use wins over it. */
export type Entry = [key: string, type: unknown, typed: boolean]

export type Analyzed = { cols: Col[]; params: Entry[] } | Err | Untyped

/** What a value bound to this column may be. Booleans bind as 1 and 0. */
export type Input<K extends Col, Write extends boolean> = (
  | ([K["type"]] extends [number] ? number | bigint | boolean : [JsValue] extends [K["type"]] ? Param : K["type"])
  | (Write extends true ? (K["nullable"] extends true ? null : never) : never)
) extends infer I
  ? I
  : never

/** Anything the client can bind. */
export type Param = JsValue | Date

type TargetOf<T extends string[], S extends Schema> = T extends [infer N extends string, ...infer Rest extends string[]]
  ? TableName<N> extends infer Name extends string
    ? Name extends keyof S
      ? [AliasOf<Rest, Name>[0], S[Name], AliasOf<Rest, Name>[1]]
      : Err<`no such table: ${N}`, { kind: "table"; token: N }>
    : never
  : Untyped

type Returning<T extends string[], Target extends Src, S extends Schema> =
  Until<T, "returning"> extends [string[], [string, ...infer Items extends string[]]]
    ? ItemCols<SplitTop<Items>, { scope: [Target]; outer: []; grouped: false; schema: S }>
    : []

export type Insert<T extends string[], S extends Schema> =
  TargetOf<Skip<T extends [infer O extends string, string, ...infer R extends string[]] ? (Lowercase<O> extends "or" ? R : T) : T, "into">, S> extends infer X
    ? X extends [infer Alias extends string, infer Table extends TableDef, infer Rest extends string[]]
      ? (Rest extends ["(", ...string[]] ? Group<Rest> : [null, Rest]) extends [infer Names, infer Body extends string[]]
        ? Returning<Body, { alias: Alias; table: Table; nullable: false }, S> extends infer Cols
          ? Cols extends Col[]
            ? {
                cols: Cols
                params: ValuesParams<
                  Body,
                  Names extends string[] ? ColNames<SplitTop<Names>> : Table["order"],
                  Table
                >
              }
            : Cols
          : never
        : never
      : X
    : never

type ColNames<Items extends string[][]> = {
  [I in keyof Items]: Items[I] extends [infer N extends string, ...string[]] ? Lowercase<Unquote<N>> : never
}

/** Each placeholder that is a whole item of a `values` tuple, typed as the column in its position. */
type ValuesParams<T extends string[], Names extends string[], Table extends TableDef> = T extends [
  infer V extends string,
  "(",
  ...infer R extends string[],
]
  ? Lowercase<V> extends "values"
    ? Tuples<["(", ...R], Names, Table>
    : []
  : []

type Tuples<T extends string[], Names extends string[], Table extends TableDef, Acc extends Entry[] = []> = T extends [
  "(",
  ...string[],
]
  ? Group<T> extends [infer Inner extends string[], infer Rest extends string[]]
    ? [...Acc, ...TupleParams<SplitTop<Inner>, Names, Table>] extends infer Next extends Entry[]
      ? Rest extends [",", ...infer More extends string[]]
        ? Tuples<More, Names, Table, Next>
        : Next
      : never
    : Acc
  : Acc

type TupleParams<Items extends string[][], Names extends string[], Table extends TableDef> = {
  [I in keyof Items]: Items[I] extends [infer P extends string]
    ? IsParam<P> extends true
      ? I extends keyof Names
        ? Names[I] extends keyof Table["cols"]
          ? [ParamKey<P>, Input<Table["cols"][Names[I]], true>, true]
          : [ParamKey<P>, Param, false]
        : [ParamKey<P>, Param, false]
      : never
    : never
} extends infer E extends unknown[]
  ? Extract<E[number], Entry>[]
  : []

export type Update<T extends string[], S extends Schema> =
  TargetOf<T extends [infer O extends string, string, ...infer R extends string[]] ? (Lowercase<O> extends "or" ? R : T) : T, S> extends infer X
    ? X extends [infer Alias extends string, infer Table extends TableDef, infer Rest extends string[]]
      ? Rest extends [string, ...infer Assigns extends string[]]
        ? Returning<Rest, { alias: Alias; table: Table; nullable: false }, S> extends infer Cols
          ? Cols extends Col[]
            ? { cols: Cols; params: SetParams<SplitTop<Until<Assigns, "from" | "where" | "returning" | "order" | "limit">[0]>, Table> }
            : Cols
          : never
        : Untyped
      : X
    : never

type SetParams<Items extends string[][], Table extends TableDef> = {
  [I in keyof Items]: Items[I] extends [infer N extends string, "=", infer P extends string]
    ? IsParam<P> extends true
      ? Lowercase<Unquote<N>> extends keyof Table["cols"]
        ? [ParamKey<P>, Input<Table["cols"][Lowercase<Unquote<N>>], true>, true]
        : never
      : never
    : never
} extends infer E extends unknown[]
  ? Extract<E[number], Entry>[]
  : []

export type Delete<T extends string[], S extends Schema> = TargetOf<Skip<T, "from">, S> extends infer X
  ? X extends [infer Alias extends string, infer Table extends TableDef, infer Rest extends string[]]
    ? Returning<Rest, { alias: Alias; table: Table; nullable: false }, S> extends infer Cols
      ? Cols extends Col[]
        ? { cols: Cols; params: [] }
        : Cols
      : never
    : X
  : never

// ---------------------------------------------------------------------------------------------
// parameters anywhere

/** `:id`, `@id` and `$id` bind as `id`; `?N` is position N, kept as `#N-1`. `index.ts` numbers every bare `?`. */
export type ParamKey<P extends string> = P extends `${":" | "@" | "$"}${infer N}`
  ? N
  : P extends `?${infer N extends number}`
    ? `#${Dec<N>}`
    : `#0`

type Dec<N extends number, C extends unknown[] = []> = [...C, 0]["length"] extends N ? C["length"] : C["length"] extends 99 ? 0 : Dec<N, [...C, 0]>

/** Every table named in the statement, at any depth, for typing comparisons with a placeholder. */
export type Sources<T extends string[], S extends Schema, Acc extends Src[] = []> = T extends [
  infer K extends string,
  infer N extends string,
  ...infer R extends string[],
]
  ? Lowercase<K> extends "from" | "join" | "update" | "into"
    ? TableName<N> extends infer Name extends keyof S & string
      ? AliasOf<R, Name> extends [infer Alias extends string, infer Rest extends string[]]
        ? Sources<Rest, S, [...Acc, { alias: Alias; table: S[Name]; nullable: false }, ...(Lowercase<K> extends "into" ? [{ alias: "excluded"; table: S[Name]; nullable: false }] : [])]>
        : never
      : Sources<[N, ...R], S, Acc>
    : Sources<[N, ...R], S, Acc>
  : Acc

/** A column a placeholder is compared with, or null when it's ambiguous or not a column. */
type Lookup<W, Sc extends Src[]> = W extends string
  ? IsIdent<W> extends true
    ? Lowercase<W> extends Keyword
      ? null
      : Atom<W, { scope: Sc; outer: []; grouped: true; schema: {} }> extends infer K
        ? K extends Ty
          ? K["name"] extends string
            ? { name: K["name"]; type: K["type"]; nullable: K["nullable"] }
            : null
          : null
        : never
    : W extends `${string}.${string}`
      ? Atom<W, { scope: Sc; outer: []; grouped: true; schema: {} }> extends infer K extends Ty
        ? { name: string; type: K["type"]; nullable: K["nullable"] }
        : null
      : null
  : null

type Typed<K, Write extends boolean = false> = K extends Col ? [Input<K, Write>, true] : [Param, false]

type ParamType<W extends string[], R extends string[], In, Sc extends Src[]> = In extends Col
  ? Last<W> extends "(" | ","
    ? Typed<In>
    : Guess<W, R, Sc>
  : Guess<W, R, Sc>

type Guess<W extends string[], R extends string[], Sc extends Src[]> = W extends [...string[], infer P2 extends string, infer P1 extends string]
  ? Lowercase<P1> extends Comparison | "between"
    ? Typed<Lookup<P2, Sc>>
    : Lowercase<P1> extends "limit" | "offset"
      ? [number, true]
      : Lowercase<P1> extends "and"
        ? W extends [infer P4 extends string, infer P3 extends string, string, string]
          ? Lowercase<P3> extends "between"
            ? Typed<Lookup<P4, Sc>>
            : After<R, Sc>
          : After<R, Sc>
        : After<R, Sc>
  : W extends [infer P1 extends string]
    ? Lowercase<P1> extends "limit" | "offset"
      ? [number, true]
      : After<R, Sc>
    : After<R, Sc>

/** `:p = col`, the placeholder on the left. */
type After<R extends string[], Sc extends Src[]> = R extends [infer Op extends string, infer N extends string, ...string[]]
  ? Lowercase<Op> extends Comparison
    ? Typed<Lookup<N, Sc>>
    : [Param, false]
  : [Param, false]

type Push4<W extends string[], H extends string> = W extends [string, infer B extends string, infer C extends string, infer D extends string]
  ? [B, C, D, H]
  : [...W, H]

type Scan<
  T extends string[],
  Sc extends Src[],
  W extends string[] = [],
  In = null,
  Out extends Entry[] = [],
> = T extends [infer H extends string, ...infer R extends string[]]
  ? IsParam<H> extends true
    ? ParamType<W, R, In, Sc> extends [infer Type, infer Ok extends boolean]
      ? Scan<R, Sc, Push4<W, H>, In, [...Out, [ParamKey<H>, Type, Ok]]>
      : never
    : H extends "("
      ? W extends [...string[], infer P2 extends string, infer P1 extends string]
        ? Lowercase<P1> extends "in"
          ? Scan<R, Sc, Push4<W, H>, Lookup<P2, Sc>, Out>
          : Scan<R, Sc, Push4<W, H>, In, Out>
        : Scan<R, Sc, Push4<W, H>, In, Out>
      : H extends ")"
        ? Scan<R, Sc, Push4<W, H>, null, Out>
        : Scan<R, Sc, Push4<W, H>, In, Out>
  : Out

export type ScanParams<T extends string[], S extends Schema> = Scan<T, Sources<T, S>>

// ---------------------------------------------------------------------------------------------
// statements

export type Statement<T extends string[], S extends Schema, All extends string[] = T> = T extends [
  infer K extends string,
  ...infer R extends string[],
]
  ? Lowercase<K> extends "select"
    ? WithParams<SelectCols<T, S, []>, All, S>
    : Lowercase<K> extends "with"
      ? With<R, S> extends [infer S2 extends Schema, infer Main extends string[]]
        ? Statement<Main, S2, All>
        : With<R, S>
      : Lowercase<K> extends "insert" | "replace"
        ? Merge<Insert<R, S>, All, S>
        : Lowercase<K> extends "update"
          ? Merge<Update<R, S>, All, S>
          : Lowercase<K> extends "delete"
            ? Merge<Delete<R, S>, All, S>
            : Untyped
  : Untyped

type WithParams<C, All extends string[], S extends Schema> = C extends Col[] ? { cols: C; params: ScanParams<All, S> } : C

type Merge<X, All extends string[], S extends Schema> = X extends { cols: infer C; params: infer P extends Entry[] }
  ? { cols: C; params: [...P, ...ScanParams<All, S>] }
  : X
