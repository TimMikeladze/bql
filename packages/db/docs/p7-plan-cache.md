# P7 — the query-plan cache, which turned out to be a ceiling and a blind spot

`docs/plan-phase3.md` P7, the milestone that was a measurement. The cache design §11 asks for is
already built; what it lacks is a way to say how big it is and a way to notice when it is too
small. Both now exist, and the measurement says the default is smaller than the tree needs.

## 1. The answer first

**`[sqlite] statementCache` ships, default `64`, because the measurement found the number binds —
and binds much sooner than anyone guessed.** Six tables of six columns is enough to take the data
API's generated workload from a **100% cache hit rate to 0%**, and the prepare it then pays costs
**81x** what a hit costs on an idle machine (186x on a loaded one, §3). Design §11's phase-3 row
loses its "query-plan cache" bullet regardless, because the cache exists and the one improvement
the bullet's name implies is impossible.

| the measurement | the number |
|---|---|
| data API, 5 tables (60 texts), cache 64 | **100.0% hit**, 0 evictions |
| data API, 6 tables (72 texts), cache 64 | **0.0% hit**, one eviction per prepare |
| data API, 30 tables (360 texts), cache 64 | 0.0% hit |
| the same 30 tables at `statementCache = 512` | **100.0% hit**, 0 evictions |
| a `prepare()` hit | 0.048–0.080 µs |
| a `prepare()` past the ceiling | 4.02–4.14 µs (81x; 186x at load 31) |

## 2. Three of design §11's questions were already answered by the tree

Written down here because each has cost a reader a wrong belief and none was recorded anywhere.

**The cache exists.** `Database.#cache` (`src/sqlite/database.ts`) is an insertion-ordered `Map`
used as an LRU: `prepare()` refreshes recency on a hit and evicts and finalizes the oldest past the
ceiling. `Statement.finalize()` calls back into `uncache`, so a finalized statement cannot be
served from it, and `close()` finalizes the lot.

**`SQLITE_PREPARE_PERSISTENT` is already set** — `prepareStatement(this, sql,
SQLITE_PREPARE_PERSISTENT)`. There was nothing to turn on.

**The cache cannot be shared across connections, and that is a SQLite fact rather than a bql.sh
omission.** A `sqlite3_stmt*` belongs to the `sqlite3*` it was compiled against; no API executes
one prepared statement on two connections, and no API exposes a compiled plan apart from a
statement. A tenant holds one writer plus up to `[data] readers` (default 2) pooled readers, so a
hot database holds **three independent caches of this size**, and that is the only shape SQLite
permits. Read literally, the design §11 bullet asks for something that cannot be built.

## 3. The cliff, measured

`bench/cache.ts`, five interleaved rounds, 20 000 `prepare()` calls a sample. Two runs, on a
machine that was never quiet — `docs/performance.md` §8 — and the effect is so large that it
resolves anyway.

| leg | load 31 (p50 µs) | load 15–17 (p50 µs) | load 9 (p50 µs) | vs hit |
|---|---|---|---|---|
| `hit` | 0.053 | 0.080 | 0.048 | 1.00x |
| `miss` | 5.928 | 3.978 | 4.041 | 50–112x |
| `working 8` | 0.033 | 0.017 | 0.019 | below the floor |
| `working 32` | 0.023 | 0.017 | 0.052 | below the floor |
| `working 64` | 0.034 | 0.049 | 0.028 | below the floor |
| `working 65` | **6.318** | **4.018** | **4.075** | **50–119x** |
| `working 96` | 7.165 | 4.008 | 4.140 | 50–87x |
| `working 256` | 6.213 | 4.060 | 4.186 | 50–88x |

**64 to 65 is 186x on the loaded machine and 82x on the quieter one.** It is a cliff rather than a
slope because a working set cycled round-robin is the LRU's worst case: past the ceiling, the text
about to come round again is always the one just evicted, so every `prepare()` compiles *and*
finalizes a victim and the hit rate is not degraded but zero.

**The `working 8`, `32` and `64` legs read faster than `hit`, which is not a result.** All four are
tens of nanoseconds — a `Map` lookup and two `Map` writes — and the ordering between them changes
run to run (`working 32` is 0.017 µs in one run and 0.052 µs in the next, on the same tree). They
are below this machine's noise floor and are left in the table rather than rounded away, because a
reader who sees only the cliff should also see what the instrument cannot resolve.

## 4. Why 64 binds in real use — three call sites, all confirmed by reading the tree

**The data API builds SQL per request** (`src/dataapi/sql.ts`). Values, `LIMIT` and `OFFSET` are
all bound, which is correct and worth saying: no request string reaches the SQL text, which is that
module's security boundary. But the *text* still varies with the `?select=` column list, with the
set of filtered columns and operators, and with the `?order=` terms. Twelve texts per table is a
modest count for a real client — a get, a narrowed get, four list shapes, an update, a delete and
four bulk-insert widths — and twelve times six is past 64.

**`insertStatement` repeats its placeholder group per row.** A `POST` of 1, 2, 3 … 50 rows is
**50 distinct SQL texts for one table**. It is the clearest single generator of cache pressure in
the tree, and it means a client that batches by whatever it has to hand can exhaust a 64-entry
cache against one table.

**`src/server/exec.ts` prepares the same text twice per read.** `step()` calls
`db.prepare(request.sql)`, and the read path prepares it first to read `.readonly` — deliberately,
because the classification comes from SQLite rather than from a guess about the SQL. On a cache
hit the second one is free. On a thrashing cache a single read request pays **two compiles**, about
8 µs against an HTTP point read of ~48 µs.

### And one thing nobody had noticed: the writer's cache is expired on every authorized write

`AuthorizerHub.setBase` cycles `sqlite3_set_authorizer` for real, on purpose — that is what
expires statements compiled under old verdicts, and §6 tests it. `applyPolicy` calls `setBase`
when scoping a connection and `handle.release()` calls it again with `null`. The read path
(`ServerRuntime.withReader`) never releases, so a reader is scoped once and stays scoped; measured,
three token-authenticated reads cost **one** `sqlite3_set_authorizer` call in total. The **write**
path does release, in a `finally`, so a token-authenticated write costs **two cycles per request**
— and an expired statement is recompiled inside `sqlite3_step` whether or not the cache had it.

| | µs per call |
|---|---|
| cached hit, prepare + step, authorizer left alone | 0.843 |
| cached hit, prepare + step, authorizer cycled around the call | **5.119** |
| the two `sqlite3_set_authorizer` calls alone, no statement | 0.021 |

So the 4.28 µs is the recompile, not the FFI. An **admin** principal costs nothing here — with no
token policy there is no base to install, and the measured cycle count is 0 — which is why no
benchmark in the tree has ever shown it.

**This is a finding, not a fix.** P7 does not change it: making the writer keep its policy
installed the way the reader does is a change to when a connection is scoped, and a connection
left scoped to the last request's token is a security-shaped decision, not a tuning one. It is
recorded here with its number so the next reader does not have to find it twice, and so that §5's
counters are read correctly: **a hit counted here is a hit in bql.sh's cache, not proof SQLite did
not recompile.**

## 5. What landed

**`[sqlite] statementCache`, default 64** (`src/server/config.ts`), documented as what it is: a
ceiling that is **per connection**, so a tenant holds one writer plus `[data] readers` of them, and
crossing it costs ~81–186x per `prepare` rather than a little. It reaches a connection through
`SqlitePragmas` — which is now "per-connection settings" rather than "per-connection pragmas",
since this is the one key there that SQLite knows nothing about — then `openConnection` and
`Database.open`'s `OpenOptions`. Absent, `CACHE_LIMIT = 64` applies exactly as before, so the
embedded API and every existing test behave as they did.

**Three counters** (`hits`, `misses`, `evictions`), incremented in `prepare()` and exported as
`bql_statement_cache_hits_total`, `bql_statement_cache_misses_total` and
`bql_statement_cache_evictions_total`. A *rising* eviction count on a live node is the thrash;
zero is a cache that fits.

The counters live in **one object shared by every connection a registry opens**, following how L5
passes its `FsyncSweep` down. The alternative — per-connection counters summed over
`openTenants` — would make the node's totals *fall* when the LRU evicts a tenant, and a Prometheus
counter that goes backwards is a broken counter rather than a small inaccuracy. One object costs
three integer increments per `prepare()` against a `Map` lookup, and a connection opened without
one (the embedded API, every test) keeps its own, readable as `db.cacheCounters`.

Across `[server] workers` the three **sum**: shards hold disjoint databases, so they hold disjoint
connections. `src/server/workers/{protocol,entry,pool}.ts` carry them the way L4's `openRefused`
already travels.

## 6. The tests, and what each said when its mechanism was removed

`test/sqlite/cache.test.ts` for the driver, `test/server/statement-cache.test.ts` for the wiring
between it and `/metrics`. Each was run against a tree with the thing it pins taken out.

| test | mechanism removed | what it said |
|---|---|---|
| a cached statement keeps answering across `CREATE TABLE` and `ALTER TABLE` | `prepare()` stops serving cached statements | fail — `expect(db.prepare(sql)).toBe(first)` |
| changing the authorizer invalidates a statement compiled under the old one | `authorizer()` swaps `#onAuth` without re-arming `sqlite3_set_authorizer` | fail — **`Received value: { secret: "shh" }`**: the statement kept the old verdicts and read the column it was no longer allowed to read |
| a connection at `statementCache: 4` evicts the fifth text and finalizes the victim | `victim?.finalize()` becomes `void victim` | fail — `held[0].finalized` expected `true`, received `false` |
| the same, the ceiling itself | `> this.#cacheLimit` becomes `> 1` | fail — `statementCacheSize` expected 4, received 1 |
| counters are per connection unless one is shared | `prepare()` stops serving cached statements | fail — `hits: 1` became `hits: 0, misses: 3` |
| a server at `[sqlite] statementCache: 4` evicts and `/metrics` says so | `openConnection` stops passing `statementCache` to `Database.open` | fail — evictions expected `> 6`, received `0`: the connection silently ran at the default 64 |
| the default 64 holds the same working set, and a warm pass is all hits | the registry stops sharing its counters with its tenants | fail — `bql_statement_cache_hits_total` expected `> 0`, received `0`: every connection counted into an object nothing reads |

The second one is the milestone's point: `src/sqlite/database.ts`'s header has claimed since P0
that the re-arm is what expires cached statements, and nothing tested it. It does, and now it is
pinned.

## 7. Done when — against `docs/plan-phase3.md`'s P7 criteria

| criterion | result |
|---|---|
| the measured hit rate of the default 64 on the data API's generated workload | **yes**: 100% up to 5 tables, **0% at 6**, 0% at 30; 100% at 30 tables with `statementCache = 512`. `bench/cache.ts`'s census drives the real `introspect` and `buildStatement` |
| the cost of a forced miss against a hit on the driver bench, **or** an explicit "below this machine's resolution" | **yes**: 0.048 µs against 4.041 µs, 81x, reproduced at three different machine loads |
| **either** `[sqlite] statementCache` landed because 64 binds **or** design §11 lost the bullet | **both.** The key landed because 64 binds at six tables; the bullet goes because the cache it asks for exists and the sharing its name implies cannot |
| a cached statement keeps answering across a `CREATE TABLE` on the same connection | **yes**, `test/sqlite/cache.test.ts`, and across an `ALTER TABLE` of the very table it reads |
| changing the authorizer invalidates a statement compiled under the old one | **yes**, and the removal test reads the denied column, which is the failure the header warns about |
| each run against a tree with the mechanism removed and seen to fail | **yes**, all seven, §6 |
| `bun run bench --only driver` must not move the 100-row scan by more than 2% | **could not be resolved on this machine**, and that is the honest answer — see below |

### The 2% gate could not be resolved

Fifteen interleaved A-B rounds against a stash of the parent tree, `uptime` at load 9–10 throughout:

| | p50 | mean | min | max | spread |
|---|---|---|---|---|---|
| P7 tree | 9.08 µs | 9.23 | 8.57 | 10.51 | 21% |
| parent | 9.24 µs | 9.30 | 8.62 | 10.67 | 22% |

The P7 tree's median is **1.7% faster** and its mean 0.7% faster — wrong-signed for a regression,
and both far inside a within-leg spread of 21%. **A 2% effect cannot be resolved by an instrument
whose own noise is twenty-one.** What can be said: the change is not a *visible* regression, and
the mechanism agrees — three integer increments on a plain object, against a `Map` lookup that the
same benchmark measures at 48–80 ns and a 100-row scan of 9 µs. This is L5's outcome and it is a
result; reporting "+1.7% faster, gate passed" would not be.

## 8. What contradicts `docs/plan-phase3.md`

**The plan expected 64 to bind at about thirty tables** — "a 30-table database can exceed 64 live
SQL texts on one connection". It binds at **six**. The plan's estimate counted one statement per
operation per table; the generator writes a text per *shape*, and a `?select=`, a filter set, an
order and a row count are each a shape. That is the difference between a ceiling a large tenant
reaches and one a small one does.

**The plan called P7 "an afternoon" and "a measurement".** Both true. But it also assumed the
cache is working wherever it hits, and §4's last subsection is the counter-example: on the
token-authenticated write path the cache hits and SQLite recompiles anyway. That is not a P7 bug —
the authorizer re-arm is deliberate and §6 now tests it — but it is a real 4.3 µs on a ~27 µs write
path that no plan document names, and it should be somebody's milestone rather than a footnote.

## 9. What it touched

| file | what |
|---|---|
| `src/sqlite/database.ts` | `OpenOptions.statementCache` and `.cacheCounters`, the exported `StatementCacheCounters`, `#cacheLimit`, the three increments in `prepare()`, and `statementCacheLimit` / `statementCacheSize` |
| `src/sqlite/index.ts` | exports `StatementCacheCounters` |
| `src/server/config.ts` | `[sqlite] statementCache`, its default and its documentation; the section comment, which no longer claims everything in it is a pragma |
| `src/tenant/tenant.ts` | `SqlitePragmas.statementCache`, `TenantOptions.statementCacheCounters`, both threaded through `openConnection` |
| `src/tenant/registry.ts` | the shared counters object, handed to every tenant, and `RegistryStats.statementCache` |
| `src/server/metrics.ts` | the three `bql_statement_cache_*` counters |
| `src/server/workers/{protocol,entry,pool}.ts` | the shard share and its sum |
| `bench/cache.ts` | the data API census — two passes over the real `introspect` and `buildStatement`, warm hit rate against table count and ceiling |
| `test/sqlite/cache.test.ts` | new; five driver tests, §6 |
| `test/server/statement-cache.test.ts` | new; the config key and the three metrics end to end |
| `docs/api.md` | the config row and the three metrics |
| `docs/design.md` | §11 loses the "query-plan cache" bullet and gains a pointer here |
