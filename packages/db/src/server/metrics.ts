// Invariant: every series here is per process. Nothing is keyed by database, token or route
// template, so a node with ten thousand tenants exports the same handful of lines as a node with
// one — which is the only way `/metrics` can stay cheap enough to scrape on the hot path.
//
// Latency is a fixed-bucket histogram in microseconds rather than a summary, because Prometheus
// can aggregate buckets across nodes and cannot aggregate quantiles.

/** Microsecond boundaries, chosen around design §10's budgets (60 µs HTTP, 40 µs write). */
const LATENCY_BUCKETS = [
  25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 50_000, 250_000, 1_000_000,
] as const

/**
 * What `/metrics` reports about replication, gathered by the caller from whichever half of it
 * this node runs. Absent on a standalone node, which is why the four series are omitted rather
 * than exported as zeroes: a zero lag on a node with no replicas is a lie a dashboard will alert
 * on sooner or later.
 */
export interface ReplicationMetrics {
  /** Replica sockets attached (primary) or 1/0 for the upstream socket (replica). */
  connected: number
  /** Largest per-stream lag in transactions. */
  lagTxid: number
  bytes: number
  records: number
}

/**
 * What `/metrics` reports about the S3 shipper. Absent on a node with no bucket, for the same
 * reason the replication block is: a zero shipped txid on a node that ships nothing is a lie a
 * dashboard will alert on. `shippedTxid` is the highest across databases and `pendingRecords` the
 * sum, because this file is per process and never per database.
 */
export interface StorageMetrics {
  shippedTxid: number
  pendingRecords: number
  errors: number
  bytes: number
  /** Databases whose bucket is behind their tenant right now. The one to alert on. */
  behind: number
  /** L6: S3 uploads in flight, and shippers queued for a permit. */
  uploadInflight: number
  uploadWaiting: number
}

export interface MetricsSnapshot {
  requests: number
  requestsByClass: Record<string, number>
  queries: number
  writes: number
  batches: number
  transactions: number
  vmSteps: number
  errors: number
  wsConnections: number
  wsMessages: number
  sseStreams: number
  liveSubscriptions: number
  changeSubscriptions: number
  droppedLiveResults: number
  /** Writes this node handed to its primary (R2 forwarding). */
  forwarded: number
  /** Writes answered `ACK_TIMEOUT` after committing locally. */
  ackTimeouts: number
  /** Interactive transactions that had to wait for the writer before they could begin. */
  txQueued: number
  /** Largest result footprint any statement has accounted for, in bytes. */
  resultBytesMax: number
  /** Writes refused `WRITE_QUEUE_FULL` or `WRITE_QUEUE_TIMEOUT` (L2). */
  writeQueueRejected: number
  openTenants: number
  tenants: number
  evictions: number
  uptimeMs: number
}

/** `Metrics` as flat, clonable data — what crosses the worker channel. See `Metrics.state`. */
export interface MetricsState {
  requests: number
  byClass: [string, number][]
  buckets: number[]
  sumUs: number
  queries: number
  writes: number
  batches: number
  transactions: number
  vmSteps: number
  forwarded: number
  ackTimeouts: number
  txQueued: number
  resultBytesMax: number
  writeQueueRejected: number
  errors: number
  wsConnections: number
  wsOpen: number
  wsMessages: number
  sseOpen: number
  sseTotal: number
  liveSubs: number
  changeSubs: number
  droppedLive: number
}

export class Metrics {
  readonly startedAt = Date.now()

  #requests = 0
  #byClass = new Map<string, number>()
  #buckets = new Uint32Array(LATENCY_BUCKETS.length + 1)
  #sumUs = 0
  #queries = 0
  #writes = 0
  #batches = 0
  #transactions = 0
  #vmSteps = 0
  #forwarded = 0
  #ackTimeouts = 0
  #txQueued = 0
  #resultBytesMax = 0
  #writeQueueRejected = 0
  #errors = 0
  #wsConnections = 0
  #wsOpen = 0
  #wsMessages = 0
  #sseOpen = 0
  #sseTotal = 0
  #liveSubs = 0
  #changeSubs = 0
  #droppedLive = 0

  /**
   * Every counter, flat, so one process's numbers can cross a thread and be added to another's
   * (`docs/c4-workers.md`: a node with `workers: N` serves `/metrics` from the router, which owns
   * none of the requests). Gauges are summed too — open sockets and subscriptions really are the
   * sum over the workers holding them — and `startedAt` is not carried, because uptime is the
   * router's.
   */
  state(): MetricsState {
    return {
      requests: this.#requests,
      byClass: [...this.#byClass],
      buckets: [...this.#buckets],
      sumUs: this.#sumUs,
      queries: this.#queries,
      writes: this.#writes,
      batches: this.#batches,
      transactions: this.#transactions,
      vmSteps: this.#vmSteps,
      forwarded: this.#forwarded,
      ackTimeouts: this.#ackTimeouts,
      txQueued: this.#txQueued,
      resultBytesMax: this.#resultBytesMax,
      writeQueueRejected: this.#writeQueueRejected,
      errors: this.#errors,
      wsConnections: this.#wsConnections,
      wsOpen: this.#wsOpen,
      wsMessages: this.#wsMessages,
      sseOpen: this.#sseOpen,
      sseTotal: this.#sseTotal,
      liveSubs: this.#liveSubs,
      changeSubs: this.#changeSubs,
      droppedLive: this.#droppedLive,
    }
  }

  /** Adds another process's counters to these. */
  absorb(state: MetricsState): void {
    this.#requests += state.requests
    for (const [klass, count] of state.byClass) {
      this.#byClass.set(klass, (this.#byClass.get(klass) ?? 0) + count)
    }
    for (let i = 0; i < this.#buckets.length; i++) {
      this.#buckets[i] = (this.#buckets[i] as number) + (state.buckets[i] ?? 0)
    }
    this.#sumUs += state.sumUs
    this.#queries += state.queries
    this.#writes += state.writes
    this.#batches += state.batches
    this.#transactions += state.transactions
    this.#vmSteps += state.vmSteps
    this.#forwarded += state.forwarded
    this.#ackTimeouts += state.ackTimeouts
    this.#txQueued += state.txQueued
    // A high-water mark, so the merge across disjoint shards is a max rather than a sum: the
    // largest result any worker built is the largest result this node built.
    if (state.resultBytesMax > this.#resultBytesMax) this.#resultBytesMax = state.resultBytesMax
    this.#writeQueueRejected += state.writeQueueRejected
    this.#errors += state.errors
    this.#wsConnections += state.wsConnections
    this.#wsOpen += state.wsOpen
    this.#wsMessages += state.wsMessages
    this.#sseOpen += state.sseOpen
    this.#sseTotal += state.sseTotal
    this.#liveSubs += state.liveSubs
    this.#changeSubs += state.changeSubs
    this.#droppedLive += state.droppedLive
  }

  /** One finished HTTP request: its status class and how long it took. */
  request(status: number, durationUs: number): void {
    this.#requests++
    const klass = `${Math.floor(status / 100)}xx`
    this.#byClass.set(klass, (this.#byClass.get(klass) ?? 0) + 1)
    if (status >= 500) this.#errors++
    this.#sumUs += durationUs
    let i = 0
    while (i < LATENCY_BUCKETS.length && durationUs > (LATENCY_BUCKETS[i] as number)) i++
    this.#buckets[i] = (this.#buckets[i] as number) + 1
  }

  statement(kind: "read" | "write", vmSteps: number, resultBytes = 0): void {
    if (kind === "write") this.#writes++
    else this.#queries++
    this.#vmSteps += vmSteps
    if (resultBytes > this.#resultBytesMax) this.#resultBytesMax = resultBytes
  }

  batch(): void {
    this.#batches++
  }

  transaction(): void {
    this.#transactions++
  }

  wsOpened(): void {
    this.#wsConnections++
    this.#wsOpen++
  }

  wsClosed(): void {
    this.#wsOpen--
  }

  wsMessage(): void {
    this.#wsMessages++
  }

  sseOpened(): void {
    this.#sseOpen++
    this.#sseTotal++
  }

  sseClosed(): void {
    this.#sseOpen--
  }

  subscribed(kind: "changes" | "live"): void {
    if (kind === "live") this.#liveSubs++
    else this.#changeSubs++
  }

  unsubscribed(kind: "changes" | "live"): void {
    if (kind === "live") this.#liveSubs--
    else this.#changeSubs--
  }

  droppedLiveResult(): void {
    this.#droppedLive++
  }

  /** A write this replica handed to the primary. */
  forwarded(): void {
    this.#forwarded++
  }

  /** A write that committed locally and then ran out of patience waiting for replica acks. */
  ackTimeout(): void {
    this.#ackTimeouts++
  }

  /** An interactive transaction that found the writer busy and waited instead of failing. */
  txQueued(): void {
    this.#txQueued++
  }

  /** A write the tenant's admission control refused, full or timed out (L2). */
  writeQueueRejected(): void {
    this.#writeQueueRejected++
  }

  snapshot(registry: {
    open: number
    tenants: number
    evictions: number
    writeQueueDepth?: number
  }): MetricsSnapshot {
    return {
      requests: this.#requests,
      requestsByClass: Object.fromEntries(this.#byClass),
      queries: this.#queries,
      writes: this.#writes,
      batches: this.#batches,
      transactions: this.#transactions,
      vmSteps: this.#vmSteps,
      errors: this.#errors,
      wsConnections: this.#wsOpen,
      wsMessages: this.#wsMessages,
      sseStreams: this.#sseOpen,
      liveSubscriptions: this.#liveSubs,
      changeSubscriptions: this.#changeSubs,
      droppedLiveResults: this.#droppedLive,
      forwarded: this.#forwarded,
      ackTimeouts: this.#ackTimeouts,
      txQueued: this.#txQueued,
      resultBytesMax: this.#resultBytesMax,
      writeQueueRejected: this.#writeQueueRejected,
      openTenants: registry.open,
      tenants: registry.tenants,
      evictions: registry.evictions,
      uptimeMs: Date.now() - this.startedAt,
    }
  }

  /** Prometheus text exposition format, version 0.0.4. */
  render(
    registry: {
      open: number
      maxOpen?: number
      tenants: number
      evictions: number
      writeQueueDepth?: number
      pinned?: number
      openRefused?: number
      fsync?: { total: number; lastDurationUs: number; pending: number; deferred: number } | null
      statementCache?: { hits: number; misses: number; evictions: number }
    },
    node: string,
    replication?: ReplicationMetrics | null,
    storage?: StorageMetrics | null,
  ): string {
    const labels = `node="${node.replaceAll('"', "")}"`
    const out: string[] = []
    const counter = (name: string, help: string, value: number, extra = ""): void => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`)
      out.push(`${name}{${labels}${extra}} ${value}`)
    }
    const gauge = (name: string, help: string, value: number): void => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
      out.push(`${name}{${labels}} ${value}`)
    }

    out.push(
      "# HELP bql_requests_total HTTP requests answered, by status class.",
      "# TYPE bql_requests_total counter",
    )
    for (const klass of ["2xx", "3xx", "4xx", "5xx"]) {
      out.push(`bql_requests_total{${labels},status="${klass}"} ${this.#byClass.get(klass) ?? 0}`)
    }

    out.push(
      "# HELP bql_request_duration_us Request latency in microseconds.",
      "# TYPE bql_request_duration_us histogram",
    )
    let cumulative = 0
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      cumulative += this.#buckets[i] as number
      out.push(
        `bql_request_duration_us_bucket{${labels},le="${LATENCY_BUCKETS[i]}"} ${cumulative}`,
      )
    }
    cumulative += this.#buckets[LATENCY_BUCKETS.length] as number
    out.push(`bql_request_duration_us_bucket{${labels},le="+Inf"} ${cumulative}`)
    out.push(`bql_request_duration_us_sum{${labels}} ${this.#sumUs}`)
    out.push(`bql_request_duration_us_count{${labels}} ${this.#requests}`)

    counter("bql_queries_total", "Read statements executed.", this.#queries)
    counter("bql_writes_total", "Write statements executed.", this.#writes)
    counter("bql_batches_total", "Batch requests executed.", this.#batches)
    counter("bql_transactions_total", "Interactive transactions begun.", this.#transactions)
    counter("bql_vm_steps_total", "SQLite virtual-machine steps, the cost unit.", this.#vmSteps)
    counter("bql_errors_total", "Requests answered with a 5xx.", this.#errors)
    counter("bql_ws_connections_total", "WebSocket connections accepted.", this.#wsConnections)
    counter("bql_ws_messages_total", "WebSocket client messages handled.", this.#wsMessages)
    counter("bql_sse_streams_total", "SSE streams opened.", this.#sseTotal)
    counter(
      "bql_live_results_dropped_total",
      "Live-query results dropped under socket backpressure.",
      this.#droppedLive,
    )
    counter(
      "bql_forwarded_writes_total",
      "Writes this replica handed to its primary.",
      this.#forwarded,
    )
    counter(
      "bql_ack_timeouts_total",
      "Writes committed locally that ran out of patience waiting for replica acks.",
      this.#ackTimeouts,
    )
    counter(
      "bql_tx_queued_total",
      "Interactive transactions that waited for the writer instead of failing TX_BUSY.",
      this.#txQueued,
    )
    counter("bql_tenant_evictions_total", "Tenants closed by the LRU.", registry.evictions)
    if (registry.fsync) {
      counter(
        "bql_fsync_total",
        "Barriers the shared fsync sweep has issued ([durability] fsyncSweep = \"shared\").",
        registry.fsync.total,
      )
      gauge(
        "bql_fsync_sweep_duration_us",
        "How long the sweep's last pass took, in microseconds.",
        registry.fsync.lastDurationUs,
      )
      gauge(
        "bql_fsync_pending",
        "Logs with bytes the disk has not been told about, waiting for the next sweep.",
        registry.fsync.pending,
      )
    }
    if (registry.statementCache) {
      // P7. Per connection, summed over every connection this node has opened — a tenant holds one
      // writer and `[data] readers` pooled readers, each with its own cache of `[sqlite]
      // statementCache` entries. A *rising* eviction rate is the thrash: past the ceiling every
      // prepare compiles and finalizes a victim instead of returning a cached statement.
      counter(
        "bql_statement_cache_hits_total",
        "prepare() calls answered from a connection's statement cache.",
        registry.statementCache.hits,
      )
      counter(
        "bql_statement_cache_misses_total",
        "prepare() calls that compiled, because the text was not cached.",
        registry.statementCache.misses,
      )
      counter(
        "bql_statement_cache_evictions_total",
        "Statements finalized to stay within [sqlite] statementCache. Rising means thrashing.",
        registry.statementCache.evictions,
      )
    }
    counter(
      "bql_open_refused_total",
      "Opens refused because every open database was pinned by a subscription.",
      registry.openRefused ?? 0,
    )
    counter(
      "bql_write_queue_rejected_total",
      "Writes refused admission to a database's write queue, full or timed out.",
      this.#writeQueueRejected,
    )

    gauge(
      "bql_result_bytes_max",
      "Largest result footprint any statement has built, against [limits] maxResultBytes.",
      this.#resultBytesMax,
    )
    gauge(
      "bql_write_queue_depth",
      "Writes queued for a writer across every open database.",
      registry.writeQueueDepth ?? 0,
    )
    gauge("bql_open_tenants", "Databases currently open.", registry.open)
    gauge(
      "bql_tenants_pinned",
      "Open databases a subscription or transaction is holding out of the LRU.",
      registry.pinned ?? 0,
    )
    if (registry.maxOpen !== undefined) {
      gauge(
        "bql_max_open_tenants",
        "[data] maxOpen: the node's ceiling on open databases, across every shard.",
        registry.maxOpen,
      )
    }
    gauge("bql_tenants", "Databases in the catalog.", registry.tenants)
    gauge("bql_ws_connections", "WebSocket connections open.", this.#wsOpen)
    gauge("bql_sse_streams", "SSE streams open.", this.#sseOpen)
    gauge("bql_live_subscriptions", "Live queries subscribed.", this.#liveSubs)
    gauge("bql_change_subscriptions", "Change feeds subscribed.", this.#changeSubs)
    gauge("bql_uptime_seconds", "Seconds since start.", (Date.now() - this.startedAt) / 1000)

    if (replication) {
      gauge(
        "bql_replication_lag_txid",
        "Largest number of transactions any replica stream is behind by.",
        replication.lagTxid,
      )
      gauge(
        "bql_replication_connected",
        "Replica sockets attached on a primary, or 1 while a replica is following its primary.",
        replication.connected,
      )
      counter(
        "bql_replication_bytes_total",
        "Replication bytes sent (primary) or received (replica).",
        replication.bytes,
      )
      counter(
        "bql_replication_records_total",
        "Transaction records streamed (primary) or applied (replica).",
        replication.records,
      )
    }

    if (storage) {
      gauge(
        "bql_s3_shipped_txid",
        "Highest txid any database has shipped to the bucket.",
        storage.shippedTxid,
      )
      gauge(
        "bql_s3_pending_records",
        "Committed transactions not yet in the bucket, across every database.",
        storage.pendingRecords,
      )
      gauge(
        "bql_s3_behind",
        "Databases whose bucket is behind their local log right now.",
        storage.behind,
      )
      counter(
        "bql_s3_errors_total",
        "Failed bucket operations. A climbing count with a flat shipped txid is an outage.",
        storage.errors,
      )
      counter("bql_s3_bytes_total", "Bytes uploaded to the bucket.", storage.bytes)
      gauge(
        "bql_upload_inflight",
        "S3 uploads in flight across every shipper on this node.",
        storage.uploadInflight,
      )
      gauge(
        "bql_upload_waiting",
        "Shippers queued for an upload permit. Non-zero under load is the budget doing its job.",
        storage.uploadWaiting,
      )
    }

    return `${out.join("\n")}\n`
  }
}
