// Invariant: at most `permits` S3 uploads are in flight from this thread at once, whatever the
// number of shipping databases. A permit is held around the request and nothing else — a shipper
// that is encoding, reading its log or waiting on a timer holds none — so the ceiling bounds
// sockets and bucket rate limits rather than serialising the pool.
//
// Why it exists (L6, `docs/l6-upload-budget.md`). `ShipperPool.attach` creates one `Shipper` per
// open database, each with its own drain timer, and nothing capped how many were uploading
// together. A thousand shipping databases were a thousand upload chains competing for one thread's
// sockets and for the bucket's own limits, and the first thing that gives way is the furthest
// behind database, which retries into the same crowd.
//
// The queue is ordered by **how far behind the caller is**, not by arrival. A database that has
// been waiting to ship since before a busy neighbour's last ten drains goes first, which is what
// stops a steady writer starving a stalled one. Ties break by arrival, so equal priorities are
// FIFO and nothing can be indefinitely overtaken by its own equals.

/** Raised when a caller's patience ran out before a permit came free. */
export class UploadBudgetTimeout extends Error {
  constructor(waitedMs: number) {
    super(`no upload permit within ${waitedMs}ms`)
    this.name = "UploadBudgetTimeout"
  }
}

interface Waiter {
  priority: number
  seq: number
  resolve: () => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

export class UploadBudget {
  readonly permits: number

  #inflight = 0
  #queue: Waiter[] = []
  #seq = 0
  #granted = 0
  #timedOut = 0

  constructor(permits: number) {
    this.permits = Math.max(1, permits)
  }

  /** Requests in flight right now. `bunql_upload_inflight`. */
  get inflight(): number {
    return this.#inflight
  }

  /** Callers queued for a permit. `bunql_upload_waiting`. */
  get waiting(): number {
    return this.#queue.length
  }

  /** Permits handed out, and requests that gave up waiting for one. */
  get granted(): number {
    return this.#granted
  }

  get timedOut(): number {
    return this.#timedOut
  }

  /**
   * Runs `fn` holding a permit.
   *
   * `priority` is the caller's oldest unshipped position — a txid, or 0 for work that is not
   * behind anything. Lower goes first, so the furthest-behind database is served before a
   * neighbour that is merely busy.
   *
   * `timeoutMs` bounds the wait, not the request: once a permit is granted the request runs to
   * completion. A caller that times out is expected to re-arm its own timer rather than queue
   * again immediately, which is what keeps a saturated budget from growing a second queue behind
   * the first.
   */
  async run<T>(priority: number, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await this.#acquire(priority, timeoutMs)
    try {
      return await fn()
    } finally {
      this.#release()
    }
  }

  #acquire(priority: number, timeoutMs: number): Promise<void> {
    if (this.#inflight < this.permits && this.#queue.length === 0) {
      this.#inflight++
      this.#granted++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { priority, seq: this.#seq++, resolve, reject, timer: null }
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        const timer = setTimeout(() => {
          const at = this.#queue.indexOf(waiter)
          if (at >= 0) this.#queue.splice(at, 1)
          this.#timedOut++
          reject(new UploadBudgetTimeout(timeoutMs))
        }, timeoutMs)
        timer.unref?.()
        waiter.timer = timer
      }
      this.#queue.push(waiter)
    })
  }

  #release(): void {
    this.#inflight--
    // Linear over the queue rather than a heap: it is bounded by the shipping databases on one
    // thread and it runs once per completed upload, which is a network round trip away.
    let best = -1
    for (let i = 0; i < this.#queue.length; i++) {
      const one = this.#queue[i] as Waiter
      const chosen = this.#queue[best] as Waiter | undefined
      if (
        chosen === undefined ||
        one.priority < chosen.priority ||
        (one.priority === chosen.priority && one.seq < chosen.seq)
      ) {
        best = i
      }
    }
    if (best < 0) return
    const waiter = this.#queue.splice(best, 1)[0] as Waiter
    if (waiter.timer !== null) clearTimeout(waiter.timer)
    this.#inflight++
    this.#granted++
    waiter.resolve()
  }
}
