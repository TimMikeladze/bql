# X6 — the outbox relay and the bus sinks

`docs/plan-ecosystem.md` §6, as built. A committed row reaches a bus subject durably and once; a
bus subscription reaches a webhook, a bucket or ClickHouse.

```
tenant log (v2 records) → relay (per database × rule, cursor file) → bus subject → sink consumer
                          dedupeKey per row change, batch publish                 webhook | s3 | clickhouse
```

## 1. The shape

**The relay reads the log, not the change feed.** The feed is in memory and post-commit; a crash
between a commit and its publish loses the event. The log is on disk and, since P9, a version-2
record carries the transaction's rows (`docs/p9-logical-cdc.md`). So `[outbox]` refuses to start
without `[replication] logicalChanges`: with it off every record is version 1 and there is nothing
to relay. `docs/monorepo.md` step 2 said "a commit hook publishing to a subject"; a hook has
exactly the crash window the log does not.

- `src/outbox/relay.ts` — `OutboxRelay` (one per runtime) and a `Tailer` per (database, rule). It
  follows the S3 shipper's lifecycle (`src/storage/pool.ts`): bound through the registry's `onOpen`,
  a commit arms a drain, a tenant the LRU closed while behind is reopened by the sweep (at most 16
  per sweep, so the relay cannot thrash the LRU).
- `src/outbox/cursor.ts` — `<tenant dir>/outbox.json`, `{ v: 1, cursors: { <rule>: "<txid>" } }`,
  temp file + fsync + rename. In the tenant directory so a delete takes it to the trash.
- `src/outbox/publisher.ts` — twenty lines of `fetch`, not an import of `bql.sh/bus/client`.
- `src/server/config.ts` — `[outbox]` and `[[outbox.rules]]`, `BQL_OUTBOX_RULES` as JSON.
- `packages/bus` — `POST /api/publish/batch`, `BusStore.publishBatch`, `BusClient.publishBatch`,
  and `src/sinks/` (`SinkRunner`, `webhookSink`, `s3Sink`, `clickhouseSink`), `bql bus sink`.

## 2. The guarantees and what carries them

| claim | mechanism | test |
|---|---|---|
| exactly once on the bus across a crash | cursor written only after the batch is acked; `dedupeKey = <db>:<generation>:<txid>:<postChecksum>:<seq>:<i>` | `relay.test.ts` "across a crash between publish and cursor write" — fails when the cursor is advanced before the publish |
| nothing published that a crash could take back | each drain reads `lastTxid`, then `log.sweepFlush()`, then publishes only up to it | — (not observable without a power cut; argued in the module header) |
| never a silent skip | `OUTBOX_GAP` warning + `bql_outbox_gaps_total` + jump to the first retained record | "a cursor overtaken by retention…" |
| v1 records skipped, counted | header version check before decoding | "a record with no rows is skipped and counted" |
| a failing bus holds the cursor | full-jitter backoff to `maxBackoffMs`, cursor untouched | "a failing bus holds the cursor…" |
| refuses without `logicalChanges` | `resolveOutboxRules` in `loadConfig` | `[outbox] config` tests |
| new databases picked up, deleted ones stop | `onOpen` → `attach`; `onChange("delete")` → `forget` | e2e (`app-1` created after start), "a deleted database stops…" |
| end to end, through a restart | real db server + real bus + `SinkRunner`/`webhookSink` | `e2e.test.ts` |
| a reset branch's reused txids are not dropped | the checksum in the key | "a reset branch reuses txids…" — fails with the key as it first shipped |
| a stale drain cannot move the new branch's cursor | `#advance` refuses a closed or unbound tenant | "a drain awaiting the bus across a reset…" |
| a cursor from another history is not trusted | cursor stores `<txid>:<checksum>`, checked on bind | "a cursor written against another history…" |
| a transaction over 1000 rows does not stall | chunks of ≤ `batchSize`, cursor moves after the last | "a transaction larger than a batch…" — the batch the first version sent was refused for ever |
| batches are charged against `--publish-rate` | `take(key, messages.length)`; over the burst is `413`, which the relay halves | bus `sinks.test.ts`, relay "a 413 halves the batch" |

Primary only: `authors(tenant)` is `!tenant.isReplica && roleFor(db) === "primary"`, and the router
of a `workers > 1` node builds no relay (it owns no tenant). Each worker relays its own shard; the
`bql_outbox_*` series are summed across workers like `bql_s3_*`.

## 3. Where the plan was wrong

**1. P9's capture floor did not apply until the first subscription.** `TenantRealtime` set the
capture level to its default (`pk`) in the constructor and only applied the `logicalChanges` floor
in `#refreshLevel`, which runs on subscribe/unsubscribe. A primary with `logicalChanges = "row"`
and nobody subscribed recorded **`pk` only**. P9's own tests always had a local subscriber, which is
why this survived. The relay's first test caught it (`row` absent from every message); the
constructor now calls `#refreshLevel()`. Removing that line fails two outbox tests.

**2. A txid does not name a change, and the first fix for that was also wrong.** The plan said
`<db>:<txid>:<seq>:<i>`. The first build added the generation, which covers delete-and-re-create —
and a review found three ways it does not cover: a branch `reset` keeps its generation (`created_at`
survives) and restarts its txids at the parent's head; the relay's own "cursor ahead of the log"
path resumes onto reused txids; and a promoted replica commits txids the old primary may already
have committed *and published* before it died. In each the new change's key equals one already on
the bus and the bus drops it, silently.

The key is now `<db>:<generation>:<txid>:<postChecksum>:<seq>:<i>` — the record's rolling checksum of
the whole database after the transaction. It was chosen over a random incarnation (minted at
create/fork/reset/promotion) because it is **identical on every copy of the same history**: a
crash-restart re-reads the same record, and a promoted replica holds byte-identical records for
everything it received, so both re-publish under keys the bus already has and dedupe as wanted. A
random id minted on promotion would have re-published every shared change as new. Where two
histories diverge the database states differ, so the keys do. Two histories that reach the same
txid with the same rows *and* the same state share a key, deliberately: nothing observable tells
them apart.

The cursor records the same checksum (`"<txid>:<hex>"`), and a tailer checks it against the log on
every bind: a log that reached the cursor's txid by another route discards the cursor and
republishes what it holds, the shared prefix deduping. A reset needed no registry hook: `reset`
closes the branch before it renames the directory, the relay refuses to write a cursor for a closed
tenant (a drain awaiting the bus across the swap would otherwise have written the old timeline's
cursor into the new directory and skipped its first transactions), and the delete/create events it
already emits drop the old tailers and bind new ones. A database with no cursor starts at its
catalog `forkedAt`, so a fork is not reported as a gap; a gap is only counted against a cursor the
relay actually held — a promoted node whose log starts at its bootstrap says where it starts instead.

**3. The bus had no batch publish.** One HTTP request and one SQLite transaction per row change
would make the relay the bottleneck of any bulk write. `POST /api/publish/batch` takes up to 1000
messages in one transaction (all or none, dedupe per message, including within the batch). The relay
falls back to one-at-a-time on a 404, so a new database server works against an old bus. As first
built it charged one `--publish-rate` token per request, which made it a way around the limit; it
charges one per message now, and a batch larger than the burst is `413` (never admissible, so not a
`429` to retry for ever). The relay halves a batch on `413`.

**3b. "A larger record goes alone" stalled.** A transaction with more rows than the bus's 1000-message
ceiling (or more than its 16 MiB request) was sent as one batch, refused, retried, refused — for
ever, with every later transaction behind it. A record now goes in chunks of at most `batchSize`
(clamped to 1000) and 4 MiB; only the chunk that finishes it moves the cursor, so a crash mid-record
re-sends the record and the keys absorb what landed. A single change whose JSON is over 4 MiB is
published without `row`/`old`, marked `oversized`, with a warning.

**4. "Written after a publish is acked" was not enough.** An appended record is not durable until
the log is synced, and under `fsync = "interval"` a crash can take the tail back. Publishing it
would put a change on the bus that never happened, and the txid would be reused by the next commit,
whose message the bus would then drop as a duplicate. The relay syncs before it reads.

**5. One cursor per tenant was one cursor too few.** Two rules matching one database (two buses,
two subject schemes) move independently, so the file holds a cursor per rule name. The name
defaults to a hash of `busUrl` and `subject`; setting `name` keeps a cursor across an edit of either.

**6. `--url` was taken.** On `bql bus`, `--url` is the bus. The sink destinations are `--to`, and
S3's endpoint is `--endpoint-url` because `--endpoint` names a saved connection.

**7. No S3 test fixture existed in `packages/bus`.** The s3 sink is tested through the real
`Bun.S3Client` against a local `Bun.serve` that accepts path-style PUTs, which checks the key, the
gzip and the NDJSON; `put` is injectable as well.

## 4. Decisions

- **Whole records per batch where they fit.** A batch that would overflow is sent first, so the
  cursor never has to say "half of txid N"; a record larger than a batch is chunked (§3b). Batches
  stop at 4 MiB of JSON, well under the bus's 16 MiB request ceiling.
- **The relay does not pin log retention.** A dead bus would otherwise grow every matching
  database's log without bound. Retention wins, and the gap is loud.
- **Start of history.** A database with no cursor is relayed from the first retained record.
  Records written before `logicalChanges` was on are version 1 and cost a header read each, so
  turning the outbox on does not replay history that has no rows in it. A promoted node's relay
  starts from its own log and the dedupe keys absorb the overlap.
- **Startup is cheap.** Every matching catalog row is owed a pass unless it closed cleanly with a
  cursor at or past its recorded txid.
- **Sinks ack after the write, per batch.** `SinkRunner` renews every lease it holds (buffered or
  mid-write) at half its granted length, nacks the whole batch on a write failure so the bus's
  backoff and dead letter apply, and hands the unwritten buffer back (`nack`, no delay) on stop. A
  write already in flight at stop is finished and acked, not aborted: aborting nacked a batch the
  destination may already hold, a guaranteed duplicate (found as a flaky test, reproduced by
  delaying the webhook's response).

## 5. Residuals

- **At-least-once past the bus.** A sink that crashes between the write and the acks writes the
  batch again. Webhook and s3 records carry `idempotencyKey`; ClickHouse gets no dedupe token,
  because a redelivered batch is not guaranteed to be the same batch.
- **ClickHouse shapes.** With `input_format_skip_unknown_fields` on, a line whose keys match no
  column inserts a row of defaults without an error. The outbox body is `{db, table, op, row, …}`,
  not the row, so outbox subscriptions want `--shape row` (which unwraps `row`, `old` for a delete,
  and adds `_op`, `_txid`, … columns); `row` refuses a message that is not an outbox change. The
  first version's comment said the outbox body "is the row"; it was wrong.
- **Failover overlap.** Changes the old primary committed and published but never replicated are on
  the bus and not in the new primary's database. That is a failover losing writes, which the bus
  cannot undo; the keys guarantee only that the new primary's different changes at those txids are
  not dropped as duplicates of them.
- **A reset is not a stream of deletes.** Consumers of a branch see its new timeline's changes; they
  are not told the old timeline's rows went away. Delete-then-fork has always meant that.
- **Truncated transactions.** A transaction past `maxRowsPerTxn` publishes what was recorded, each
  message marked `truncated: true`, and is counted; the missing rows cannot be recovered from the log.
