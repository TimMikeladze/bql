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
  openTenants: number
  tenants: number
  evictions: number
  uptimeMs: number
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
  #errors = 0
  #wsConnections = 0
  #wsOpen = 0
  #wsMessages = 0
  #sseOpen = 0
  #sseTotal = 0
  #liveSubs = 0
  #changeSubs = 0
  #droppedLive = 0

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

  statement(kind: "read" | "write", vmSteps: number): void {
    if (kind === "write") this.#writes++
    else this.#queries++
    this.#vmSteps += vmSteps
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

  snapshot(registry: { open: number; tenants: number; evictions: number }): MetricsSnapshot {
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
      openTenants: registry.open,
      tenants: registry.tenants,
      evictions: registry.evictions,
      uptimeMs: Date.now() - this.startedAt,
    }
  }

  /** Prometheus text exposition format, version 0.0.4. */
  render(registry: { open: number; tenants: number; evictions: number }, node: string): string {
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
      "# HELP bunql_requests_total HTTP requests answered, by status class.",
      "# TYPE bunql_requests_total counter",
    )
    for (const klass of ["2xx", "3xx", "4xx", "5xx"]) {
      out.push(`bunql_requests_total{${labels},status="${klass}"} ${this.#byClass.get(klass) ?? 0}`)
    }

    out.push(
      "# HELP bunql_request_duration_us Request latency in microseconds.",
      "# TYPE bunql_request_duration_us histogram",
    )
    let cumulative = 0
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      cumulative += this.#buckets[i] as number
      out.push(
        `bunql_request_duration_us_bucket{${labels},le="${LATENCY_BUCKETS[i]}"} ${cumulative}`,
      )
    }
    cumulative += this.#buckets[LATENCY_BUCKETS.length] as number
    out.push(`bunql_request_duration_us_bucket{${labels},le="+Inf"} ${cumulative}`)
    out.push(`bunql_request_duration_us_sum{${labels}} ${this.#sumUs}`)
    out.push(`bunql_request_duration_us_count{${labels}} ${this.#requests}`)

    counter("bunql_queries_total", "Read statements executed.", this.#queries)
    counter("bunql_writes_total", "Write statements executed.", this.#writes)
    counter("bunql_batches_total", "Batch requests executed.", this.#batches)
    counter("bunql_transactions_total", "Interactive transactions begun.", this.#transactions)
    counter("bunql_vm_steps_total", "SQLite virtual-machine steps, the cost unit.", this.#vmSteps)
    counter("bunql_errors_total", "Requests answered with a 5xx.", this.#errors)
    counter("bunql_ws_connections_total", "WebSocket connections accepted.", this.#wsConnections)
    counter("bunql_ws_messages_total", "WebSocket client messages handled.", this.#wsMessages)
    counter("bunql_sse_streams_total", "SSE streams opened.", this.#sseTotal)
    counter(
      "bunql_live_results_dropped_total",
      "Live-query results dropped under socket backpressure.",
      this.#droppedLive,
    )
    counter("bunql_tenant_evictions_total", "Tenants closed by the LRU.", registry.evictions)

    gauge("bunql_open_tenants", "Databases currently open.", registry.open)
    gauge("bunql_tenants", "Databases in the catalog.", registry.tenants)
    gauge("bunql_ws_connections", "WebSocket connections open.", this.#wsOpen)
    gauge("bunql_sse_streams", "SSE streams open.", this.#sseOpen)
    gauge("bunql_live_subscriptions", "Live queries subscribed.", this.#liveSubs)
    gauge("bunql_change_subscriptions", "Change feeds subscribed.", this.#changeSubs)
    gauge("bunql_uptime_seconds", "Seconds since start.", (Date.now() - this.startedAt) / 1000)

    return `${out.join("\n")}\n`
  }
}
