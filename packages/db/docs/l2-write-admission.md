# L2 — write admission is bounded

`docs/plan-limits.md` L2. Three ceilings on one queue, a refusal that carries a real retry hint,
and one performance finding that changed the design.

## 1. The bug

`Tenant.writeQueued` pushed onto `#queue` with no ceiling at all. `maxGroupCommit` bounds a
*drain* — how many statements one transaction folds — and never bounded the backlog. So a tenant
whose disk had stalled, or one simply fed faster than it commits, accumulated pending promises
until the heap ended; and each caller waited however long that took, holding a connection while it
waited, learning nothing.

## 2. What it is now

Three bounds and a cancellation, all on `Tenant`:

| bound | config | refusal |
|---|---|---|
| entries queued | `[limits] maxQueuedWrites` (256) | `503 WRITE_QUEUE_FULL` + `Retry-After` |
| bytes those entries hold | `[limits] maxQueuedWriteBytes` (8 MiB) | the same |
| how long one may wait | `[limits] queueWaitMs` (5000) | `503 WRITE_QUEUE_TIMEOUT` |

Both refusals mean *the write never started*, which is the useful half: a client may retry either
without wondering whether it committed. `Retry-After` is `queueDepth × msPerWrite`, where
`msPerWrite` is an exponential moving average of the drains this database has actually performed —
a constant would name a time with nothing to do with how fast this tenant is committing. It rides
in the body as `retryAfterSec` too, because a WebSocket client has no headers.

**Bytes are the caller's number.** The queue holds a closure and cannot weigh it, so `exec.ts`
passes `requestWeight(request)` — the SQL plus one pass over the bound arguments, never a
`JSON.stringify`. An entry heavier than the whole byte budget is admitted when the queue is
**empty**: refusing it would make it unserveable at every moment rather than at a busy one, and
`[limits] maxBodyBytes` is what bounds it there.

**Cancellation** is the request's own `AbortSignal`. A client that disconnects while its write is
queued has the entry dropped, its promise rejected and its bytes returned before the writer sees
it. A write that has already reached the writer is not cancellable and still commits — the same
"may or may not have committed" a dropped socket has always meant.

## 3. Deviations from the plan

- **The plan says the refusal carries `Retry-After` "derived from the current drain rate".** It
  does, and the rate is an EWMA at a quarter weight rather than the last drain: fast enough to
  follow a disk that has just stalled, slow enough that one unlucky transaction does not tell every
  client to wait a minute. Clamped to [1, 60] seconds.
- **The deadline is enforced in two places, not one.** A timer covers the queue that is not
  draining at all; the drain itself also refuses an entry already past its deadline, so a queue that
  *is* draining — just not fast enough — refuses a stale write rather than committing it late.
- **An abandoned write is rejected `BAD_REQUEST`, not a new code.** There is no 499 in the
  vocabulary and nobody is listening for the answer by definition. What matters is that the entry
  is off the queue and its bytes are back.

## 4. The finding: waiting costs money, so only entries that wait pay it

The first working version armed the deadline and subscribed to the abort signal **at push**, which
is the obvious place. Measured against the same tree without L2, in process, 64 concurrent writers
folded into one transaction each turn:

| | 1 client | 8 clients | 64 clients |
|---|---|---|---|
| arm everything at push | 0.99 | 0.98 | **0.94** |
| arm only what waits | 1.00 | 0.99 | **0.97** |

The cause, microbenchmarked directly on this machine:

```
request.signal access:     3.6 ns/op
add+removeEventListener: 137.1 ns/op
Date.now():               22.5 ns/op
```

160 ns per write, against a per-statement cost of about 850 ns when sixty-four of them fold into
one transaction. So the machinery of *waiting* was costing a fifth of the machinery of *writing*,
for writes that never waited.

The fix is a rule rather than a micro-optimisation: **an entry that cannot be in the next batch is
the only one that is going to wait.**

```ts
const willWait = this.#queue.length >= this.maxGroupCommit
```

Past a full fold, an entry stamps its deadline, subscribes to its caller's signal, and arms the
timer. Below it — a burst of sixty-four concurrent writes against a `maxGroupCommit` of
sixty-four, which is the case group commit exists for — it does none of those things, because an
entry drained on the next event-loop turn can neither outlive its caller nor wait `queueWaitMs`.
The two paths a queue genuinely backs up on — a drain that leaves work behind, and a writer that is
not moving — arm the whole queue on the way past, so nothing that waits goes unwatched. The
deadline then runs from when the entry was *found* to be waiting rather than from when it was
queued; the two differ by at most one event-loop turn.

The byte account follows the same rule: the drain rebuilds `#queuedBytes` from what is left rather
than subtracting per entry, which in the case that matters is one assignment instead of sixty-four
subtractions.

## 5. What it cost, honestly

**In process, 64 statements per fold: 0.971 (2.9% slower), six interleaved pairs of 1.5M writes
each** — paired ratios 0.960, 0.967, 0.983, 0.975, 0.964, 0.994. That is about **25 ns per folded
statement**, which is what a bounded queue with a deadline and a cancellation hook costs when the
statement itself costs 850 ns.

At one and eight clients it is inside the noise (1.00 and 0.99 medians).

**The HTTP leg could not be resolved on this machine and is not reported.** `docs/performance.md`
§8's conditions were not met at any point during this work: load average ran between 5 and 11, with
`mobileassetd` at 116% and `modelcatalogd` at 72% of a core throughout, and successive runs of the
*same* tree returned 6300 and 2700 writes/s minutes apart. What can be said from arithmetic rather
than from measurement: 25 ns against a 37 µs HTTP write is 0.07%, and the in-process figure is the
worst case precisely because it has no transport in it.

## 6. Done when — against the plan's criteria

| criterion | result |
|---|---|
| a tenant fed faster than it commits refuses with `WRITE_QUEUE_FULL` at a steady queue depth instead of growing | **yes.** `test/tenant/write-admission.test.ts`: sixty writes issued in one turn against a queue of four — four accepted, fifty-six refused, peak depth four, and the four that were accepted are the four rows in the table. Over the wire in `test/server/write-admission.test.ts`, with `Retry-After` on the header and `retryAfterSec` in the body |
| a client that disconnects mid-queue has its entry dropped before the writer sees it | **yes.** The test asserts the statement's closure never ran, not merely that the promise rejected |
| the group-commit benchmark is unchanged | **2.9% slower in process at 64 statements per fold; unchanged at 1 and 8.** Not "unchanged", and reported rather than rounded away. §4 and §5 above |

## 7. What it touched

`src/tenant/tenant.ts` (the ceilings, `#beginWait`/`#beginWaitAll`, the queue timer, `#finish`,
the drain's one-pass batch build and bulk byte account, `QueuedWriteOptions`, `TenantStats`),
`src/tenant/registry.ts` (the options, `RegistryStats.writeQueueDepth`), `src/server/config.ts`
(the three `[limits]` keys), `src/server/errors.ts` (`WRITE_QUEUE_FULL`, `WRITE_QUEUE_TIMEOUT`,
`ErrorDetails.retryAfterSec` and the `Retry-After` header), `src/server/exec.ts` (`requestWeight`,
the signal, the rejection counter), `src/server/routes.ts` (`ctx.request.signal`),
`src/server/metrics.ts` (`bunql_write_queue_depth`, `bunql_write_queue_rejected_total`),
`src/server/workers/{protocol,pool,entry}.ts` (the depth sums across shards — disjoint, so it sums
like any other), `src/server/registry.ts`, `src/dataapi/operations.ts`, `src/client/protocol.ts`,
`docs/api.md`, `docs/design.md` §4.7 and §6.6.
