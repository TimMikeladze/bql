# L6 — a global upload budget

`docs/plan-limits.md` L6. The premise was partly false, in the same way R9's was, and what was left
after checking is real and smaller.

## 1. What the plan said, and what was already there

> `ShipperPool.attach` creates one `Shipper` per open tenant, each with its own drain timer, and
> nothing caps how many are in flight together.

The first half is true. The second is not: `S3Store.#run` has bounded concurrency — `[s3]
concurrency`, default 4 — and it has since R3, and one `S3Store` is shared by every shipper in a
pool. So 1024 shipping databases were never 1024 concurrent requests.

What that gate does **not** do is the part worth building:

- **It is first-come-first-served.** A database that has been behind for an hour queues behind one
  that committed a moment ago and is drained again a second later. That is the starvation the plan
  names, and the existing gate has no answer to it.
- **It has no ceiling on the wait.** A shipper waits indefinitely for a permit, so a saturated
  bucket grows a queue of drains, each holding its encoded batch.
- **It is not observable.** There was no `bql_upload_inflight` and no `bql_upload_waiting`, so
  "the bucket is the bottleneck" was a guess.
- **It counts reads too**, because it sits inside `#run`. A burst of `getOrNull` and `list` can
  hold every permit while an upload waits behind them.

## 2. What it is now

`UploadBudget` (`src/storage/budget.ts`), one per `ShipperPool`, which is one per thread. Every
`store.put`, `putStream` and `deleteMany` a shipper performs goes through it; everything else — the
encode, the log read, the timer — holds no permit, which is what the plan asked for and what keeps
the ceiling from serialising the pool.

**The queue is ordered by how far behind the caller is.** `Shipper.#upload` passes its
`shippedTxid` as the priority when it is behind, and 0 when it is not; lower goes first, ties break
by arrival so equal priorities stay FIFO and nothing is indefinitely overtaken by its own equals.

**A caller that waits longer than `[s3] uploadWaitMs` (5 s) is refused** with an
`UploadBudgetTimeout`, which fails the drain — and `#drainOnce`'s existing catch re-arms the timer.
Re-arming rather than queueing is the point: a shipper that queued would build a second queue behind
the budget's own, which is the failure this milestone exists to stop.

## 3. Deviation: the default is `[s3] concurrency`, not 8

The plan gives `[storage] maxConcurrentUploads` a default of 8. It lands as `[s3]
maxConcurrentUploads` — beside the bucket settings it belongs with rather than in a new section —
and it defaults to **following `[s3] concurrency`**, which is 4.

The reason is §1: the store's own gate is still there and is the node's real ceiling on requests of
any kind. A budget wider than it would let extra uploads past the budget only to queue them inside
the store, **in arrival order** — which would throw away the ordering that is the whole point. Two
nested queues where the inner one is FIFO is the same as having no priority queue at all. So the
budget is the binding constraint by construction, and raising it means raising `[s3] concurrency`.

## 4. Done when — against the plan's criteria

| criterion | result |
|---|---|
| 200 tenants shipping concurrently show at most `maxConcurrentUploads` in flight | **yes**, sampled *while* they run rather than after. `test/storage/upload-budget.test.ts`: sixty databases against three permits, peak in-flight three. The unit case offers 200 at once against four permits and peaks at four |
| `bql_upload_waiting` is non-zero under that load | **yes**, asserted from the same live sampling, and the gauge is wired through `ShipperPool.metrics()` to `/metrics` and summed across worker shards |
| the furthest-behind database's lag is bounded rather than monotonic | **the mechanism is asserted, the emergent property is not.** The ordering test pins that a caller at txid 100 is served before callers at 500 and 900 while one permit is held, which is what bounds the lag. Measuring the lag itself against the in-process fake S3 would measure the fake; against a real bucket it is not a test, it is a benchmark |

## 5. What it touched

`src/storage/budget.ts` (**new**: `UploadBudget`, `UploadBudgetTimeout`), `src/storage/pool.ts`
(owns the budget, `maxConcurrentUploads`, the two gauges in `metrics()`), `src/storage/shipper.ts`
(`budget` and `uploadWaitMs` options, `#upload` around every request),
`src/server/config.ts` (`[s3] maxConcurrentUploads`, `[s3] uploadWaitMs`), `src/server/runtime.ts`,
`src/server/routes.ts`, `src/server/metrics.ts` (`bql_upload_inflight`, `bql_upload_waiting`),
`src/server/workers/pool.ts` (both sum across the disjoint shards),
`test/storage/upload-budget.test.ts`, `docs/api.md`, `docs/design.md` §9.4.
