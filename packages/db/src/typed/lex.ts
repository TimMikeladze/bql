// Types only. A SQL string as a tuple of tokens, so the parsers in `ddl.ts` and `query.ts` can
// pattern-match on tuples instead of on text.
//
// Every loop is tail-recursive, which TypeScript allows 1000 steps deep. The outer loop takes one
// step per token, plus one per extra space or newline, and reads a word in a nested call, one step
// per character. So the limit is about 1000 tokens per string, here and in every parser loop that
// walks the tokens, rather than a length in characters.
//
// Not lexed: `--` and `/* */` comments, and a `''` escape inside a string literal. The first ends a
// literal early; the parsers then see junk, and junk degrades to untyped rather than to an error.

/** Characters that are always a token of their own. `.` is not one: `u.name` stays one word. */
type Punct = "(" | ")" | "," | ";" | "=" | "<" | ">" | "!" | "+" | "-" | "*" | "/" | "|" | "%" | "&" | "~"

/** An operator longer than one character at the start of `S`, as `[op, rest]`. `->>` before `->`. */
type ReadOp<S extends string> = S extends `->>${infer R}`
  ? ["->>", R]
  : Op2<S>

type Op2<S extends string> = S extends `${infer A}${infer B}${infer R}`
  ? `${A}${B}` extends "->" | "||" | "<=" | ">=" | "!=" | "<>" | "==" | "<<" | ">>"
    ? [`${A}${B}`, R]
    : null
  : null

type Space = " " | "\n" | "\t" | "\r"

/** One space after a token is dropped in the same step, which roughly halves the steps a statement takes. */
type Spaced<S extends string> = S extends ` ${infer R}` ? R : S

/** Reads one word: everything up to a space, punctuation or a quote. Returns `[word, rest]`. */
type ReadWord<S extends string, W extends string = ""> = S extends `${infer C}${infer R}`
  ? C extends Space | Punct | "'" | '"' | "`" | "["
    ? [W, S]
    : ReadWord<R, `${W}${C}`>
  : [W, ""]

export type Lex<S extends string, Acc extends string[] = []> = S extends `${infer C}${infer R}`
  ? C extends Space
    ? Lex<R, Acc>
    : C extends Punct
      ? ReadOp<S> extends [infer Op extends string, infer Rest extends string]
        ? Lex<Spaced<Rest>, [...Acc, Op]>
        : Lex<Spaced<R>, [...Acc, C]>
      : S extends `'${infer L}'${infer Rest}`
        ? Lex<Rest, [...Acc, `'${L}'`]>
        : S extends `"${infer L}"${infer Rest}`
          ? Lex<Rest, [...Acc, `"${L}"`]>
          : S extends `\`${infer L}\`${infer Rest}`
            ? Lex<Rest, [...Acc, `"${L}"`]>
            : S extends `[${infer L}]${infer Rest}`
              ? Lex<Rest, [...Acc, `"${L}"`]>
              : ReadWord<S> extends [infer W extends string, infer Rest extends string]
                ? W extends ""
                  ? Acc
                  : Lex<Spaced<Rest>, [...Acc, W]>
                : Acc
  : Acc

/** An identifier as written, without its quotes. Quoted identifiers keep their case. */
export type Unquote<T extends string> = T extends `"${infer I}"` ? I : T

type Pop<D extends unknown[]> = D extends [unknown, ...infer R] ? R : []

/** Splits tokens at every `Sep` outside parentheses. */
export type SplitTop<
  T extends string[],
  Sep extends string = ",",
  D extends unknown[] = [],
  Cur extends string[] = [],
  Out extends string[][] = [],
> = T extends [infer H extends string, ...infer R extends string[]]
  ? H extends "("
    ? SplitTop<R, Sep, [...D, 0], [...Cur, H], Out>
    : H extends ")"
      ? SplitTop<R, Sep, Pop<D>, [...Cur, H], Out>
      : H extends Sep
        ? D extends []
          ? SplitTop<R, Sep, D, [], [...Out, Cur]>
          : SplitTop<R, Sep, D, [...Cur, H], Out>
        : SplitTop<R, Sep, D, [...Cur, H], Out>
  : Cur extends []
    ? Out
    : [...Out, Cur]

/**
 * Tokens up to the first keyword in `Stops` outside parentheses, as `[before, from-the-keyword]`.
 * Keywords match case-insensitively; `Stops` is lower case.
 */
export type Until<
  T extends string[],
  Stops extends string,
  D extends unknown[] = [],
  Acc extends string[] = [],
> = T extends [infer H extends string, ...infer R extends string[]]
  ? D extends []
    ? Lowercase<H> extends Stops
      ? [Acc, T]
      : H extends "("
        ? Until<R, Stops, [0], [...Acc, H]>
        : Until<R, Stops, D, [...Acc, H]>
    : H extends "("
      ? Until<R, Stops, [...D, 0], [...Acc, H]>
      : H extends ")"
        ? Until<R, Stops, Pop<D>, [...Acc, H]>
        : Until<R, Stops, D, [...Acc, H]>
  : [Acc, []]

/** For tokens that start with `(`: what is inside the matching `)`, and what follows it. */
export type Group<T extends string[], D extends unknown[] = [], Acc extends string[] = []> = T extends [
  infer H extends string,
  ...infer R extends string[],
]
  ? H extends "("
    ? D extends []
      ? Group<R, [0], Acc>
      : Group<R, [...D, 0], [...Acc, H]>
    : H extends ")"
      ? D extends [unknown]
        ? [Acc, R]
        : Group<R, Pop<D>, [...Acc, H]>
      : Group<R, D, [...Acc, H]>
  : [Acc, []]

/** The tokens outside any parentheses. */
export type Top<T extends string[], D extends unknown[] = [], Acc extends string[] = []> = T extends [
  infer H extends string,
  ...infer R extends string[],
]
  ? H extends "("
    ? Top<R, [...D, 0], Acc>
    : H extends ")"
      ? Top<R, Pop<D>, Acc>
      : D extends []
        ? Top<R, D, [...Acc, H]>
        : Top<R, D, Acc>
  : Acc

/** Whether a token in `T` is the keyword `W` (lower case). */
export type Has<T extends string[], W extends string> = W extends Lowercase<T[number]> ? true : false

/** Whether `A` is immediately followed by `B` somewhere in `T`. Both lower case. */
export type HasPair<T extends string[], A extends string, B extends string> = T extends [
  infer X extends string,
  ...infer R extends string[],
]
  ? Lowercase<X> extends A
    ? R extends [infer Y extends string, ...string[]]
      ? Lowercase<Y> extends B
        ? true
        : HasPair<R, A, B>
      : false
    : HasPair<R, A, B>
  : false

/** The tokens after a leading keyword `W`, or all of them when it isn't there. */
export type Skip<T extends string[], W extends string> = T extends [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends W
    ? R
    : T
  : T

/** The last element of a tuple. */
export type Last<T extends string[]> = T extends [...string[], infer L extends string] ? L : never
