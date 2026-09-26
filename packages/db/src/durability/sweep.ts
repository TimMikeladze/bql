// Invariant: nothing a client was promised is ever answered off this sweep. `ack: "fsync"` still
// fsyncs inline on the write path, synchronously, before the caller is answered — the sweep serves
// only the *interval* policy, which is durability hygiene for `ack: "local"` and has nobody
// waiting on it. So a tick that is late, or a tick that runs out of budget and defers half its
// work to the next one, delays hygiene and can never break a promise.
//
// Why it exists (L5, `docs/l5-fsync-sweep.md`). `TxnLog.#maybeFsync` fsynced inline from inside
// `appendEncoded`, at most once per `fsyncIntervalMs` per log and coordinated by nothing else. At
// 500 write-active databases on one thread that is ~5 000 barriers a second — measured, 4 392 —
// landing in whichever write happened to cross the boundary, and it took the p99 commit latency to
// 45 ms. The sweep changes two things and deliberately not a third:
//
//  - the barrier leaves the **event loop**, not just the write path. That is the load-bearing
//    half: a barrier costs the same either way, and what differs is who waits for it. A first
//    version of this swept synchronously and was *worse* than the inline behaviour it replaced,
//    because it concentrated the same blocking into a burst — 14.1 ms p99 at a hundred databases
//    against 2.9 ms inline. `fs.promises.fsync` costs about 25% more per call and costs the loop
//    nothing;
//  - one pass covers **every** log with an intent, and the next tick is skipped while a pass is
//    still running. A first version stopped each pass at a wall-clock budget and resumed on the
//    next tick, which read well and was dishonest: under load a pass got through a handful of
//    targets per interval, so 500 databases saw 29 barriers a second where the inline behaviour
//    issued 4 400. That is a weaker durability promise wearing a performance number, not a faster
//    node. The ceiling this sweep provides is *scheduling*, not fewer barriers;
//  - it issues them a **few at a time**, which is the one place this reverses the plan. On an idle
//    thread serial issuing is the fastest: 30 180 barriers a second against 14 627 at a width of
//    sixteen and 10 506 at sixty-four. But this sweep is driven by an event loop that is also
//    serving writes, so what sets a pass's duration is not the disk — it is one loop round trip
//    per `await`, and under load that is milliseconds rather than the barrier's 36 µs. Serial, a
//    pass over 500 databases took about ten seconds and the interval silently became ten seconds.
//    A width of sixteen puts the round trips in parallel while staying far under the rate the disk
//    starts losing to concurrency, which at the default interval is 5 000 barriers a second.

/** A log the sweep can fsync. `TxnLog` is the only implementation. */
export interface SweepTarget {
  /**
   * Issues a barrier for whatever is unsynced, off the event loop, and resolves to whether one was
   * issued. A rejection is swallowed by the sweep: a log that cannot be synced is that log's
   * problem to report, not a reason to stop serving every other database on the thread.
   */
  sweepFlush(): Promise<boolean>
}

export interface FsyncSweepOptions {
  /** How often a tick runs. Matches the log's `fsyncIntervalMs`, since that is what it replaces. */
  intervalMs?: number
  /**
   * Barriers in flight at once. Not a disk tuning — the disk prefers one — but a way to keep a
   * pass's duration proportional to the round rather than to the event loop's latency. See the
   * header.
   */
  concurrency?: number
  /** Injected by tests. */
  now?: () => number
}

export class FsyncSweep {
  readonly intervalMs: number
  readonly concurrency: number

  /** Registration order, which is also sweep order. */
  #targets: SweepTarget[] = []
  /** Targets with unsynced bytes, as a set so a second intent in one interval costs nothing. */
  #intents = new Set<SweepTarget>()
  #timer: ReturnType<typeof setInterval> | null = null
  /** The pass in flight, or null. One at a time, whatever the timer does. */
  #pass: Promise<void> | null = null
  #closed = false
  #now: () => number

  #fsyncs = 0
  #ticks = 0
  #lastDurationUs = 0
  #deferred = 0

  constructor(options: FsyncSweepOptions = {}) {
    this.intervalMs = Math.max(1, options.intervalMs ?? 100)
    this.concurrency = Math.max(1, options.concurrency ?? 16)
    this.#now = options.now ?? (() => performance.now())
  }

  /** Barriers this sweep has issued. `bql_fsync_total`. */
  get fsyncs(): number {
    return this.#fsyncs
  }

  /** How long the last tick took, in microseconds. `bql_fsync_sweep_duration_us`. */
  get lastDurationUs(): number {
    return this.#lastDurationUs
  }

  /**
   * Intents still outstanding when the last pass finished — logs written to *while* the pass was
   * running, which the next one picks up. Persistently non-zero means the disk is not keeping up
   * with the node's write rate, which is the thing to alert on.
   */
  get deferred(): number {
    return this.#deferred
  }

  get ticks(): number {
    return this.#ticks
  }

  /** Logs with unsynced bytes right now. */
  get pending(): number {
    return this.#intents.size
  }

  register(target: SweepTarget): void {
    if (this.#closed || this.#targets.includes(target)) return
    this.#targets.push(target)
  }

  unregister(target: SweepTarget): void {
    const at = this.#targets.indexOf(target)
    if (at >= 0) this.#targets.splice(at, 1)
    this.#intents.delete(target)
    if (this.#targets.length === 0) this.#stop()
  }

  /**
   * "This log has bytes the disk has not been told about." Cheap enough to call on every append:
   * a `Set.add` on a set that holds at most one entry per open database.
   */
  intent(target: SweepTarget): void {
    if (this.#closed) return
    this.#intents.add(target)
    this.#start()
  }

/**
   * One pass over every log with an intent outstanding, one barrier at a time, off the event loop.
   *
   * A pass that is still running when the next tick fires keeps the pass and skips the tick, so a
   * node whose disk cannot keep up sweeps continuously rather than queueing passes — the interval
   * stretches, which is visible in `lastDurationUs`, rather than the work being dropped, which
   * would not be.
   */
  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    // A pass still running when the next tick fires keeps the pass and skips the tick: one pass at
    // a time is what "a concurrency of one" means here.
    if (this.#pass !== null) return this.#pass
    this.#ticks++
    this.#pass = this.#run().finally(() => {
      this.#pass = null
    })
    return this.#pass
  }

  async #run(): Promise<void> {
    const started = this.#now()
    // The set as it stood when the pass began. An append landing mid-pass is the *next* pass's
    // work, which is what keeps one pass bounded by the number of open databases rather than by
    // how fast clients are writing.
    const round = [...this.#intents]
    for (let at = 0; at < round.length && !this.#closed; at += this.concurrency) {
      const slice: Promise<void>[] = []
      for (const target of round.slice(at, at + this.concurrency)) {
        if (!this.#intents.delete(target)) continue
        slice.push(
          target
            .sweepFlush()
            .then((issued) => {
              if (issued) this.#fsyncs++
            })
            // A log that cannot be synced is the log's problem to report; the sweep's job is to
            // keep going for every other database on the thread.
            .catch(() => {}),
        )
      }
      await Promise.all(slice)
    }
    this.#deferred = this.#intents.size
    this.#lastDurationUs = Math.round((this.#now() - started) * 1000)
    if (this.#intents.size === 0) this.#stop()
  }

  /**
   * Stops the timer and drops every intent.
   *
   * It does **not** flush them: a registry closing closes every tenant first, and `TxnLog.close`
   * flushes synchronously on its way out. Waiting here would mean a close that returns a promise,
   * for barriers that have already been issued by the time it is reached.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#stop()
    this.#intents.clear()
    this.#targets = []
  }

  /** The timer runs only while something is waiting, so an idle node has no tick at all. */
  #start(): void {
    if (this.#timer !== null || this.#closed) return
    const timer = setInterval(() => void this.tick(), this.intervalMs)
    timer.unref?.()
    this.#timer = timer
  }

  #stop(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }
}
