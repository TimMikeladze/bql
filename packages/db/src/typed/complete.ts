// Types only. Completions inside a SQL string, offered through the parameter type.
//
// An editor completes a string argument from the literal types in its parameter's type. So when a
// query is wrong or unfinished, `index.ts` widens `sql` from the query itself to a union of whole
// corrected queries, and the editor lists them. Measured with the TypeScript 5.9 language service:
// `db.query("select * from u")` completes to `"select * from users"`.
//
// Every candidate is the whole string, because that's what an editor replaces. The type sees only
// the text and not the cursor, so it completes the word an error names (wherever it is) or, for a
// query that checks, the end of the string.

import type { Schema, TableDef } from "./ddl.ts"
import type { Last, Lex } from "./lex.ts"
import type { Analyzed, Sources, Src } from "./query.ts"

type Lead = "" | `${string}${" " | "," | "(" | "\n" | "\t" | "=" | "<" | ">"}`
type Trail = "" | `${" " | "," | ")" | "\n" | "\t" | ";" | "=" | "<" | ">"}${string}`

type TableKeyword = "from" | "join" | "into" | "update" | "table"
type ColumnKeyword = "select" | "where" | "and" | "or" | "by" | "on" | "set" | "having" | "returning" | "distinct"
type ColumnPunct = "," | "(" | "=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">="

type ColNames<T> = T extends TableDef ? T["cols"][keyof T["cols"]]["name"] : never
type Tables<S extends Schema> = keyof S & string
type AllCols<S extends Schema> = ColNames<S[keyof S]>

type ScopeCols<Scope extends Src[], S extends Schema> = Scope extends [] ? AllCols<S> : ColNames<Scope[number]["table"]>

type Qualified<Scope extends Src[]> = Scope[number] extends infer H
  ? H extends Src
    ? `${H["alias"]}.${ColNames<H["table"]>}`
    : never
  : never

type Having<Scope extends Src[], N extends string> = Scope[number] extends infer H
  ? H extends Src
    ? Lowercase<N> extends keyof H["table"]["cols"]
      ? `${H["alias"]}.${N}`
      : never
    : never
  : never

/** The candidates that start with `P`, ignoring case; failing that, its first letter; failing that, all of them. */
type Prefixed<C extends string, P extends string> =
  StartsWith<C, P> extends infer M extends string
    ? [M] extends [never]
      ? P extends `${infer F}${string}`
        ? StartsWith<C, F> extends infer M1 extends string
          ? [M1] extends [never]
            ? C
            : M1
          : never
        : C
      : M
    : never

type StartsWith<C extends string, P extends string> = C extends unknown
  ? Lowercase<C> extends `${Lowercase<P>}${string}`
    ? C
    : never
  : never

/** `Q` with the first whole-word `Tok` swapped for each candidate. */
type Replace<Q extends string, Tok extends string, C extends string> = Q extends `${infer B}${Tok}${infer A}`
  ? B extends Lead
    ? A extends Trail
      ? `${B}${C}${A}`
      : never
    : never
  : never

type FromMiss<Q extends string, A, S extends Schema> = A extends { miss: infer M }
  ? M extends { kind: "table"; token: infer T extends string }
    ? Replace<Q, T, Prefixed<Tables<S>, T>>
    : M extends { kind: "column"; token: infer T extends string; scope: infer Sc extends Src[] }
      ? T extends `${string}.${string}`
        ? Replace<Q, T, Prefixed<Qualified<Sc>, T>>
        : Replace<Q, T, Prefixed<ScopeCols<Sc, S>, T>>
      : M extends { kind: "ambiguous"; token: infer T extends string; scope: infer Sc extends Src[] }
        ? Replace<Q, T, Having<Sc, T>>
        : never
  : never

/** The next word, for a query that checks: a table after `from`, a column after `select`, `where`, a comma… */
type AtEnd<Q extends string, S extends Schema> =
  Lex<Q> extends infer T extends string[]
    ? Q extends `${string}${" " | "\n" | "\t"}`
      ? Last<T> extends infer P extends string
        ? Lowercase<P> extends TableKeyword
          ? `${Q}${Tables<S>}`
          : Lowercase<P> extends ColumnKeyword
            ? `${Q}${ScopeCols<Sources<T, S>, S>}`
            : P extends ColumnPunct
              ? `${Q}${ScopeCols<Sources<T, S>, S>}`
              : never
        : never
      : T extends [...infer Init extends string[], infer W extends string]
        ? Q extends `${infer Head}${W}`
          ? Init extends [...string[], infer P extends string]
            ? Lowercase<P> extends "as"
              ? never
              : Lowercase<P> extends TableKeyword
                ? Exclude<`${Head}${Prefixed<Tables<S>, W>}`, Q>
                : W extends `${string}${":" | "@" | "$" | "?" | "'" | '"' | "(" | ")" | "*"}${string}`
                  ? never
                  : W extends `${string}.${string}`
                    ? Exclude<`${Head}${Exclude<Prefixed<Qualified<Sources<T, S>>, W>, W>}`, Q>
                    : Exclude<`${Head}${Exclude<Prefixed<ScopeCols<Sources<T, S>, S>, W>, W>}`, Q>
            : never
          : never
        : never
    : never

/** Whole-query completions for `Q`, or `never`. */
export type Complete<Q extends string, A extends Analyzed, S extends Schema> = A extends { miss: unknown }
  ? FromMiss<Q, A, S>
  : AtEnd<Q, S>
