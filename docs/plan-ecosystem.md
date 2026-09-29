# Ecosystem track: what people reach for Postgres/Neon to get

Six gaps, each built on something bql.sh already has. Plan of record; each piece's as-built notes
go in its own `docs/` file (repo habit: record where the plan was wrong).

| # | Feature | Built on | Lands in |
|---|---|---|---|
| 1 | Vector + hybrid search | pinned `sqlite-vec` compiled into the vendored lib; FTS5 | `scripts/sqlite.ts`, `bql.sh/search` |
| 2 | Branching as a product | existing O(1) fork | catalog, CLI, `bql.sh/client` admin, GitHub Action |
| 3 | Full-text search helpers | FTS5 (already compiled in) | `bql.sh/search` |
| 4 | Geo helpers | R*Tree (already compiled in) + bql C functions | `scripts/native/`, `bql.sh/search` |
| 5 | Cron schedules | bus delayed publish + dedupe keys + 1 s sweep | `packages/bus` |
| 6 | Outbox / CDC sinks | P9 version-2 log records (durable rows) | db server relay, bus sinks |

## Cross-cutting decisions

- **Helpers are SQL builders, not server routes.** `bql.sh/search` generates DDL and statements and
  runs them through anything with the `Db` shape (`createClient().db()`, embedded, Hrana via the
  client). One code path works in embedded, server, replica reads and cloud mode. No new wire
  protocol.
- **Capabilities stay optional.** The driver can land on a system libsqlite3. New C lives in the
  same artefact as the amalgamation, is reported through `lib.features` (`vec`, `geo`), and a
  helper that needs a missing capability throws a named error (`FEATURE_UNAVAILABLE`) saying to run
  `bun run db sqlite:build`. Never a silent fallback.
- **Pins stay pins.** `sqlite-vec` is fetched as a release amalgamation verified against a sha256 in
  the script, exactly like SQLite; the stamp covers it. Compiled with `-DSQLITE_CORE` and registered
  via `sqlite3_auto_extension` from our helper C, so every connection has it with no
  `load_extension`.
- **Shadow tables are noise.** vec0/FTS5/R*Tree shadow tables must not leak into live queries, the
  change feed or the Data API table list. Filter by the virtual table's shadow names.
- Zero runtime npm dependencies stays true. No Parquet writer: the S3 sink writes gzipped NDJSON
  (DuckDB, ClickHouse and Athena all read it).

## 1. Vector + hybrid search

- `vectorIndex(db, { table, dimensions, metric: "cosine" | "l2", metadata?: {col: type} })` →
  `create()`, `upsert(id, vector, metadata?)`, `delete(id)`, `search(vector, { k, where? })`.
  Backed by a `vec0` virtual table; metadata columns use vec0's metadata/partition columns so
  filters run inside the KNN.
- `toVector(number[] | Float32Array): Uint8Array` / `fromVector(blob)`. Float32 little-endian, the
  vec0 wire format.
- `hybridSearch(db, { fts, vector, query, embedding, k, weights? })`: one statement, two CTEs (FTS5
  `bm25` rank, vec0 KNN rank) fused with reciprocal-rank fusion (`k=60`).
- `bql.sh/drizzle`: `vector({ dimensions })` custom type encoding through `toVector`.

## 2. Branching

- Catalog records `parent` (db name) and `forkedAt` (txid) on a fork; `admin.list()`/`stat()`
  return them. Migration is additive.
- CLI: `bql db branch <name> --from <db>[@txid|time]` (alias of fork that records lineage),
  `bql db branches [<db>]`, `bql db diff <a> <b>` (schema: tables, columns, indexes, triggers,
  views; plus per-table row counts), `bql db reset <branch>` (delete and re-fork from its parent
  at head, same name).
- `diffSchema(dbA, dbB)` exported from `bql.sh/client` so tools can use it without the CLI.
- `.github/actions/bql-branch/action.yml`: composite action over curl against the HTTP API
  (create on PR open/sync, delete on close), outputs the branch name. No npm install needed.
- README recipe for Vercel previews: branch name from `VERCEL_GIT_COMMIT_REF`.

## 3. Full-text search

- `ftsIndex(db, { table, source?, columns, tokenizer? })`: `create()` builds an FTS5 table; with
  `source` it is external-content and installs the three sync triggers, plus `rebuild()`.
- `search(query, { limit, highlight?, snippet? })` returns rows with `rank` (bm25), optional
  `highlight`/`snippet` columns. Query escaping helper `ftsQuote(text)` for untrusted input.

## 4. Geo

- C functions in `scripts/native/geo.c`, registered by the same auto-extension:
  `bql_haversine(lat1, lon1, lat2, lon2)` → metres, `bql_bbox(lat, lon, radiusM)` helpers
  (`bql_bbox_min_lat` … or one function per edge).
- `geoIndex(db, { table, source? })`: R*Tree `(id, minLat, maxLat, minLon, maxLon)`, sync triggers
  for a source table with `lat`/`lon` columns; `within(bbox)`, `near(lat, lon, radiusM, { limit })`
  (R*Tree bbox prefilter, exact haversine filter, ordered by distance).

## 5. Cron on the bus

- Migration adds `schedules(workspace, name, cron, tz, subject, body, headers, next_at, last_at,
  catch_up, paused)`.
- 5-field cron (`*`, lists, ranges, steps, names) plus `@hourly`-style aliases; IANA `tz` via `Intl`,
  DST-correct (skipped times fire once at the next valid minute, repeated times fire once).
- The existing 1 s sweep fires due schedules on the primary only, publishing with
  `dedupeKey = schedule:<name>:<fireAtMs>` so a failover or double sweep cannot double-fire.
  `catchUp: "none" | "latest"` (default `latest`: one fire for a missed window, never a burst).
- HTTP: `PUT/GET/DELETE /v1/schedules/:name`, `GET /v1/schedules`, `POST /:name/pause|resume|run`.
  Client methods and `bql bus schedule add|list|remove|pause|resume|run`. Dashboard lists them if
  cheap.

## 6. Outbox / CDC

- Db server `[outbox]` config: rules `{ db: glob, busUrl, token, subject: "db.{db}.{table}" }`.
  Requires `[replication] logicalChanges` (refuse to start otherwise, with a message).
- The relay tails each matching tenant's **log** from a durable cursor (sidecar file per tenant,
  written after a publish is acked), decodes the logical section, and publishes one message per
  row change with `dedupeKey = <db>:<txid>:<seq>:<i>`. Crash between publish and cursor write
  re-publishes; dedupe makes it exactly-once on the bus. Cursor behind log retention → a loud
  `OUTBOX_GAP` metric/log and a jump, never a silent skip.
- Bus sinks (`packages/bus/src/sinks/`, `bql bus sink <kind>`), each a consumer with batching:
  `webhook` (POST JSON batch, retries via the bus), `s3` (gzipped NDJSON objects keyed by
  time), `clickhouse` (HTTP `INSERT … FORMAT JSONEachRow`).

## Verification

Every piece: unit tests for the builder/parser, one end-to-end test through a real server, docs in
the package README and `docs/api.md`. Gates: `bun run test`, `bun run typecheck`, `bun run bytes`,
`bun run db routes:check`, `bun run db test` with `BUNQL_WAL_NATIVE=0`, and `bun run pack:check`
(the tarball must build the new C).
