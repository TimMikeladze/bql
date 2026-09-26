# bql.sh time-series competitive assessment

Assessed 2026-09-13 against the working tree during the monorepo transition to `e268498`. This is an architecture assessment and proposed direction, not an implemented time-series feature set or a competitor performance result. Companion: [competitor research](timeseries-competitors.md).

**bql.sh has a useful operational database foundation, but it is not yet a purpose-built time-series database.** Finishing the existing roadmap will not by itself make it competitive on large historical scans. The existing design explicitly targets “SQLite, many of them, replicated, fast,” with one writer per database ([design](../packages/db/docs/design.md)). A time-series product needs a new workload contract and development track.

## What is already valuable

- A native SQLite driver, prepared-statement cache, query deadlines and authorization.
- Database-per-tenant isolation, connection eviction, quotas and worker placement.
- Durable group commit, physical WAL replication, replica acknowledgement levels, read-your-writes positions, epoch-fenced promotion and a Raft control plane.
- Snapshots, backup shipping and point-in-time restore.
- Embedded and network access, SQL, Hrana, TypeScript clients and ORM integration.
- Hook-driven changes and live queries.

These are reusable foundations. The proposed time-series work should preserve their contracts where applicable. Neither replication nor group commit needs to be invented again. A prepared-statement cache already exists in [database.ts](../packages/db/src/sqlite/database.ts); it should not be mistaken for a missing feature merely because older plans mention a future plan cache.

## The principal blockers, grounded in code

| Priority | Finding | Consequence and required work |
| --- | --- | --- |
| Architectural | SQL execution goes to SQLite's row-oriented engine through `sqlite3_step`; returned values are decoded one cell at a time. See [statement.ts](../packages/db/src/sqlite/statement.ts), [values.ts](../packages/db/src/sqlite/values.ts). | Faster FFI calls can improve materialization, but do not provide column pruning at storage level, vectorized scans, parallel aggregates or time-series compression. SQL aggregates already run inside SQLite; the FFI cell cost applies to returned data, not every input row of an aggregate. |
| Architectural | [shardOf](../packages/db/src/server/workers/shard.ts) hashes the database name; [placement](../packages/db/src/cluster/placement.ts) also places whole databases. [Tenant](../packages/db/src/tenant/tenant.ts) has one writer and synchronous read execution. | More workers scale independent tenants. They do not split one large tenant's ingest or execute one query across cores/nodes. Pooled readers are connections, not independent execution threads. Large-tenant scaling requires explicit partition ownership and query coordination. |
| Architectural | [Shipper](../packages/db/src/storage/shipper.ts) uploads log records and snapshots. [Tenant.retain](../packages/db/src/tenant/tenant.ts) prunes snapshots/log segments. | S3 backup is not a queryable historical tier. Existing retention is not event-time row retention. Add time partitions, queryable immutable segments, metadata-based pruning, compaction and partition expiration. |
| Product | No first-class time-series model, time bucket/gap-fill functions, managed rollups, series catalog, ingestion protocol or partition planner was found in database source and benchmarks. | SQLite SQL can express some time-series queries manually. The missing work is native product support and optimized execution, including precise timestamps, tags, duplicate policy, out-of-order arrivals and late corrections. |
| Immediate | [exec.ts](../packages/db/src/server/exec.ts) calls `stmt.values()` before checking `rows.length > maxRows`. | A small response cap does not bound result allocation. Enforce row and byte budgets during stepping; add bounded batch streaming with cancellation and reader lifetime management. Preserve rollback behavior for writes with `RETURNING`. |
| Immediate | [writeQueued](../packages/db/src/tenant/tenant.ts) appends to an array without an explicit queue admission limit. `maxGroupCommit` limits each drain, not backlog size. | Add bounded queued bytes/requests, queue wait deadlines, overload responses, cancellation and fair scheduling. Batch size should also respect byte and execution-time budgets. |
| Scaling/correctness | [Live queries](../packages/db/src/realtime/live.ts) rerun SQL after invalidation; [replica apply](../packages/db/src/realtime/index.ts) invalidates all live queries and emits no row changes. The [change ring](../packages/db/src/realtime/ring.ts) is in memory. | Live SQL is not an incremental continuous aggregate. Restart loses replay history; replica feeds cannot supply logical rows for durable analytics ingestion. Build durable replay or deterministic snapshot export with committed progress, plus rollup repair for late data. |
| Evidence | [driver benchmark](../packages/db/bench/driver.ts) uses 100,000 `kv` rows and small operations. [Benchmark notes](../packages/db/docs/benchmarks.md) explicitly warn their server tables predate default changes. | There is no evidence yet for superiority over the named competitors on time-series workloads. Build a dedicated, correctness-checked comparative harness before setting performance claims. |
| Release | [package.json](../packages/db/package.json) advertises `sqlite:build` but its published file list excludes `scripts/` and `vendor/`. | A package dry run confirmed neither build sources nor a bundled library. Fix the supported install path and test installation from the actual tarball on a clean machine. A clone with a built local library masks this gap. |

The synchronous engine also means a long analytical statement occupies its owning worker until completion/cancellation, delaying work for other databases assigned to that worker. Keep interactive ingest and latency-sensitive operations isolated from analytical execution; simply increasing SQL timeouts is not a scaling solution.

## Where to compete first

**User-selected target: high-volume infrastructure metrics / IoT and large historical analytics across billions of rows.** This supersedes the initial application-telemetry assumption. Optimize for sustained durable ingestion, high-cardinality series, selective recent-data queries and broad historical aggregation concurrently. Tenant isolation remains valuable, but one large tenant must be able to use multiple cores and eventually multiple nodes.

For this scope, a SQLite-only time-series layer is a baseline or a separately bounded product; it is not the recommended destination. The engine decision and within-tenant partition model move ahead of extensive time-series API work. Establish a strong single-node implementation first while designing shard identity, commit positions and partial aggregates so it can later distribute safely.

Define “better” using durable ingest capacity, p99 query latency during ingest, freshness, storage and compute cost, tenant fairness and deployment effort. Avoid a blanket “faster than all three” objective: a latest-value lookup, a high-cardinality group-by and a multi-terabyte historical scan stress different designs.

The competitors set different baselines. Timescale combines operational SQL and time-oriented storage/aggregates; ClickHouse has mature columnar analytics and distributed execution options; InfluxDB 3 has telemetry-oriented ingestion and analytical storage. Editions matter, especially ClickHouse Cloud versus self-managed deployments and InfluxDB Core versus Enterprise. See the sourced [comparison](timeseries-competitors.md).

## Recommended architecture decision

The original assessment considered two paths. The user's workload selection favors the second:

1. **Keep SQLite as the only data engine and choose a bounded operational time-series market.** Add typed ingest, appropriate series/time indexes, managed rollups and retention. Measure the largest supported tenant and workload. This is the shortest path to a useful product, but does not remove the historical-scan or single-tenant scaling limits.
2. **For broad historical analytics, retain bql.sh's operational foundation and add a native columnar execution/storage path.** Evaluate an existing engine before writing one. [DuckDB](https://duckdb.org/docs/current/internals/vector) provides vectorized execution; [DataFusion](https://datafusion.apache.org/user-guide/introduction.html) provides an extensible Arrow-based query engine with Parquet support. These are prototype candidates, not selected dependencies or evidence of a speed advantage. DuckDB's documented [concurrency model](https://duckdb.org/docs/lts/connect/concurrency) also needs consideration. Neither engine alone supplies bql.sh's future distributed coordinator and durability contracts.

For the second path, keep tenant/auth/catalog/routing in Bun, run ingestion and analytical compute in dedicated native workers, and exchange typed batches rather than JavaScript objects per cell. Prototype bounded batch ingestion into a durable partition log and recent-data buffers, followed by immutable columnar segments. The chosen native engine may supply parts of that machinery; a query engine alone does not supply the full ingestion/storage system. Store historical data in time/series-sorted immutable segments, with timestamp ranges, series statistics and column pruning. Add local caching and object storage only with measured query and compaction costs. Use SQLite for metadata and optional transactional tables; do not make every metric sample traverse its single writer without evidence that this meets the target.

**Existing SQLite WAL replication does not automatically replicate the new sample store.** Define acknowledgement levels, replication, fencing, backup and restore for the new log/segment manifest. Reuse proven control-plane concepts and interfaces where they fit, but the new data path needs its own recovery evidence. Existing SQLite tests cannot establish those guarantees.

**The user explicitly permits other engines and infrastructure, including Parquet, DuckDB and S3.** The repository's historical “zero runtime dependencies” rule is therefore not a constraint on this proposed direction. The SQLite-specific execution interface still needs adaptation. Native dependencies create binary distribution, SQL compatibility and operational work, so benchmark and package the chosen path explicitly.

The recommended first prototype stack is:

| Responsibility | Starting choice | What must be proven |
| --- | --- | --- |
| Server, authentication, tenant routing and SDK | Existing bql.sh/Bun modules | Bounded queues and isolation from analytical CPU work |
| Local metadata and optional transactional tables | SQLite | Atomic manifest/progress changes; cluster metadata ownership must remain consistent with the control plane |
| Recent sample ingestion | Partitioned, bounded durable batches; evaluate the selected engine's supported ingestion path before writing a custom log | Durable acknowledgements, replay, idempotency, fresh reads and multicore ingest within one tenant |
| Analytical execution | DuckDB as the first candidate; retain DataFusion as an alternative | Scan/group-by performance, mixed-load concurrency, resource limits and the cost of crossing from Bun to native execution |
| Historical storage | Sorted immutable Parquet files, initially on local disk | File/row-group pruning, compression, late corrections and compaction without a small-file explosion |
| Shared historical persistence | S3-compatible object storage with a bounded local cache | Atomic visibility through manifests, object-store latency/cost, retries and recoverable publication |

This is a prototype recommendation, not a claim that DuckDB has been integrated or selected by measurements. Start with local execution and storage to isolate engine costs, then add the S3 leg and measure both. Parquet defines a file format, S3 stores objects and DuckDB executes analytical queries; combining them still requires an ingestion, consistency and lifecycle design. Do not substitute direct per-sample S3 writes for a bounded durable batch path.

**The hardest integration is consistent reads and recovery across recent and historical data.** Define one authoritative durable record, generation and per-partition commit positions, idempotent segment publication, a query visibility cutoff, and the conditions under which recent data can be discarded. Event time alone cannot be that cutoff: late arrivals and corrections can belong to old buckets. A query spanning both tiers must see each logical point exactly once under the chosen duplicate policy.

Do not use the current post-commit in-memory change feed as the sole export/outbox mechanism. A crash after commit and before publication can lose the downstream action. Physical WAL durability does not automatically provide a logical row stream; choose durable logical records, transactional outbox records, or consistent snapshot extraction with a recoverable progress protocol.

`bql.sh/bus` currently opens `bun:sqlite` directly ([store.ts](../packages/bus/src/bus/store.ts)). Being in the same repository does not establish shared storage, transactions or recovery. It could eventually schedule compaction, retention and rollup jobs; it is not currently an integrated or proven high-throughput sample-ingestion path.

## Work sequence and completion gates

1. **Establish the workload and benchmark.** Specify target hardware, tenants, largest tenant, points/second, series cardinality, retention horizon, query mix, freshness and durability requirements. Commit deterministic data generation, expected answers, workload definitions and machine-readable results. Existing microbenchmarks remain useful for regressions.
2. **Bound the current server.** Fix result allocation limits, queue admission and cancellation; measure p99 interference under mixed load. Verify the packaged installation path. Add targeted tests that exercise those externally visible guarantees.
3. **Run the engine and partition decision experiment.** Use indexed SQLite plus rollups as a baseline against native columnar candidates on the same mixed workload, beyond available memory as well as in cache. Test multiple ingestion partitions within one large tenant and parallel analytical execution. Record ingest-to-query visibility, data movement, memory, durable write costs and maintenance debt. Select the engine and partition model from these results before building an extensive interface around them.
4. **Ship a narrow native time-series vertical slice.** Typed points and bounded batch ingest; precise timestamp unit/UTC semantics; series identity and tag cardinality rules; event-time ranges/latest-per-series; duplicate and retry semantics; durable recent-data visibility and a historical aggregate. Choose partition size and sort order from workload measurements. Avoid one database or tiny file per series. Run ingestion and queries concurrently so an analytical scan cannot monopolize ingestion resources.
5. **Complete the durable historical tier and lifecycle.** Implement visibility/manifest transactions, resumable segment publication, statistics, compaction, late-data overlays or rewrites, tombstones, retention, incremental rollups and restore. Verify no missing or double-counted points across crashes and tier transitions. Incremental averages need sum/count states; percentiles need appropriately mergeable states or recomputation. Keep raw sample ingestion durable and observable when object storage or compaction falls behind.
6. **Distribute individual large tenants after proving single-node behavior.** Extend the partition identities and ownership from the prototype across nodes; push predicates and partial aggregates down, then combine them in a coordinator. Add distributed limits, partial-failure behavior, snapshot/freshness semantics, rebalancing, partition-level replication and admission control. Whole-database placement is only a starting point.
7. **Prove the product under operations.** Long-running mixed-load tests with compaction and retention active, process/node failures, network partitions, disk exhaustion, delayed object storage, backup/restore and upgrades. Ship the ingestion and visualization integrations the chosen customers need, such as OTLP/Prometheus or Influx line protocol and Grafana. SQL support alone does not establish connector compatibility.

This is a roadmap ordered by dependencies, not a calendar estimate. Broad competition with mature analytical databases is a storage/query-engine effort, not a handful of FFI optimizations. Engine selection, target scale and staffing are needed before a credible delivery estimate.

## Benchmark contract

- Pin each competitor version and edition; document schema, indexes, sort keys, compression and settings. Use documented best-practice configurations and give each system equivalent tuning effort.
- Test one large tenant and many small tenants separately. Vary cardinality and skew, batch sizes, concurrency, late arrivals, duplicates and wide/sparse values.
- Query latest values, narrow series ranges, time-bucket aggregates, fleet-wide group-bys, distinct series, percentiles, gap-filled charts and long historical scans. Validate answers, timestamp precision, null/NaN behavior and declared approximate error bounds.
- Test ingest and reads together. Run long enough to expose checkpointing, compaction, index maintenance, retention and replica catch-up; report backlog rather than ending a test before deferred work is paid.
- Align acknowledgement durability and replication expectations. Measure durable points/second and query-visible points/second separately. An accepted HTTP request is not necessarily a durable or queryable point.
- Report p50/p95/p99, errors, CPU, peak RSS, physical bytes on disk/object storage, WAL/replication/upload traffic, maintenance debt and recovery time. Exercise warm cache, deliberately documented cold-cache conditions and data larger than memory.
- Separate load generators from database workers, repeat runs, report variance and distinguish driver, server and network timings. Do not infer competitor throughput from bql.sh's point-read latency.

## Verification performed

- Database suite: `cd packages/db && bun test` → **1,487 passed, 2 skipped, 0 failed**, 124 test files, 52.81 seconds on the local macOS/Bun 1.4.0 environment. This validates the existing tested behavior, not large-scale time-series readiness or all failure modes.
- Driver benchmark, rerun after the suite completed: primary-key point read **0.76 µs**, 100-row object scan **8.54 µs**. Same-run `bun:sqlite`: **0.81 µs** and **11.62 µs**. In-transaction inserts were **0.27 µs** versus **0.26 µs**. These are local microbenchmarks, not a competitor comparison or a controlled hardware certification.
- `npm pack --dry-run --json --ignore-scripts`: 135 package files; no `scripts/sqlite.ts`, no `scripts/native/` files and no `vendor/` library. No package was published.
- Reviewed storage, tenant execution, worker/cluster placement, replication/realtime behavior, configuration, client encoding, benchmarks, release packaging and roadmap notes. Some historical roadmap entries contradict current code (for example, group-commit defaults and already-built promotion); findings above prioritize executable code.
- No product implementation was changed. This assessment and companion research are documentation only. No named competitor was installed or benchmarked during this assessment.
