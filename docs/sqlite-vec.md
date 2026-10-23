# Vector search for graphx on bql.sh

Written 2026-10-22 against bql.sh `main` and graphx `main`. The graphx side is now built, with a simpler design than the one below; see "What was built". The rest of the doc is the plan as written.

## What was built

graphx (branch `metro-graph`) went with a plain table and a scalar scan instead of a `vec0` index, with no backward compatibility:

- `node_embeddings.emb` on the `sqlite` dialect is a float32 `BLOB` written with `vec_f32(?)` and checked with `CHECK (vec_length(emb) = dim)`. The check works under `trusted_schema = off`.
- Search is `SELECT ... COALESCE(vec_distance_cosine(emb, vec_f32(?)), 1.0) AS dist FROM node_embeddings ORDER BY dist, id, chunk LIMIT ?` (`annSeeds('sqlite')`). A stored zero vector ranks at distance 1. The query is normalised in JS first, so a component past float32's range can't turn every distance into NULL.
- The JS scan (`sqliteVectorSeedRows`) is gone. `init` with an embedder probes `vec_version()` and refuses with the fix when it's missing. A graph without an embedder runs on any SQLite.
- Reads decode the raw blob in JS (`embJson`), because `vec_to_json` prints six decimals.
- `openExpoDb` loads `bundledExtensions['sqlite-vec']` when the app is built with `withSQLiteVecExtension`. WASM callers pass a sqlite3 build with sqlite-vec in; `@sqlite.org/sqlite-wasm` has none.
- There's no second table and no `rid`, so none of the sync, migration or doctor work below is needed. Open questions 2 to 4 don't arise.

Why the scan instead of `vec0`: same top 10 on every size tried, 1.4 to 2× slower, and none of the sync code. In process on arm64:

| Vectors × dims | scalar scan | `vec0` |
| --- | --- | --- |
| 6,400 × 256 | 1.8 ms | 0.9 ms |
| 50,000 × 256 | 14.3 ms | 7.0 ms |
| 50,000 × 768 | 32.3 ms | 22.7 ms |
| 200,000 × 768 | 127.7 ms | 90.6 ms |

Over Hrana against a stock-limits server, the old JS scan against the new one:

| Vectors × dims | JS scan | sqlite-vec scan |
| --- | --- | --- |
| 6,400 × 256 | 59 ms | 3.5 ms |
| 10,000 × 256 | 93 ms | 4.6 ms |
| 7,000 × 768 | `RESULT_TOO_LARGE` | 8.1 ms |
| 50,000 × 256 | `TOO_MANY_ROWS` | 24.6 ms |

graphx's bench harness has a bql driver now (`GRAPHX_BENCH_DRIVER=bql`). It shows the remaining cost of `retrieve` on bql.sh is not the vector leg (2 ms) but the walk CTE, which takes 100 to 350 ms on the `sqlite` dialect even at `maxDepth: 0`.

Still open on the bql.sh side: a Linux arm64 CI leg and the NEON measurement.

The brief this answers asked for sqlite-vec to be added to bql.sh's pinned build. It already is. So most of the work is on the graphx side: its `sqlite` dialect never uses the `vec0` module that every bql.sh connection already has.

## What already exists in bql.sh

- sqlite-vec 0.1.9 is pinned by size and sha256 and compiled into the same `libsqlite3` as the amalgamation (`packages/db/scripts/sqlite.ts:50`, flags at `:104-111`). The flags are `SQLITE_CORE`, `SQLITE_VEC_STATIC` and `SQLITE_VEC_OMIT_FS`, so the file reader `vec_npy_each` is not in the build.
- `scripts/native/ext.c` registers it with `sqlite3_auto_extension`. `src/sqlite/lib.ts:470` calls `bql_ext_init()` once on load, so every connection has `vec0`: the tenant writer, readers, replica apply connections and a bare `Database.open()`.
- `load_extension()` is refused for client SQL by the authorizer (`src/server/auth.ts:899`). There is no loadable-extension path and this plan doesn't add one.
- `features.vec` (`src/sqlite/lib.ts:408`). `sqlite:build` refuses to finish unless a fresh connection can run `select vec_version()` (`scripts/sqlite.ts:319`).
- `bql.sh/search` has `vectorIndex`, `toVector` and `hybridSearch` (`src/search/vector.ts`), plus a probe-first `FeatureUnavailableError` (`src/search/run.ts:64`, `:120`).
- Shadow-table handling for `vec0` covers the Data API, the change feed, `diffSchema` and per-table token ACLs (`packages/db/docs/x1-search.md`).
- graphx's installed `bql.sh@0.4.0` has the same `VEC_PIN`, so `bun run bql:build` in graphx already produces a library with `vec0`.

Compiled-in, with `load_extension` denied, is the right model for a multi-tenant server, and it stays. A loadable extension would mean either letting tenant SQL name a file to `dlopen`, or a per-connection load step that some connection forgets. `ext.c`'s header comment gives both reasons.

## What `vec0` is, measured here

`vec0` in 0.1.9 is an exact brute-force scan in C over float32 chunks. It's not a graph index. KNN syntax is `WHERE emb MATCH ? AND k = ?` (a bound `k` works), and the query vector can be JSON text, so graphx's existing `JSON.stringify(qEmb)` binding needs no blob encoding over Hrana.

Measured on the vendored macOS arm64 build (no NEON, see below), random vectors, `k = 40`, mean of 10 queries, in-memory:

| Vectors | Dims | ms per query |
| --- | --- | --- |
| 6,400 | 256 | 0.9 |
| 50,000 | 256 | 7.1 |
| 50,000 | 768 | 23.9 |
| 200,000 | 768 | 91.6 |

It's linear in vectors × dims, as you'd expect. Upstream's own number for flat search over 1M × 1024 on an M4 is 590 ms (sqlite-vec PR #277). So exact `vec0` stays fine up to a few hundred thousand vectors per namespace and gets slow at a million. A single query of that size also holds a reader for its full duration, and under bql.sh's one-writer design that delays other databases on the same worker (`docs/timeseries-assessment.md`).

Facts from the same probes (scratch script, not committed):

- `k` above 4096 is refused: `k value in knn query too large … the limit is 4096`. `src/search/vector.ts:14` already clamps to this.
- A zero query vector returns rows with `distance = null`, not an error. graphx's `isZeroVector` guard has to stay ahead of the query.
- A dimension mismatch on insert is an error naming the column. That matches what the JSON `CHECK` on `node_embeddings` does today.
- **`vec0` cannot be used from a trigger under `trusted_schema = off`**: `unsafe use of virtual table "ne_vec"`. FTS5 and R*Tree can (x1 checked those), but `vec0` is not marked innocuous. bql.sh defaults `[sqlite] trustedSchema` to on (`src/server/config.ts:603`), but an operator who follows SQLite's hardening advice and turns it off would break any write that fires such a trigger.

Other upstream facts (sqlite-vec README and releases, read 2026-10-22): MIT or Apache-2.0. float32, int8 and bit vectors. cosine, L2 and L1 metrics. Metadata, partition-key and auxiliary (`+col`) columns. 0.1.9 is the latest stable release. 0.1.10-alpha.1 through alpha.4 (Mar to May 2026) add `rescore`, DiskANN and an IVF index that is off by default (`SQLITE_VEC_EXPERIMENTAL_IVF_ENABLE`, `indexed by ivf(nlist=…)`). Upstream warns its shadow-table layout may change incompatibly, says DiskANN deletes leak and are expensive, and a fork reports distance constraints being silently ignored on all three new index types.

## Why the JS scan has to go

`sqliteVectorSeedRows` (`packages/graphx/src/core/retrieve.ts:140-185`) selects every row of `node_embeddings` in one statement, parses each JSON vector and ranks in JS. On bql.sh remote that statement goes through `exec.ts` like any Hrana statement, so it's subject to both result caps:

- `[limits] maxRows` is 10,000 (`src/server/config.ts:630`). Past it the query fails `TOO_MANY_ROWS`, so a namespace with 10,001 chunks can't do vector search at all.
- `maxResultBytes` is 64 MiB (`:631`). Metro-graph's hash vectors are 1,024 bytes of JSON each (6.3 MiB for 6,407 rows, measured). A real 768-dim float embedding is about 8 to 9 KiB of JSON (my estimate from typical float formatting), so the byte cap bites at roughly 7k vectors, before `maxRows` does.

Those are correctness failures. Measuring will decide which index to use and how far each one goes. It won't decide whether to replace the scan.

## Measurement first

`docs/bql.md` in graphx says to drive this by a measurement. The measurement answers three questions:

- At what corpus size does the JS scan stop working on bql.sh remote, and how fast is it before that?
- How does exact `vec0` latency compare with libSQL's DiskANN at the sizes graphx cares about, and what recall does DiskANN give up?
- Does `SQLITE_VEC_ENABLE_NEON` matter on arm64?

How to run it:

- graphx's bench harness only knows `libsql` and `postgres` (`scripts/bench/corpus.ts:77`). Add `GRAPHX_BENCH_DRIVER=bql`, in embedded mode and in remote mode against `bun run bql:serve`.
- The `ann` suite (`scripts/bench/suites/ann.ts`) sweeps 1k/5k/10k vectors at 128 dims. Add a separate vector-only script, so it doesn't drag the 10k-node graph build along, that loads N random unit vectors through graphx's write path. Sizes: 6.4k, 50k, 500k × 256 and 768. Time `vectorSeedRows` at k = 10 and 50 (p50/p95), record bytes over the socket for remote, and record the first failure (`TOO_MANY_ROWS` / `RESULT_TOO_LARGE`).
- Recall@10 and @50 is measured against exact ground truth computed in JS from the same vectors. Exact `vec0` should be 1.0 except for float32 ties. Checking that also checks the grouping of chunks to nodes. Random vectors are fine for recall-versus-exact. The harness note that "recall numbers from it are not" meaningful (`corpus.ts:22`) is about semantic quality with a capped sample, which this doesn't measure.
- Metro-graph (`/Users/tim/workspace/graphx/examples/metro-graph/metro.db`, 6,407 vectors, `hash:256`) is the one real graph. Run it on all three paths (libSQL, bql.sh JS scan, bql.sh `vec0`) and compare top-10 seeds per query.
- libSQL DiskANN at 500k: `corpus.ts:14` puts index construction at ~108 s for a fraction of that. I suspect a 500k build will be impractical in the harness, so cap libSQL at whatever builds in a few minutes and say where it stopped.

Results go in graphx's `docs/bql.md`, replacing the "No ANN" bullet under "Not done".

## bql.sh changes

There's little to do here. None of it changes the security model.

- **NEON.** `scripts/sqlite.ts:376` leaves NEON and AVX off because "the speed-up has not been measured here". NEON is part of base AArch64, so an arm64 artefact with `SQLITE_VEC_ENABLE_NEON` runs on every arm64 machine. AVX isn't safe that way, because an x64 artefact is copied between machines and sqlite-vec has no runtime dispatch. Measure NEON on arm64 and add the flag for arm64 builds only if it helps. The stamp already hashes the flag list, so changing it forces a rebuild.
- **Per-database enablement.** Not needed. The module is on every connection. A database that never creates a `vec0` table pays nothing, and `vec0` storage counts toward a database's size like any other table. An admin toggle would add a setting that does nothing useful.
- **Capability flag.** `select vec_version()` over Hrana already answers it, and the authorizer allows the call. It's also the probe `bql.sh/search` uses. graphx should probe the connection it has, not ask the server. A node or replica that fell back to a system `libsqlite3` has no `vec0`, and only the probe on that connection reveals it. I wouldn't add a server-level flag.
- **Branching, backups, WAL.** `vec0` is ordinary shadow tables in the database file. A reflink fork (`POST /v1/db {from}`), snapshots, backup shipping and physical WAL replication carry it like any other page. The one gap: `vec0` writes don't appear in the logical change feed (x1 "Known gaps"). graphx doesn't read `vec0` from the feed, and replicas apply pages, so this doesn't affect graphx.
- **Authorizer.** graphx's remote driver needs an admin or database-wide token already (provisioning, `docs/bql.md`). With a per-table ACL, DDL is denied, and `vec0` storage is covered by the owner's grant under `DBCONFIG_DEFENSIVE` (x1). Nothing new.
- **Limits.** A KNN returns at most `k × 4` rows, far under `maxRows`. At ~90 ms for 200k × 768, the 10 s `queryTimeoutMs` (`config.ts:627`) leaves a lot of room.
- **CI.** CI is Linux x64 only (`.github/workflows/ci.yml:10`). `sqlite:build`'s `check()` already fails the job without `vec`, so Linux x64 is covered. macOS arm64 is verified locally only. Linux arm64 (Fly arm machines, Graviton) isn't built anywhere. Add a `ubuntu-24.04-arm` leg that runs `sqlite:build` and `test/search/`. That leg is also where the NEON flag would be tested.
- **Docs.** Add the `trusted_schema = off` trigger finding to `packages/db/docs/x1-search.md` "Known gaps", and the measured table above to its "sqlite-vec compile flags" bullet.

## graphx changes

### Detection

Run `select vec_version()` once per client and cache it on the client. `bql.ts` tags clients `sqlite` + `managedPragmas` (`packages/graphx/src/core/bql.ts:428-460`). Add a `vec: boolean` resolved by the probe, for embedded and remote alike. For WASM, Expo and any other `sqlite` client the probe fails, and they stay on the JS path.

Record the choice in `graph_meta` as `emb_index = 'vec0'` when the index is created. The query path reads `graph_meta` already (`retrieve.ts:145`). A namespace keeps working the same way after the client that created it is gone.

### Schema

`node_embeddings` on `sqlite` (`dialect-sql.ts:462-471`) keeps JSON `emb` as the source of truth. Fork copies, MMR's `loadEmbeddings` (`hybrid.ts:250`), `embReadExpr` and every non-vec client read it. `vec0` is a derived index that can always be rebuilt from it.

- Add `rid INTEGER PRIMARY KEY` and make `(id, chunk)` a `UNIQUE` constraint. Today the table has a `TEXT` composite primary key, so its rowid is implicit, and SQLite documents that `VACUUM` may renumber implicit rowids. A small probe here didn't renumber, but the guarantee isn't there. libSQL's `vector_top_k` join on `e.rowid` (`dialect-sql.ts:588`) has the same exposure, but its index is maintained by libSQL itself.
- When `vec` is present, `createEmbeddings` (`schema.ts:359`) also runs `CREATE VIRTUAL TABLE node_embeddings_vec USING vec0(emb float[${dim}] distance_metric=cosine)`. Cosine distance in `vec0` is `1 - cos`, the same `dist` the JS path and libSQL's `vector_distance_cos` return.
- `dropEmbeddings` (`schema.ts:371`) drops both tables. `embeddingsIndexDDL('sqlite')` stays `''`, and the vec table gets its own fill statement, `INSERT INTO node_embeddings_vec(rowid, emb) SELECT rid, emb FROM node_embeddings`. That works directly from the JSON text (verified).
- Metadata, partition and auxiliary columns aren't needed. The live filter is structural (below), and the join back to `node_embeddings` by `rid` supplies `id`, `chunk` and `text`.

Changing the `sqlite` table layout changes it for WASM and Expo too. It's a schema-version bump with a rebuild of `node_embeddings` (copy rows, drop, rename). Following graphx's no-backward-compat rule there's no shim, but existing files do need the migration to run.

### Keeping it in sync

Use explicit statements in graphx's own batches, not triggers. The trigger version fails every graphx write on a server with `trustedSchema = false`, and on any connection that has `trusted_schema = off`. That was measured above.

These are the write sites, and each one gets a paired `node_embeddings_vec` statement in the same batch or transaction:

- `graph.ts:877` (hard delete), `graph.ts:1095-1100` (re-embed one node: delete then insert), `graph.ts:2457` (retire/delete in a transaction).
- `bulk.ts:446` / `:466`. For a large load, drop and refill the vec table around it, as `bulk.ts:476` does for libSQL's index.
- `reembed` around `graph.ts:1191`, which recreates the index for libSQL only today.
- `fork.ts:510-520` (row copy into a `sqlite` target): refill after the copy. `fork.ts:649` (in-place trim after a native bql.sh fork): the trim must delete from the vec table too, or the branch keeps the parent's trimmed-away vectors in its index. This is the one site that already deletes by `id NOT IN (…)`, so the vec delete has to be by `rid` from the same subquery, run before the `node_embeddings` delete.

`doctor` (graph.ts around `:1217`, which already counts vectors) compares `count(*)` of the two tables and offers a rebuild. That's the repair path if a write site is ever missed.

`vec0` has no upsert (`src/search/vector.ts:136`), and graphx's sites are already delete-then-insert, so this fits.

### Query

The vec arm in `vectorSeedRows` (`retrieve.ts:187-209`) replaces the `annSeeds('sqlite')` throw (`dialect-sql.ts:583`):

```sql
SELECT e.id AS id, e.chunk AS chunk, e.text AS text, v.distance AS dist
FROM node_embeddings_vec v
JOIN node_embeddings e ON e.rid = v.rowid
WHERE v.emb MATCH ? AND v.k = ?
ORDER BY dist, e.id, e.chunk
```

Bind the query as the JSON string graphx already builds, and `k` as `min(4096, k * 4)`. The existing grouping loop in `vectorSeedRows` turns chunks into nodes unchanged.

Keep `isZeroVector` ahead of it, because `vec0` returns `null` distances for a zero query. A stored zero vector also gets a `null` distance, while the JS path scores it 1. I'd add `distance IS NOT NULL` to the query and a test for it rather than reject zero vectors at write time, since the JS path accepts them.

The clamp matters for as-of queries. `retrieve.ts:241` asks for `k × ASOF_SEED_MULTIPLIER` (4) and `hybrid.ts:188` for `fetchK × SEED_MULTIPLIER` (4), and the arm then multiplies by 4 again for chunks. A past-time `k = 100` asks `vec0` for 1,600. It's fine today but has a hard ceiling. Past 4096 the result is truncated, not an error. That's the same over-fetch-then-filter loss libSQL's path already has.

### Bitemporal live filtering

There's nothing to add. Every row in `node_embeddings` is a live vector (`retrieve.ts:28`, `dialect-sql.ts:509-512`). Retire and delete remove the row, and as-of-past queries over-fetch live vectors and filter ids with `idsValidAt`. The vec table mirrors `node_embeddings` row for row, so it inherits all of that. libSQL's index stopped being partial for the same reason.

### Chunked embeddings

Each chunk is a row and a vector. The arm returns chunks and groups to the best chunk per node, exactly as the libSQL arm does. The `k × 4` over-fetch is the existing heuristic for several chunks of one node crowding the top.

### Fallback

If there's no `vec` probe and no `emb_index` meta, graphx uses `sqliteVectorSeedRows` as today. That covers WASM, Expo without the plugin, `bun:sqlite`, and a bql.sh node on a system `libsqlite3`. It still hits `maxRows` remotely. The README should say plainly that bql.sh vector search beyond ~7k to 10k chunks needs the vendored library.

The hard case is a namespace with `emb_index = 'vec0'` opened by a client without `vec0`, for example a bql.sh file copied into a WASM app. Reads of `node_embeddings` work. Any statement that touches `node_embeddings_vec` fails `no such module: vec0`, and so does `DROP TABLE` on it. graphx would refuse vector writes there with a named error. That choice is open question 2.

### SQLite WASM and Expo

The schema change reaches them, but the index doesn't. They keep the JS path. Expo can opt in later: `expo-sqlite` ships sqlite-vec behind the `withSQLiteVecExtension` config plugin, loaded via `SQLite.bundledExtensions['sqlite-vec']` and `loadExtensionAsync` on native platforms (Expo docs). graphx's `expo.ts` would load it and the same probe would turn the arm on. SQLite WASM has an upstream sqlite-vec WASM build, but graphx's WASM driver doesn't bundle it. Both are out of scope here.

## Exact or approximate

Exact `vec0` fixes the socket and `maxRows` problems whatever the corpus size, because only `k × 4` rows leave the server. Latency is linear: about 1 ms at metro-graph's size and about 90 ms at 200k × 768 without NEON. graphx's bql.sh users are lexical-first graphs and small-to-mid vector sets (`docs/bql.md`), so exact is good enough, and it gives recall 1.0, which libSQL's DiskANN doesn't.

Above about 500k vectors per namespace it's too slow for interactive retrieval. That's where 0.1.10's DiskANN would come in. I wouldn't pin a pre-release with a warned-unstable shadow-table layout into a server that keeps tenant files for years. Re-evaluate when a 0.1.10 or 0.2 stable ships. The graphx side doesn't change: the DDL gains `indexed by diskann(…)`, the query stays `MATCH … AND k = ?`.

## Risks

- `vec0` isn't innocuous. Any future move to triggers runs into `trusted_schema = off`. Keeping sync in graphx statements avoids that, at the cost of six write sites that have to stay paired. `doctor` is the backstop.
- Vectors are stored twice, as JSON text and as float32. For 768 dims that's about 3 KiB on top of about 8 KiB per chunk. I accept that for portability. The alternative is open question 3.
- A namespace written with `vec0` isn't fully writable from a client without it (above).
- float32 ranking can reorder near-ties compared with the JS double-precision path. The ranking golden's `bql` section (`docs/bql.md`, "Verified") will need re-recording, and the diff should be read rather than accepted blind.
- sqlite-vec is pre-1.0. Its maintainer warns about breaking changes. The pin is what protects existing files, so bumping it needs a test that opens a file written by the old pin.

## Open questions

1. Is exact `vec0` the target (fine to a few hundred thousand vectors per namespace), or does graphx on bql.sh need to scale past that soon enough to justify tracking the 0.1.10 DiskANN alphas?
2. When a namespace with a `vec0` index is opened by a client without `vec0`, should graphx refuse vector writes (my recommendation), or write `node_embeddings` only and mark the index stale for the next vec-capable client to rebuild?
3. Should vectors be stored twice (JSON plus `vec0`, my recommendation), or in `vec0` only, with `vec_to_json` reads on vec clients and the JS path not available for those files?
4. The `rid INTEGER PRIMARY KEY` change migrates every existing `sqlite`-dialect file, WASM and Expo included. Is that acceptable, or should the vec arm key by a `vec0` text primary key (`id || ':' || chunk`) and leave the base table alone?
5. Should Expo opt-in (`withSQLiteVecExtension`) be part of this, or a follow-up?

## Order of work

1. **Measure.** Add the `bql` bench driver (embedded and remote) and the vector-only recall/latency script. Run it at 6.4k (metro-graph), 50k and 500k × 256/768 on libSQL, the bql.sh JS scan and a hand-written `vec0` arm on a branch. Done when graphx's `docs/bql.md` has the table, the measured failure point of the JS scan, and libSQL's recall@10/50 against exact.
2. **bql.sh: NEON and arm64.** Measure `SQLITE_VEC_ENABLE_NEON` on arm64 and add it for arm64 only if it helps. Add a Linux arm64 CI leg running `sqlite:build` and `test/search/`. Add the trigger and timing findings to `x1-search.md`. Done when CI is green on both architectures and `--explain` gives the reason for the flag.
3. **graphx: schema and detection.** The `rid` migration, the `vec` probe on bql clients, `emb_index` meta, `createEmbeddings`/`dropEmbeddings` for the vec table. Done when `init` on a bql client creates both tables, `init` on WASM/`bun:sqlite` creates only `node_embeddings`, and the migration test upgrades a file written at the previous schema version.
4. **graphx: sync and query.** The paired statements at every write site, the vec arm in `vectorSeedRows`, the zero-vector and 4096 clamps, the `doctor` count check and rebuild. Done when these tests pass under `GRAPHX_TEST_DRIVER=bql`, embedded and remote:
   - insert, re-embed, retire and hard-delete leave both tables with equal counts and matching `rid`s;
   - a native fork plus trim leaves the branch's vec table matching its `node_embeddings`;
   - row-copy fork, `bulkLoad` and `reembed` refill the vec table;
   - top-k from the vec arm equals the JS scan's on the same data (ties aside);
   - a namespace above 10,000 chunks returns results over remote Hrana, where today it fails `TOO_MANY_ROWS`;
   - as-of-past and chunked retrieval match the libSQL suite's expectations;
   - the ranking golden's `bql` section is re-recorded and reviewed.
5. **Docs.** Update graphx's README backend section and `docs/bql.md` (move "No ANN" out of "Not done", list the fallback rule and the ~7k–10k chunk ceiling without the vendored lib). Done when both match what shipped.
