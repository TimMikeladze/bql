# Typed SQL without codegen

Row and parameter types for a SQL string, inferred by `tsc` from the string itself. No generator,
no build step, no watch process. The schema is the same DDL the database runs, written as string
literals, and a type-level parser reads both.

```ts
import { schema } from "bql.sh/typed"   // packages/db/src/typed

const app = schema(
  "create table users(id integer primary key, name text not null, email text)",
  "create table posts(id integer primary key, user_id integer not null references users(id), title text not null)",
)

const db = await app.push(bql.db("app"))   // makes the database satisfy the schema, returns the typed db
const rows = await db.query(
  "select p.id, p.title, u.name from posts p left join users u on u.id = p.user_id where p.id = :id",
  { id: 1 },
)
// rows: Result<{ id: number; title: string; name: string | null }>

db.query("select nme from users")
// error: Argument of type '"select nme from users"' is not assignable to parameter of type
//        '"bql: no such column: nme" | "select name from users"'
```

The second member of that union is a completion: an editor lists the literal types of a string
parameter, so the same parse that finds the error offers the fix.

## Keeping the database in step

The schema is declarative: the `create` statements as they should be now, edited in place. Types
come from those strings, and the first `query`, `live` or `transaction` on `app.typed(db)` makes the
database satisfy them, once per db object. There is no version list, no `alter` string to write and
no call to remember. `app.push(db, options)` is the same sync run on purpose, for `allowDataLoss`
from a deploy step. (Strings are applied in order to build the desired schema, so
an `alter` in the list still works; it just isn't needed.)

The rule that makes it safe with many processes, tenants and versions of the code: **push only moves
the database toward what the types need.**

| Database vs. schema | Default | With `allowDataLoss` |
| --- | --- | --- |
| table, column, index, trigger or view missing | created | created |
| column nullable, schema says not null | table rebuilt with not null (fails if a NULL is there) | same |
| index, trigger or view defined differently | replaced | replaced |
| column the schema doesn't have | left | dropped (rebuild) |
| column not null, schema says nullable | left | loosened (rebuild) |
| column's type maps to a different TS type | **throws** | converted (rebuild) |
| primary key differs | **throws** | rebuilt |
| default, collation, table constraint differs | left | rebuilt |
| table the schema doesn't have | left | left |

Old code never loosens or removes anything, so during a rolling deploy or a rollback old and new
instances don't undo each other's changes, except a changed index, trigger or view definition,
which follows whoever pushed last. A rename is a drop plus an add to a diff, so `push(db, { rename:
{ "users.name": "users.full_name" } })` says which it is; it applies only while the old name exists
and the new one doesn't, so it can stay in the code.

How:

- The desired schema is the DDL run in a scratch `:memory:` database on the bundled driver, read
  with `readSchema` from `client/diff.ts` (what `bql db diff` uses). The live one is read the same
  way through `execute`. SQLite does the parsing, so there's no runtime copy of the type parser.
- A rebuild is SQLite's documented procedure: create `__bql_new_<t>` from the desired statement,
  copy the shared columns, drop the old table, rename, recreate the table's indexes and triggers,
  and drop and recreate views around it. `defer_foreign_keys` is on and `foreign_key_check` runs
  before commit. With `foreign_keys` on, dropping a parent table fires `ON DELETE` actions, so a
  rebuild of a table other tables reference is refused there.
- A column is added with `alter table add column` when SQLite allows it (not a primary key, not
  unique, not `not null` without a default, not a stored generated column), else by rebuild.
- Everything runs in one `immediate` transaction with busy retries, so concurrent pushes serialise
  and the losers find nothing to do.
- Implicit: `typed(db)` wraps `query` so the first call waits on the sync (a `Pending` with the
  `Query` surface; the inner `Query` is boxed, because resolving a promise with a thenable runs it).
  `live` waits the same way and `transaction` awaits it first. One sync promise per db object per
  schema, in a `WeakMap`; a failure is dropped so the next query retries, which is how a deploy
  step's `push({ allowDataLoss })` reaches running code. It defaults on in Bun when the db has
  `transaction`, off elsewhere (`{ sync: false }` to force off). A read-only token on an in-step
  database works, since the check is a read; out of step it fails with a message, not
  `NOT_AUTHORIZED` from a `begin immediate`.
- Fast path: `user_version` holds a 32-bit hash of the DDL text and `schema_version` as of the
  last push. Hashing the text rather than the parsed schema means the check needs no scratch
  database; reformatting a string costs one full comparison that finds nothing. `schema_version` changes on every DDL statement from any source, and writing
  `user_version` doesn't change it (checked), so one read of both pragmas answers "in step, and
  nobody changed it since". Push owns `user_version`.
- `app.plan(db)` is the same diff without applying: `{ statements, blocked }`.
- Push needs `bun:ffi` for the scratch database. It's loaded with a dynamic import, so
  `bql.sh/typed` still bundles for a browser, where `typed(db)` works and `push` throws.

## Why not the `sql` tag

Checked on TypeScript 7.0.2: in a tagged call the strings array is typed `TemplateStringsArray`,
even with a `const` type parameter. The text never reaches the type system, so the tag can't be
typed. `query(sql, args)` takes a plain string literal, and that does. gql.tada moved to
`graphql("...")` for the same reason. `db.sql` stays as it is, untyped.

Parameters are named (`:id`, `@id`, `$id`) or positional (`?`, `?1`) placeholders, which SQLite
binds. They are never interpolated, so the call form loses none of the tag's safety.

## Pieces

- `src/typed/lex.ts` (types only). Tokenizer. Words, punctuation, two-character operators,
  `'string'` and `"identifier"` literals. Tail-recursive, one step per token (a single space after a
  token is free), so a string stays under TypeScript's 1000-step limit for tail calls up to about
  1000 tokens. Every other loop over the tokens has the same bound.
- `src/typed/ddl.ts`. `create table` (column types, `not null`, `integer primary key`, `strict`),
  `create virtual table … using fts5(…)`, `create view … as select`, `alter table add/drop/rename
  column`, `drop table`. Everything else (`create index`, triggers) is ignored.
- `src/typed/query.ts`. `select` with joins, `*`, `t.*`, aliases, `with` CTEs, scalar subqueries,
  `case`, `cast`, the common functions, `group by`; `insert`/`update`/`delete` with `returning`.
  Parameter types come from the column a placeholder is compared to, assigned to, or inserted into.
- `src/typed/complete.ts`. Whole-query completions joined onto the `sql` parameter: for an error,
  the misspelled token swapped for names with the same prefix (then the same first letter, then
  all); for a query that checks, the next word at the end of the string. Wrapped in `NoInfer`,
  because without it TypeScript infers `Q` from the candidates' template literals (it inferred
  `"s"`).
- `src/typed/index.ts`. `schema()` returns the DDL plus `typed(db)`, `push(db)` and `plan(db)` (`src/typed/push.ts`). The typed db
  has `query`, `live`, `transaction` (its callback gets a typed `tx`) and `raw`. At runtime `query`
  is `execute` and `live` is `live`; the wrapper only carries the types. Works on a client `Db`, an
  embedded one, or a `Tx`. `Table<typeof app, "users">` and `Row<typeof app, "select …">` name the
  types.
- `db.live` in the client and embedded db now also takes `(sql, args)`, which `typed().live` needs:
  the tag can't carry named arguments.

## Type rules

- Column types follow SQLite's affinity rules on the declared type, the same rules
  `dataapi/introspect.ts` applies: INT → `number`, CHAR/CLOB/TEXT → `string`, BLOB → `Uint8Array`,
  REAL/FLOA/DOUB → `number`, a blank type → any value. NUMERIC is `number`, except a declared
  `date`, `datetime` or `timestamp`, which is `string`. SQLite stores `current_timestamp` there as
  text, because it can't convert it to a number.
- A column is non-null with `not null`, or when it is `integer primary key` (the rowid). Any other
  `primary key` still accepts NULL outside STRICT tables. That's a SQLite quirk, checked on 1.4.3's
  SQLite.
- Columns from the right side of a `left join` are nullable. `right` and `full` joins make the left
  side nullable.
- An unaliased column keeps its declared name (`select NAME` returns `Name` when the DDL says
  `Name`), which is what SQLite reports. An unaliased expression gets no key: alias it.
- Aggregates other than `count`/`total` are nullable without `group by`, because they return NULL
  on an empty table.
- `cast(expr as type)` is the escape hatch for anything the parser types as unknown.

## Fail open

A type error means the parser is sure the query is wrong: an unknown table, an unknown or
ambiguous column in the select list or `returning`. Syntax it doesn't understand degrades to
`JsRow` rows and untyped arguments, never to an error. A false error would block valid SQL, so a
false negative is the cheaper mistake.

## Limits

- The types describe the schema strings, not the database. If the database was changed some other
  way, the types are wrong, same as with any ORM's model.
- Outside STRICT tables declared types are advisory; an `integer` column can hold text.
- Integer columns are `number`. A client opened with `intMode: "bigint"` gets bigints at runtime.
- Dynamic SQL (optional filters, user-chosen sort) has no literal to read. Use `bql.sh/kysely`.
- `--` comments and `''` escapes inside string literals are not lexed.
- About 1000 tokens per string. Past that `tsc` reports TS2589 ("excessively deep") at the call, a
  hard error rather than a fallback. Measured: a 300-column `create table` (~900 tokens) and an
  800-token select check; a 400-column `create table` doesn't.

## Verification

- `test/typed/schema.ts` is the shared schema. `test/typed/types.test.ts` holds the type
  assertions, and `bun run typecheck` is the test. `test/typed/runtime.test.ts` runs the same
  shapes against an embedded database: the keys a row really has, which values come back NULL
  (empty-table aggregates, the outer side of a left join, a `text primary key`), and that named
  and positional placeholders bind.
- Cost, measured with `tsc --extendedDiagnostics` on TypeScript 7.0.2 over `packages/db`: 0.30 s
  check time without the typed tests, 0.46 s with them (~70 queries), and 1.20 s after adding 201
  more queries including a 60-column join. That's about 3.7 ms and 10k instantiations per query;
  completions added about 10%.
- Completions checked two ways: the TypeScript 5.9 language service (`getCompletionsAtPosition`)
  and the TypeScript 7 language server (`tsc --lsp -stdio`, `textDocument/completion`). Both list
  the same candidates in 0 to 3 ms after the first request. `types.test.ts` pins the candidates as
  types. TypeScript 5.9 also type-checks the whole package with no errors.

## Where the plan was wrong

- Mapping over `H["table"]["order"]` gave an object, not a tuple: a mapped type only produces a
  tuple when it maps a type parameter. `*` expanded to `never` until `StarCols` took the order as
  one.
- The first draft dropped unaliased expressions from a select's columns. That emptied every scalar
  subquery (`(select count(*) …)`), whose only column has no alias. Unaliased columns now stay in
  position with the name `never`, which gives them no key in a row.
- Positional placeholders inside `values (?, ?)` all came out as position 0, because the insert
  parser sees each tuple alone. Every bare `?` is now numbered `?N` right after lexing.
