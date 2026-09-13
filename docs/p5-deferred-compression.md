# P5 — deferred compression, designed

`docs/performance.md` §4C: zstd is **9.5 µs of a 28.4 µs write**, the largest single line item left
on the write path, and `[durability] compress = false` already offers the crude version of the
trade — 28% off a write for 4.4x the bytes. The better version §4C asks for is to keep the ratio
*and* move the cost: compress **after** the client is answered.

Written 2026-09-12, **before any code and without any**. This document is the decision; §6 says
plainly what is not built and why that was the right call for one session.

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

`#deferAppend` is `[durability] deferCompress` (or the truer name `deferAppend`), default **off**
until the measurement in §5 is taken on a real node.

## 5. What has to be measured before it ships

1. **The win.** `bench/tenant.ts` write p50, deferral on and off. The prediction is 28.4 µs → ~19 µs,
   the same figure `compress = false` already reaches, but **keeping the 4.3x ratio**.
2. **The throughput.** Deferral moves work into the same event loop, so a saturated writer does the
   same total work with more scheduling. Group commit (§4B) already folds under load; the two
   interact and the ladder has to be run with both.
3. **Crash recovery, by killing a node mid-write.** `kill -9` under load, reopen, and assert the log
   and the WAL agree and a replica converges on the primary's checksum. That is the test that
   matters, and it is the one `docs/c5-apply-pages.md` ran by hand for the same class of change.

## 6. Not built, and why

This is a change to when a durable record is written, in a file whose header begins *"a record is
acked only after it is applied and the position is persisted"*. It has four readers to move, a
recovery path to re-argue, and a crash test that has to be run by hand on a real node. It is one
milestone's work and it deserves a session, not the end of one.

What this document buys the next session: the split is decided (§2), the recovery argument is made
and rests on something already built rather than something new (§2, the reconcile), the four
readers are enumerated with what each needs (§3), the shape is written (§4), and the three
measurements that decide whether it ships are named (§5).
