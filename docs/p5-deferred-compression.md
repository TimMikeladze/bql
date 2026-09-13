# P5 — deferred compression, designed

`docs/performance.md` §4C: zstd is **9.5 µs of a 28.4 µs write**, the largest single line item left
on the write path, and `[durability] compress = false` already offers the crude version of the
trade — 28% off a write for 4.4x the bytes. The better version §4C asks for is to keep the ratio
*and* move the cost: compress **after** the client is answered.

Written 2026-09-12 before any code, and **built the same day** — §7 is what it measured and what
building it found.

## 1. What is actually on the path

`Tenant.write` is the whole of it:

```ts
result = this.writer.transaction(fn, "immediate")(this.writer)   // SQLite commits here
const txid = this.#capture()                                     // ← the client waits for this
if (acksLocallyDurable(ack)) this.#syncDurable()
```

and `#capture` is:

```ts
const records = recorder.poll()          // 2.4 µs — reads the WAL frames this commit wrote
for (const record of records) {
  const bytes = this.log.append(record)  // encode + zstd (9.5 µs) + write
}
this.#savePosition(Date.now())           // throttled; the catalog copy
for (const event of events) this.#publish(event)  // change feed, live queries, replication
```

**The data is already durable before any of this runs.** SQLite committed on the line above;
`ack: "local"` promises survival of a process crash and `synchronous = NORMAL` has delivered that
by the time `#capture` starts. Everything in `#capture` exists to serve *other* readers — replicas,
the bucket, PITR, the change feed — and none of them is the client being answered.

So the win is not "compress later". It is **"answer the client before the log append", of which
compression is 80%**.

## 2. The decision: defer the append, and let the WAL be the recovery source

`#capture` splits in two:

- **Now**: `recorder.poll()`, which yields the records *with their txids and checksums already
  computed* — that is what the client is told, and it costs 2.4 µs.
- **Deferred**: `encode` (with zstd), `log.append`, `#savePosition`, `#publish`.

A crash in the window loses log records for transactions the client was told had committed. That is
**recoverable and already implemented**: the reconcile on reopen re-polls the WAL from the saved
position, which is exactly the path an unclean shutdown takes today (`clean` in the catalog row).
The frames are in SQLite's WAL; the log record is derived from them; deriving it again is what
reconcile does.

**This is why the WAL tailer's design pays off here.** A log record is not authored by the write
path — it is *read off* the WAL. Anything derived can be re-derived, and that is what makes
deferring it safe in a way that deferring an authored value would not be.

### 2.1 `ack: "local"` only

`ack: "replica"` and `ack: "quorum"` wait for a replica to have the record, which needs it encoded
and shipped. They are already slower than the deferral saves, and deferring for them would mean
scheduling work the caller is about to block on. `ack: "fsync"` is orthogonal — it is
`#syncDurable`, about SQLite's WAL, and does not touch the log.

### 2.2 The catalog position must never lead the log

`#savePosition`'s own docstring is the constraint:

> the reconcile takes the position from the log's last record, which is always at least as new as
> the catalog's

A catalog position **ahead** of the log makes the reconcile skip records that were never written.
So `#savePosition` moves into the deferred half, after the append, and keeps the invariant it
already relies on rather than being given a new one.

## 3. The four synchronous readers, and what each needs

These are the reason this is a milestone and not a patch.

| reader | reads | what deferral does to it |
|---|---|---|
| the change feed and live queries | `#publish(event)`, which carries `bytes` | Subscribers see an event one microtask later. Acceptable — they are asynchronous consumers already — **provided order is preserved**, which is design §7's rule and which a single FIFO queue gives. |
| the replication stream | `tenant.onCommit` → the encoded record | Same: a replica sees the record a microtask later, and replication is asynchronous by construction. |
| `#savePosition` | the log's last record | Moves with the append (§2.2). |
| `drain()`, `snapshot()`, `close()`, `log.iterate` | the log **as a file** | Must **flush the pending queue first**. This is the one place a missed call is a real bug: a snapshot taken with appends outstanding would be a snapshot the log does not explain. |

`tenant.txid` is deliberately not in that table: it comes from `recorder.position`, which `poll()`
has already advanced, so it is correct in the synchronous half and the client is told the truth.

## 4. The shape

```ts
/** Records polled but not yet filed. Drained in order, in a microtask, never reordered. */
#pending: TxnRecord[] = []

#capture(): bigint {
  const records = this.recorder.poll()
  if (records.length === 0) return this.recorder.position.txid
  if (this.#deferAppend) {
    this.#pending.push(...records)
    this.#scheduleFlush()
    return this.recorder.position.txid      // the client is answered from here
  }
  this.#file(records)                       // today's path, unchanged
  return this.recorder.position.txid
}

/** Everything outstanding, filed now. Called before a snapshot, a drain, a close, or any read
 *  of the log as a file — and by the microtask. */
flushPending(): void
```

`#deferAppend` is `[durability] deferAppend`, default **off**.

## 5. What has to be measured before it ships

1. **The win.** `bench/tenant.ts` write p50, deferral on and off. The prediction is 28.4 µs → ~19 µs,
   the same figure `compress = false` already reaches, but **keeping the 4.3x ratio**.
2. **The throughput.** Deferral moves work into the same event loop, so a saturated writer does the
   same total work with more scheduling. Group commit (§4B) already folds under load; the two
   interact and the ladder has to be run with both.
3. **Crash recovery, by killing a node mid-write.** `kill -9` under load, reopen, and assert the log
   and the WAL agree and a replica converges on the primary's checksum. That is the test that
   matters, and it is the one `docs/c5-apply-pages.md` ran by hand for the same class of change.

## 6. What it cost to build

`Tenant` gained `#pending`, `#file`, `#scheduleFile` and a public `flushPending`; `#capture` took
an `ack`. The four readers of §3 flush first: `snapshot()`, `close()`, `drain()`, and
`ReplicationServer`'s three catch-up reads of the log as a file. `[durability] deferAppend` threads
through the registry the way `compress` already does.

## 7. As built — the measurements, and the bug the ordering test found

`bun test` → **1460 pass, 2 skip, 0 fail**, and **the same 1460 with `deferAppend` forced on for
the whole suite** — replication, PITR, the cluster and the e2e scenarios included. `bun run
typecheck`, `bun run bytes` and `bun run routes:check` clean.

**§5.1's prediction was beaten.** 4000 single-row transactions through the real tenant write path,
alternating so neither arrangement gets an unfair cache:

| | write p50 | p90 | bytes/record |
|---|---|---|---|
| compress, append now (today) | 21.1–22.0 µs | 25.3–27.8 | 1032 |
| **compress, append deferred (P5)** | **8.7–9.5 µs** | **10.7–12.8** | **1032** |
| no compress, append now (§4C's trade) | 14.1–14.7 µs | 17.2–18.0 | 4231 |

**A write is 2.4x faster and the 4.3x ratio is kept.** It also beats `compress = false` on *both*
axes — faster than the uncompressed path and a quarter of the bytes — which retires §4C's trade
rather than tuning it. The prediction was ~19 µs; the deferral is worth more than the zstd in it,
because the whole append goes rather than the compression alone.

**The crash test passes, and it is the one that matters.** A writer process with the deferral on,
`kill -9`'d mid-write and reopened: the rows in the database, the tenant's txid and the log's last
txid all agree, and the log replays to exactly that txid. In one run 132 916 transactions came back
consistent. The reconcile re-derived the outstanding records from the WAL, which is what §2 said it
would and the reason this is safe at all.

**The bug the tests found: nothing may jump the queue.** A write that is *not* deferred —
`ack: "replica"`, or the flag off — filed its records immediately while earlier deferred ones were
still outstanding, so the log was handed txid 2 while txid 1 was pending and refused it, correctly
and loudly. Every direct path now flushes first. It is the obvious failure in hindsight and it is
exactly what a queue with two producers does when one of them is allowed to skip.
