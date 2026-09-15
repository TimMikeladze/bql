# Time-series competitor baseline

Research date: 2026-09-13. These are documented capabilities, not measured performance comparisons. Pin product edition, engine version, hardware, durability, and configuration before benchmarking. The BunQL conclusions below are recommendations; the companion code assessment determines which capabilities are already implemented.

## What the competitors actually provide

| Area | TimescaleDB / Tiger Data | ClickHouse | InfluxDB 3 |
| --- | --- | --- | --- |
| Storage and pruning | PostgreSQL hypertables automatically partition by time; Hypercore adds compressed columnar batches, vectorized aggregation, sparse indexes, and metadata summaries. | MergeTree stores sorted parts, merges them in the background, and uses sparse primary indexes and partition pruning. | Core stores Parquet. Current Enterprise defaults new clusters to its upgraded columnar `.pt` format. Clustered documents Arrow/DataFusion, Parquet, and a partition catalog. |
| Ingestion | PostgreSQL batch INSERT / COPY; warm data remains mutable. | Large batches or server-side async batching avoid excessive small parts. | Batched line protocol; Core guidance is 10,000 lines or 10 MB, whichever comes first. |
| Repeated dashboard queries | Incrementally refreshed continuous aggregates, hierarchical rollups, optional combination with newest raw data. | Incremental materialized views compute on inserted blocks and store results in target tables. | SQL time bucketing; Core/Enterprise can schedule the Python downsampler plugin to persist results. |
| Retention | Scheduled whole-chunk drops. | TTL expiry and tier movement during merges. | Core database retention filters expired points at query time; Enterprise adds mutable/table-level policies. |
| Scaling | Do not mistake legacy distributed hypertables for current functionality; that feature was sunset in 2.14. | Self-managed Distributed queries across shards; Cloud SharedMergeTree uses shared object storage and distributed execution. | Core, Enterprise, and Clustered are distinct deployment/architecture baselines; Enterprise adds HA/read replicas, and Clustered has dedicated router, ingester, querier, catalog, and compactor components. |
| Object storage | Tiger Cloud tiered queryable storage is a Scale/Enterprise feature, with explicit tiered-read settings and mutation restrictions. | Cloud SharedMergeTree uses shared storage; self-managed MergeTree also supports external storage configurations. | Native persistence in Core/Enterprise can use local files or object storage; Clustered uses object storage for Parquet. |

Sources and material qualifications follow.

## TimescaleDB and Tiger Cloud

Hypertables route data into time chunks and prune irrelevant chunks for queries. This is database planning/storage behavior, beyond providing timestamp SQL functions. [Hypertables](https://www.tigerdata.com/docs/learn/hypertables/understand-hypertables)

Hypercore combines row storage for recent writes with compressed column storage. Current documentation describes vectorized aggregation, bloom/minmax batch skipping, metadata-only summaries, and transactional INSERT/UPDATE/DELETE/UPSERT on columnstore data. Therefore, “SQLite supports SQL and is fast at inserts” does not address this analytical baseline. Vendor compression percentages and speedup claims are workload dependent and are not BunQL comparison results. [Hypercore](https://www.tigerdata.com/docs/learn/columnar-storage/understand-hypercore)

Continuous aggregates track changed raw data and refresh materializations incrementally. Aggregates can be layered at different resolutions. Combining recent raw data with stored aggregates is opt-in in versions 2.13+. Refresh boundaries, late writes, and retention interactions matter: changing a joined ordinary PostgreSQL table is not tracked like changing the source hypertable. [Continuous aggregates](https://www.tigerdata.com/docs/learn/continuous-aggregates)

Retention jobs drop entire aged chunks. Bulk ingest supports PostgreSQL COPY, with a parallel-copy utility available. [Retention policy](https://www.tigerdata.com/docs/build/data-management/data-retention/create-a-retention-policy), [bulk migration and COPY](https://www.tigerdata.com/blog/how-to-migrate-your-data-to-timescale)

Tiger Cloud object tiering stores Parquet in S3/Azure Blob and applies chunk, row-group, and column pruning. It is available on Scale/Enterprise plans. Tiered reads must be enabled; tiered chunks cannot be inserted into, updated, or deleted, and schema operations have restrictions. Queryable tiering is a materially different capability from sending backups to S3. [Tiered storage](https://www.tigerdata.com/docs/learn/data-lifecycle/storage/about-storage-tiers)

The old distributed-hypertable feature is explicitly marked sunset in 2.14.x. Do not infer present self-hosted distributed analytical capabilities from older multi-node architecture articles. [Official archived API documentation](https://github.com/timescale/docs/blob/latest/api/distributed-hypertables/index.md)

## ClickHouse

MergeTree inserts create sorted parts and background merges consolidate them. Its sparse primary index addresses granules rather than individual rows; partition pruning eliminates irrelevant partitions. Reading is parallelized. TTL supports expiry, moving data between storage volumes, and recompression, with expiry evaluated during background merges. Self-managed external storage configurations also exist. [MergeTree](https://github.com/ClickHouse/ClickHouse/blob/master/docs/en/engines/table-engines/mergetree-family/mergetree.md)

Official guidance recommends at least 1,000 rows, ideally 10,000–100,000, for synchronous insert batches. Async inserts buffer compatible writes to reduce part creation. With `wait_for_async_insert=1`, acknowledgement follows successful flush; setting it to zero instead acknowledges an in-memory buffer. These modes must not be treated as equivalent in a durability benchmark. [Ingestion and concurrency guidance](https://clickhouse.com/resources/engineering/high-concurrency-sizing-user-analytics)

Incremental materialized views execute on inserted blocks and write transformed/aggregated results into a target table. Their insert-trigger semantics differ from automatically repairing every historical mutation or joined-table change. [Incremental materialized views](https://github.com/ClickHouse/clickhouse-docs/blob/main/docs/materialized-view/incremental-materialized-view.md)

Self-managed Distributed tables fan queries out to remote servers, including remote partial aggregation followed by merging aggregate states. This is separate from replication. [Distributed engine](https://clickhouse.com/docs/engines/table-engines/special/distributed)

ClickHouse Cloud uses SharedMergeTree, with shared object storage and Keeper metadata coordination, and supports distributed query execution over compute replicas. Do not assume a self-managed ReplicatedMergeTree deployment or Distributed DDL is the Cloud architecture. [SharedMergeTree](https://clickhouse.com/docs/products/cloud/features/infrastructure/shared-merge-tree)

## InfluxDB 3: editions and engines matter

Core always uses Parquet. Its default query-file limit is 432, commonly corresponding to a roughly 72-hour range with default file duration. This is configurable, not an immutable 72-hour historical cutoff. Raising it increases query resource costs; Enterprise provides historical compaction. [Core storage engine](https://docs.influxdata.com/influxdb3/core/reference/internals/storage-engine/), [Core configuration](https://docs.influxdata.com/influxdb3/core/reference/config-options/)

Current Enterprise documentation says new clusters default to an upgraded columnar `.pt` engine; clusters started on 3.10 or earlier retain Parquet until upgraded. It sorts by column family, series key, and timestamp, uses type-specific encodings, and targets bounded persistence/compaction resources and selective series queries. Parquet export applies to compacted data. Describing all InfluxDB 3 storage as Parquet would miss this newer engine. [Enterprise storage engine](https://docs.influxdata.com/influxdb3/enterprise/reference/internals/storage-engine/)

Core write guidance recommends batches of 10,000 lines or 10 MB and supports nanosecond timestamps. Core retention filters expired points at query time even before physical deletion; Core retention is set when creating the database, whereas Enterprise supports updating policies and table-level retention. [Optimize writes](https://docs.influxdata.com/influxdb3/core/write-data/best-practices/optimize-writes/), [Core retention](https://docs.influxdata.com/influxdb3/core/reference/internals/data-retention/)

Core/Enterprise support scheduled persisted downsampling through the Python processing engine; SQL `DATE_BIN` can also aggregate at query time. Cloud Serverless/Dedicated use a different externally scheduled query-and-write pattern in this guide. Do not claim that InfluxDB 3 has no rollup capability. [Official downsampling guide](https://www.influxdata.com/blog/downsampling-guide-influxdb-3/)

Enterprise adds HA, read replicas, and historical query support to Core. Clustered separately documents a Rust/Arrow/DataFusion design with replicated ingestion, recent-data buffers, Parquet object storage, a catalog, and compaction. Its user-defined time/tag partitioning can prune data for matching queries; those exact controls should not be attributed to Core without checking. [Enterprise overview](https://docs.influxdata.com/influxdb3/enterprise/), [Clustered architecture](https://docs.influxdata.com/influxdb3/clustered/reference/internals/storage-engine/), [Clustered partitioning](https://docs.influxdata.com/influxdb3/clustered/admin/custom-partitions/)

## Implications for BunQL

These are engineering hypotheses to validate against BunQL code and measurements:

1. The user selected high-volume infrastructure metrics / IoT and large historical analytics across billions of rows. This supersedes the initial application-telemetry recommendation: evaluate partitioned durable ingestion and native columnar execution first, including one large tenant using multiple cores. Tenant isolation and developer ergonomics remain differentiators, but must accompany sustained ingestion and historical-query performance.
2. Treat time partitioning, partition pruning, retention, late-data semantics, and rollup correctness as core database behavior. Adding a time-bucket function alone does not establish parity.
3. For large historical analytics, evaluate a columnar historical tier and a native vectorized engine against extending SQLite alone. Decide how a query obtains a consistent view across hot and cold data before promising transparent SQL.
4. Keep storage replication, tenant placement, horizontal ingestion, and distributed query execution separate in architecture and claims. Each solves a different bottleneck.
5. Benchmark durable points/second, bytes/point, p95/p99 ingest and query latency, freshness, cardinality, RAM, and long-running maintenance together. Use both single-row and bulk clients, data larger than memory, ongoing compaction/retention, out-of-order data, and fault/recovery runs. Publish schema, physical design, engine versions, acknowledgements, and result validation.
6. A better product must include practical migration and observability: line protocol/telemetry integrations, dashboard access, bulk import/export, schema management, capacity signals, and tested recovery. Select a narrow supported surface first, then expand from measured customer workloads.

No competitor binaries or comparative time-series benchmarks were run for this research note.
