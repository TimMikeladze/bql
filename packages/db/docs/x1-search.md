# X1 — Search: vectors, hybrid, full-text, geo

Items 1, 3 and 4 of `docs/plan-ecosystem.md` (repo root), as built. The plan held in shape — SQL
builders over any `Db`, capabilities compiled into the vendored library, a named error instead of a
fallback — and was wrong or silent in the places below.

## What landed

| Piece | Where |
|---|---|
| sqlite-vec 0.1.9 pinned, fetched, verified, compiled in | `scripts/sqlite.ts` (`VEC_PIN`) |
| Auto-extension registering sqlite-vec + geo on every connection | `scripts/native/ext.c` |
| `features.vec`, `features.geo`; `bql_ext_init` called once on load | `src/sqlite/lib.ts` |
| `vectorIndex`, `toVector`/`fromVector`, `hybridSearch` | `src/search/vector.ts` |
| `ftsIndex`, `ftsQuote` | `src/search/fts.ts` |
| `geoIndex` | `src/search/geo.ts` |
| `FeatureUnavailableError`, `searchFeatures`, identifier checks | `src/search/run.ts` |
| Shadow-table detection | `src/sqlite/shadow.ts`, used by `src/dataapi/introspect.ts`, `src/realtime/capture.ts`, `src/server/auth.ts` and `src/client/diff.ts` |
| `vector({ dimensions })` | `src/drizzle.ts` |
| Export `bql.sh/search` | root `package.json` |

Tests: `test/search/` — `native.test.ts` (the C), `search.test.ts` (every builder through the
embedded engine, the sync handle, and Drizzle), `shadow.test.ts` (capture and introspection),
`e2e.test.ts` (a real server over HTTP, including the change feed and a live FTS query),
`acl.test.ts` (per-table token ACLs over all three index kinds).

## Where the plan was wrong

**One C file, not `geo.c` plus "the same auto-extension".** The plan put the geo functions in
`scripts/native/geo.c` and assumed an auto-extension already existed. None did — `walsum.c` only
exports functions the driver calls through FFI. `ext.c` is both: the geo functions and the entry
point that registers them and sqlite-vec. It is registered by an explicit exported
`bql_ext_init()` that `lib.ts` calls once in `loadFrom`, before anything opens a connection, not by
a load-time constructor — `__attribute__((constructor))` inside a Windows DLL depends on the CRT,
and an explicit call is the same line everywhere. `sqlite3_auto_extension` ignores a repeat, so
loading the library twice is harmless.

**`PRAGMA table_list` is not a shadow-table oracle, in either direction.** The plan said to filter
"by the virtual table's shadow names", implying SQLite already knows them. Its `type = 'shadow'`
comes from each module's `xShadowName`, which is asked about the **suffix alone**. So it misses
vec0's `_vector_chunksNN` (sqlite-vec 0.1.9's `xShadowName` omits it; that one leaked into the Data
API), and it calls a real, user-created `docs_fts_content` beside an external-content `docs_fts`
a shadow, and a real `emb_auxiliary` beside a vec0 `emb` with no `+` column one too. Measured.

The first cut of `src/sqlite/shadow.ts` copied that mistake: a suffix list per module, matched on
the name. Review caught what it cost — such a real table vanished from the Data API, its rows were
dropped from the change feed and the outbox, and a token granted `docs_fts` could read and write
it. It now derives, from each virtual table's `CREATE VIRTUAL TABLE` arguments, the exact set of
tables the module created for **those options**: FTS5's `_content` only for a normal table (or
`contentless_unindexed=1`), `_docsize` unless `columnsize=0`; FTS3/4 likewise; vec0's
`_vector_chunksNN` per vector column, `_metadatachunksNN` per metadata column and
`_metadatatextNN` per text one, `_auxiliary` only with a `+` column. A table in that set cannot
have been a real table first — the `CREATE VIRTUAL TABLE` would have failed — so the answer is
exact. `test/search/shadow.test.ts` creates eight option combinations and checks the derived set
equals what the modules actually created. Where the options cannot be read with certainty the rule
errs towards "not a shadow". It also works on a replica or a system libsqlite3 where the module is
not registered and `table_list` would call every shadow table plain. The Data API and
`diffSchema`, which also read `table_list`, let this verdict override `type = 'shadow'` for the
modules it understands (`shadowVerdict`), and fall back to SQLite's word only for modules it does
not.

**Shadow rows in the change feed were a real leak, not a hypothetical.** A vtab module writes its
shadow tables with ordinary statements on the same connection, so the preupdate hook reports every
one: an insert into a table with an FTS5 index produced a change event for `articles` *and* four
for `articles_fts_*`. The first fix dropped them in `ChangeCapture.takeCommitted` — after the
hook had already counted them against `maxRowsPerTxn` and copied their values. Review measured the
cost: with a cap of 100, 30 FTS-indexed inserts kept 13 real rows and 30 vec0 inserts kept 0; at the
default 10,000 a transaction truncated after about 1,300 real FTS rows. They are now filtered **in
the hook**, before the cap and before a value is read, against a shadow → owner map the capture
builds outside the hooks (at install, and after every commit whose schema cookie moved); the hook
only bumps the virtual table's entry, as "every column changed". The one case that map cannot know
is a transaction that creates a virtual table and writes it; `takeCommitted` still catches that
one, dropping the rows and re-basing the L8 statement marks (a statement that wrote only shadow
rows becomes an empty slice and so no event). The fold is what keeps live queries right: a live query's read-set names the virtual
table (`articles_fts`), never its shadows, because the module prepares its internal statements
lazily at step time, after the read-set was taken. Without the fold a live FTS query would never
refresh. The P9 logical record is built from the same rows, so replicas and the outbox relay see
the filtered stream too.

**vec0 does not accept a quoted column name.** Its constructor parses the column list itself, so
`"kind" text` is a parse error. Metadata column names are held to a plain identifier and emitted
unquoted in the DDL; everywhere else they are quoted as usual.

**Triggers under `trusted_schema = off` were a worry that did not materialise.** FTS5 and R*Tree
are both usable from triggers with `trusted_schema = off` (checked), and `ext.c` registers every
function `SQLITE_INNOCUOUS | SQLITE_DETERMINISTIC`, as sqlite-vec does its own.

**R*Tree coordinates are float32.** The plan's `(id, minLat, maxLat, minLon, maxLon)` alone would
make every distance off by up to a metre or so, since R*Tree rounds each box outward to float32.
The table carries the exact coordinates as auxiliary columns (`+lat, +lon`), `near` computes
`bql_haversine` on those, and the box is only ever a prefilter.

**Antimeridian and poles.** Not in the plan. `bql_bbox_*_lon` return the full `[-180, 180]` range
when the circle reaches a pole or crosses ±180°, which is a correct superset (the haversine filter
does the rest) at the cost of scanning a latitude band. `within` takes a box with
`minLon > maxLon` as one that crosses the antimeridian; R*Tree cannot use the resulting `OR`, so
that query scans the latitude band too. Both are rare and correct; two statements would be faster
and were not worth the surface.

**Hybrid needs matching integer keys.** Unstated in the plan: fusion joins the FTS rowid to the
vec0 id, so both indexes must be keyed by the same integer (a source table's rowid, typically).
`hybridSearch` refuses a text-keyed `VectorIndex`. Each leg contributes its best `candidates`
(default `4k`); a document outside both legs' candidates cannot be returned.

## Decisions the plan left open

- **Error shape.** `FeatureUnavailableError extends BqlClientError`, `code: "FEATURE_UNAVAILABLE"`,
  `status: 0`, `feature: "vec" | "geo" | "fts5" | "rtree"` — one `catch` still works. `create()`
  probes first (`select vec_version()` and friends; one cheap statement), so a missing capability
  fails before any DDL. Every other call maps SQLite's own "no such module: vec0" / "no such
  function: bql_haversine" to the same error after the fact, so the happy path pays nothing.
- **`SearchDb`.** The structural type the helpers take: `execute` answering a promise of rows or
  something with `all()` (the embedded `.sync`), and an optional `batch`. A `Tx` has no `batch`, so
  multi-statement steps run statement by statement inside the caller's transaction.
- **Upsert is delete + insert in one batch**, for vec0, standalone FTS5 and standalone R*Tree
  alike: none of the three supports `ON CONFLICT`.
- **External-content triggers are `_ai`, `_ad`, `_au` on the index name**, and the update trigger
  is `after update of <indexed columns>`, so writing an unindexed column does not re-tokenize.
  `create()` fills from existing rows only when the virtual table did not exist before.
- **`ftsQuote` quotes every word**, so FTS5 syntax in user input is text and `MATCH` cannot throw
  on it. `mode: "any"` joins with `OR`, `"phrase"` quotes the whole thing, `prefix` stars the last
  word. Empty input is `""`, which matches nothing rather than erroring.
- **sqlite-vec compile flags.** `-DSQLITE_CORE` (bind SQLite directly), `-DSQLITE_VEC_STATIC`
  (no `dllexport` on its init), `-DSQLITE_VEC_OMIT_FS` — drops `vec_npy_each`, which reads a file
  path given in SQL, from a server that runs client SQL. NEON/AVX are **not** enabled: the artefact
  is portable, and the speed-up has not been measured here. vec0 KNN is a brute-force scan, so this
  is the first thing to measure if vector search is slow.
- **Pin verification** is size plus sha256. sqlite-vec publishes no sha3; the sha256 is the digest
  GitHub lists for the release asset and was recomputed from the download before it went in.

## Per-table token ACLs (added the same day)

The first cut shipped with a gap: a token scoped with `tables` could not use any index. A vtab
module reads and writes its storage through ordinary statements on the same connection, so the
token's authorizer saw `SQLITE_READ` on `posts_fts_idx` and `SQLITE_INSERT` on the shadows a
trigger touched, and denied them. Measured, not assumed.

Fixed in `src/server/auth.ts`. `applyPolicy` builds a shadow map for the connection
(`shadowLookup`: shadow table → owning virtual table, from `src/sqlite/shadow.ts`) and hands the
authorizer a lookup into it. A shadow table is then judged by its **owner's** ACL entry, for the
same action class: a read needs the owner granted at all, a write needs it `rw`. The rules that
keep this from widening a grant:

- An owner must be a real virtual table in `sqlite_schema`, and the suffix must be its own
  module's (`_data` is FTS5's, `_node` R*Tree's, `_vector_chunksNN` vec0's). A real table
  `todos_data` beside an ordinary table `todos` is nobody's storage and keeps its own ACL entry —
  tested.
- A table that has its own ACL entry is judged by it; the owner rule is only consulted for names
  the token does not list.
- Ownership is the exact per-options set above, never the name: a real `posts_fts_content` beside
  an external-content `posts_fts` is not covered by `posts_fts`'s grant — tested for FTS5 and vec0.
- **A write grant reaches storage only through the module.** Without more, `rw` on `posts_fts`
  would have let the token `insert into posts_fts_data …` and corrupt the index for every reader
  of the database (review finding). A table-ACL request now runs with
  `SQLITE_DBCONFIG_DEFENSIVE` on, under which SQLite refuses any write to a shadow table except
  from inside the module (`table … may not be modified`), so a trigger's insert into `posts_fts`
  still maintains the index while a direct write is refused — both tested. Every other request
  gets the connection's own setting (`[sqlite] defensive`) back, cached so an unchanged request
  costs no FFI call. On a system libsqlite3 there is no shim to reach `DBCONFIG_DEFENSIVE`, and
  there the owner rule grants shadow tables for **reads only**: writing through an index needs a
  database-wide token. One side effect, SQLite's own: under DEFENSIVE a real table whose *name*
  looks like a shadow (the `posts_fts_content` above) is read-only too, because SQLite's
  shadow-table flag is name-based.
- Writing through a trigger still needs the index granted `rw`, exactly as a trigger into any
  other table does: `{ posts: "rw" }` alone cannot write `posts_fts`.

Caching: the authorizer runs inside `sqlite3_prepare` and may not run SQL, so the map is built
before the policy goes on. It is cached per connection against `pragma schema_version`, so a token
with a table ACL pays one pragma per request and a rebuild only after DDL; admin and database-wide
tokens pay one DEFENSIVE read per connection, ever. The lookup reads the map by connection, so the `applyPolicy` fast path (same
policy as last time, no re-scoping) still sees an index created since. A statement SQLite
re-prepares mid-request after someone else's DDL uses the map as of the request's start: that can
only refuse a brand-new index's storage, never grant something new — a shadow table cannot outlive
its virtual table.

`diffSchema` (`src/client/diff.ts`) had the same `table_list`-only filter as the Data API and
listed vec0's `_vector_chunksNN`; it now uses `shadowVerdict`, with `type = 'shadow'` only for
modules `shadow.ts` does not understand.

## Known gaps

- **vec0 writes are not in the change feed at all** — a virtual table fires no row hooks. A vector
  index written directly is invisible to change-feed consumers; one derived from a source table
  (as FTS and geo are, through triggers) is visible through the source's rows.
- **Only macOS arm64 was built and run here.** `ext.c` uses nothing platform-specific (C89 plus
  `math.h`, the `BQL_API` export convention from `walsum.c`), and sqlite-vec builds on Linux and
  Windows upstream, but the Linux and Windows CI legs have not run this change yet.
