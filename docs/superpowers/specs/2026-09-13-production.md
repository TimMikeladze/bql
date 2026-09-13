# Production AgenticBus: the plan

Status: **all eight phases landed.** The progress table below says what each one turned into;
*Not done, on purpose or otherwise* at the bottom says what it did not, and
*What the plan got wrong* says where the plan itself was mistaken. Companion to
[the design](2026-09-12-message-bus.md) (what the bus is) and
[finishing](2026-09-13-finishing.md) (what was closed to get to 0.1). This one is the road from
"correct for a fleet" to "correct for something people page about" — schemas, exactly-once,
durability, continuity — without giving up the property that makes it worth using.

## The constraint that governs every bullet

**One binary, no runtime dependencies, no sidecars.** Every item below has to have an
in-process, zero-dependency implementation or it does not ship:

- schemas → own JSON Schema subset validator, not ajv
- replication → own log shipper over `fetch`/`Bun.s3`, not litestream
- tracing → own OTLP/HTTP exporter over `fetch`, not the OTel SDK
- crypto → `node:crypto`, already built in
- metrics → own Prometheus text, already built

If a feature can only be done well with a dependency or a second process, it goes in
**Out of scope** at the bottom rather than into the tree.

## What is already load-bearing and stays

Stated once so no phase re-litigates it: append-only log; cursor per subscription; fan-out on
pull; conditional-`UPDATE` claim; monotonic `generation` fencing; `UNIQUE(subscription, seq)`;
`WAL` + `synchronous=FULL` + `busy_timeout` + `foreign_keys`; numbered migrations that refuse a
newer database; `VACUUM INTO` backup; TTL and retention sweeps that will not take a message from
a running handler; drain-ordered SIGTERM; workspace as a mandatory predicate; multi-process soak
with SIGKILL.

## Progress

| Phase | State | Landed in |
| --- | --- | --- |
| 0 — Durability holes | **done** | `blobs.ts` atomic+fsync write, `body_sha256`/`body_bytes` (migration 3), `reconcileBlobs`, `wal_autocheckpoint` + sweep `TRUNCATE`, `capacity()`/507/503, `agenticbus restore`, soak `--fault` and `--sync` |
| 1 — Exactly-once, three tiers | **done** | `embedded.ts` (`createBus`, `ackTransactional`), `ack(…, {publish})` and `effects` (migration 4), fence token on the envelope, idempotent ack replay |
| 3 — Delivery quality | **done** | migration 5: backoff on nack *and* reclaim, priority classes, `delayMs`/`deliverAt`, `onFailure: block` with `blocked_keys`, quarantine, `maxInFlight`, shutdown nack in `BusConsumer` |
| 2 — Schemas | **done** | `schema.ts` validator, registry and bindings on `BusStore` (migration 6), publish/delivery enforcement, structural compat, `agenticbus schema …` |
| 4 — Multi-tenant safety | **done** | migration 7: `jti` revocation, `kid` rotation, token-bucket rate limits, workspace quotas, audit log |
| 5 — Observability | **done** | W3C `traceparent` propagation, zero-dep OTLP/HTTP exporter, age histograms, the missing gauges, per-workspace `/metrics` |
| 6 — Continuity | **done** | `replication.ts`: `agenticbus follow`, fenced `promote` with an epoch (migration 8), lag gauges, stated RPO, `restore --until-seq/--until-time` |
| 7 — Packaging and upgrade | **mostly** | `bun build --compile` matrix + checksums, embedded dashboard assets, `/api/v1` alias with version negotiation, compiled-binary e2e. **Release CI and the old/new binary skew test are not done** — both need a published previous release |

Eight migrations, 3–8 from this work. Every gate in the table further down is green except the
two called out as not done, and one — `--sync normal` — that was rewritten because the plan asked
it to prove something a process kill cannot prove.

---

## Phase 0 — Durability holes ✅ done

- **Blob writes are not durable.** `blobs.put` is a bare `Bun.write`. A crash after the row
  commits but before the page cache flushes leaves a committed message pointing at a missing or
  truncated file. Fix: write to `<handle>.tmp`, `fsync` the file, `rename`, `fsync` the
  directory. Ordering is already right (blob before row), so a crash costs an orphan, not a hole.
- **No integrity check on a blob.** Store `body_sha256` and `body_bytes` on the message row;
  verify on read; a mismatch is a `500` naming the handle, never a silently truncated body
  handed to a handler.
- **Dangling-handle scan at startup.** The sweep finds blobs with no message; nothing finds a
  message whose blob is gone. Add the reverse pass, report count as a gauge, and dead-letter
  those messages rather than failing claims forever.
- **One handle, two messages.** Dead-lettering copies `body_blob` into a new row, so a handle can
  be shared. The orphan sweep is an `EXISTS` check so this is currently safe — pin it with a test
  named for the invariant, because a future "delete the blob when deleting the message" is the
  obvious wrong fix.
- **WAL has no ceiling.** No `wal_autocheckpoint` policy and no checkpoint in the sweep. A
  long-lived reader plus sustained writes grows `-wal` without bound. Add a
  `wal_checkpoint(TRUNCATE)` on the sweep tick, plus `agenticbus.wal_bytes` and
  `agenticbus.db_bytes` gauges.
- **Disk-full is undefined.** `SQLITE_FULL` currently surfaces as a 500 and the bus keeps
  accepting publishes. Add a free-space watermark: below it, `/api/publish` returns **507** with
  a machine-readable reason, `/ready` goes 503, claims and acks keep working so consumers can
  drain. Losing writes loudly beats a crash loop.
- **Restore is untested.** `backup` exists; nothing proves a restore. Add `agenticbus restore
  <dir> --data <dir>` and a CI drill: publish → backup → wipe → restore → assert log, cursors,
  and blob bytes identical.
- **Fault injection in the soak.** `--kill-bus` kills at a random moment. Add deterministic kill
  points: between blob write and row insert, mid-transaction, between ack write and HTTP
  response. Also a `synchronous=NORMAL` run that is *expected* to lose data, so the FULL setting
  is proven to matter rather than assumed.

## Phase 1 — Exactly-once, stated honestly in three tiers ✅ done

End-to-end exactly-once against an arbitrary external system is not achievable and will not be
claimed. Three tiers, each precisely bounded:

- **Tier 1 — transactional ack (genuine exactly-once processing).** Only in embedded mode: the
  handler runs in the bus's own process and writes to the same SQLite file. `createBus()` returns
  an in-process bus with a direct client — no HTTP loopback, no socket. Then
  `consumeTransactional(sub, (envelope, tx) => …)` commits the handler's writes and the ack in
  **one** SQLite transaction. No two-phase, no idempotency key needed, nothing to reconcile. This
  is the strongest guarantee available anywhere and it exists *because* of the single-writer
  design, not despite it — the mode we already want is the mode that earns the guarantee.
- **Tier 2 — atomic read-process-write (exactly-once within the bus).** `ack(deliveryId,
  { publish: [...] })` commits the ack and the resulting publishes in one transaction. A chain of
  consumers is then exactly-once end to end for anything that stays on the bus — the Kafka
  transactions story, which is trivial here because there is one writer and one transaction.
  A reply (`replyTo`) becomes a special case of this rather than a separate path.
- **Tier 3 — fenced, ledgered effects (tight effectively-once for the outside world).**
  - Export a **fence token** `<deliveryId>:<generation>` on the envelope. External systems that
    support conditional writes (S3 `If-Match`, a `WHERE fence < ?` row) can reject a stale
    writer outright.
  - Add an **effect ledger**: `POST /api/effects/claim {key}` returns `{fresh:true}` exactly once
    and `{fresh:false, result}` thereafter, so a redelivery replays the recorded result instead
    of repeating the call. Ledger rows commit with the ack in Tier 2's transaction.
  - Remaining window, documented and not hidden: crash between "external call succeeded" and
    "result recorded". The fence makes the retry rejectable at the destination; nothing makes it
    impossible.
- **Idempotent ack retry.** Today an ack requires `status='leased'`, so a consumer retrying its
  *own* ack after a lost response gets a 409 and treats a success as a failure. Fix: when
  `consumer_id` and `generation` match an already-`acked` row, return the original outcome with
  200. Distinguish "you already did this" from "someone else owns it now".
- **README claim changes from** "no exactly-once delivery" **to** the three tiers, with the
  Tier 3 window named.

## Phase 2 — Schemas ✅ done

- **Registry.** `schemas(workspace, name, version, source, hash, compat, created_at)` unique on
  `(workspace, name, version)`; `bindings(workspace, subject_pattern, schema_name, mode)` where
  mode is `enforce | warn | off`. Patterns bind, not concrete subjects — same matcher as
  subscriptions, so `orders.>` covers the family.
- **Dialect: JSON Schema 2020-12, explicit subset.** Own validator — `src/bus/schema.ts`, ~660 lines including the
  compatibility comparator — compiled to a closure and cached by hash. Supported keywords are enumerated in the docs; **registration
  rejects any keyword the validator does not implement**, so an unsupported constraint can never
  silently pass. Loud gap beats quiet hole.
- **Validate at publish.** `enforce` → 422 with the failing JSON Pointer and the schema version.
  `warn` → publish, stamp `schema-invalid` in headers, bump `agenticbus.schema.violations`. Lets
  a schema be introduced against live traffic before it is enforced.
- **Validate at delivery, dead-letter on failure.** A message already in the log cannot be
  rejected, so a delivery that fails validation goes to the DLQ with `dlq-reason=schema`. That is
  the only correct move once the write has happened.
- **Compatibility is checked on registration, not documented as a convention.** `backward |
  forward | full | none`, computed structurally: newly required property, removed property,
  narrowed type, shrunk enum, tightened numeric bound. Registering a version that breaks the
  declared mode is a 409 naming the offending pointer. Schemas without compat checking are
  paperwork.
- **Envelope carries `schema` and `schema-version` headers**, so a consumer can branch on version
  rather than sniff the body.
- **Client typing without a dependency.** `BusClient.publish` accepts a
  [Standard Schema](https://standardschema.dev) object (`~standard`) for local validation and TS
  inference — it is an interface, not a package, so zero deps holds. The wire contract stays
  JSON Schema; the Standard Schema is a client-side convenience and is never the source of truth.
- **CLI:** `agenticbus schema register <name> <file> --compat backward`,
  `schema bind 'orders.>' <name> --mode warn`, `schema check <name> <file>` (dry-run compat),
  `schema list`.
- **README claim changes from** "no message schemas" **to** the registry, with the supported
  keyword subset linked.

## Phase 3 — Delivery quality ✅ done

- **Retry backoff. This is the biggest live gap.** `nack` accepts `delayMs`, defaults to 0, and
  **reclaim after lease expiry does not set `available_at` at all** — so a poison message
  hot-loops through all its attempts as fast as consumers can claim it. Add per-subscription
  `backoff: { baseMs, maxMs, factor, jitter: 'full' }`, applied on **both** nack and reclaim.
  Full jitter, not equal jitter: the failure mode is a fleet retrying in lockstep.
- **Priority classes.** `priority INTEGER NOT NULL DEFAULT 0` on messages; candidate scan becomes
  `ORDER BY priority DESC, message_seq`; index `deliveries_ready` gains the column. Bounded set
  (say −2…2) so it stays a class, not a float nobody can reason about.
- **Delayed and scheduled publish.** `available_at` already exists on deliveries but is not
  reachable from `publish`. Expose `delayMs` / `deliverAt`; `materialize` seeds it. Unlocks
  scheduled work and retry-later without a second system.
- **Ordered subscriptions need a failure policy.** Today a dead-lettered key silently lets the
  next message with that key through, which is exactly the ordering violation `ordered: true` was
  bought to prevent. Add `onFailure: 'block' | 'skip'` — `block` stalls that key (and only that
  key) until an operator requeues or skips it. Default `block`, because silently reordering after
  a failure is the surprise.
- **Poison quarantine.** Auto-pause a subscription when the dead rate over a window crosses a
  threshold, emit a loud event, keep serving other subscriptions. A subscription melting into the
  DLQ at full speed should stop, not finish.
- **In-flight ceiling.** `maxInFlight` per subscription so a misconfigured `prefetch` cannot lease
  the entire backlog into one process that is about to die.
- **Graceful consumer shutdown.** On SIGTERM the client should **nack in-flight deliveries with
  zero delay** rather than let leases expire — a deploy currently costs one `ackWaitMs` of dead
  time per in-flight message for no reason.

## Phase 4 — Multi-tenant safety ✅ done

- **Token revocation.** Stateless verification means no revocation today, which is fine until the
  first leaked token. Add `revocations(jti, not_after)` checked in-process — still no network, no
  round trip beyond a local index probe. Mint every token with a `jti`.
- **Key rotation with overlap.** `kid` in the token header, two active keys during rotation,
  `agenticbus keys rotate` and `keys retire <kid>`. Rotation is currently the only revocation
  mechanism, so it has to not require downtime.
- **Rate limits.** Token bucket per token on publish and claim; `429` with `Retry-After`. Cap
  concurrent parked long-polls per token so one consumer cannot occupy the server's poll budget.
- **Quotas per workspace.** Message count, total bytes, subscription count. One tenant must not
  be able to fill the disk that every other tenant's durability depends on.
- **Audit log.** Append-only `audit` table: who published, cancelled, purged, replayed, paused,
  minted, revoked — with token subject and timestamp. Operator actions without an audit trail are
  not operable, they are just powerful.

## Phase 5 — Observability ✅ done

- **Trace context end to end.** Propagate W3C `traceparent` from publish through delivery to
  reply; the client injects, the consumer extracts, the envelope carries it. Optional zero-dep
  OTLP/HTTP exporter behind `--otlp-endpoint`. Without this, a message crossing three consumers
  is three unrelated traces.
- **Histograms, not just counters.** Currently only `claim.duration`. Add publish latency, ack
  latency, **delivery age at claim** and **end-to-end age at ack** — age is the number that
  actually tells you the bus is behind.
- **Gauges that are missing:** DLQ depth per subscription, oldest pending age per subscription,
  in-flight per subscription, WAL bytes, DB bytes, free disk, replication lag.
- **`/metrics` is admin-only because it spans workspaces.** Add a per-workspace scrape scoped to
  a reader token, so a tenant can watch their own lag without an admin credential.

## Phase 6 — Continuity ✅ done

Replicate the **bus log**, not the SQLite WAL. The bus already is a log with a monotonic `seq`,
so a follower can rebuild from `/api/log?after=N` plus subscription cursors. No WAL frame
parsing, survives schema changes, and it is one file (`src/bus/replication.ts`, ~220 lines)
instead of a project.

- **Follower:** `agenticbus follow <upstream> --data ./replica` pulls messages and cursors,
  applies them, and serves reads. Delivery and lease rows are deliberately **not** replicated —
  leases are ephemeral, and a promoted follower re-materializes deliveries from cursors, which is
  the same code path a cold start already uses.
- **Fenced promotion.** `agenticbus promote` must acquire a lease in shared storage (S3
  conditional put, or a lock object on any backend) and stamps an incrementing **epoch** into the
  database. The old leader refuses to write once its epoch is stale. Split brain is prevented by
  the fence, not by hoping the old one is dead.
- **PITR.** `VACUUM INTO` snapshot plus shipped log after the snapshot's seq. Restore is snapshot
  + replay to a chosen seq or timestamp.
- **RPO is explicit.** Replication is asynchronous, so a failover can lose up to the current lag.
  Publish `agenticbus.replication.lag_seq` and `lag_ms`, alert on them, and **say the number in
  the README** rather than implying continuity is free.
- Still one writer. This buys continuity and read scale-out, not write scale-out, and the README
  says so in those words.

## Phase 7 — Packaging and upgrade — mostly done

- **Real single binary.** `bun build --compile` for `bun-linux-x64`, `bun-linux-arm64`,
  `bun-darwin-arm64`, `bun-darwin-x64`. Dashboard assets embedded via import attributes
  (`Bun.embeddedFiles`), not read from disk. Audit for `import.meta.dir`-relative reads and
  dynamic `import()` of computed paths — both survive `bun run` and break under `--compile`.
- **One data directory.** `--data ./x` holds the database, WAL, blobs and keys. A binary plus a
  directory is the whole deployment.
- **Versioned wire protocol.** `/api/v1/...` with the version also acceptable via header, so
  broker and clients can skew during a rolling deploy instead of requiring lockstep.
- **Upgrade rules, tested.** Migrations run at startup under an exclusive lock; a newer database
  already refuses an older binary (keep that). Add a CI skew test: old client against new broker
  and new client against old broker, both must pass the e2e.
- **Release CI.** Build matrix → checksums → GitHub release assets. Extend `verify-pack` to run
  the **compiled binary** through the full e2e, not just the packed npm tarball. A binary nobody
  executed in CI is not a release artifact.

---

## Verification gates

No phase is done until its gate is green. Extend the existing harnesses rather than adding new
ones.

| Gate | Proves | State |
| --- | --- | --- |
| `soak --fault blob-write \| mid-txn \| post-ack` | Phase 0 crash windows | ✅ green. `post-ack` shows the idempotent ack earning it: the response is lost, the consumer retries, and the message is **not** handled twice |
| `soak --sync normal` | what `synchronous=FULL` costs | ⚠️ implemented, but it does **not** demonstrate loss — see *What the plan got wrong* |
| `bun run drill:restore` | a backup is restorable, not merely produced | ✅ green. Log, cursors and blob bytes compared after a full wipe |
| Tier 1 transactional ack | killed mid-handler leaves no half-written state | ✅ `tests/production.test.ts` — the handler's row and the ack are both there or neither is |
| Tier 3 effect ledger | no duplicate effect; the ledger replays | ✅ `tests/production.test.ts`, including the `retried` case |
| schema compat tests | the checker refuses what breaks the declared mode, and names the pointer | ✅ `tests/schema.test.ts` |
| `soak --poison` | backoff bounds the retry rate; no hot loop | ✅ green — attempt budget respected, median retry gap ~150 ms rather than microseconds |
| `soak --ordered --poison` | `onFailure: block` never lets a key overtake its dead predecessor | ✅ green — **and it found a real bug**, see below |
| `bun run drill:failover` | promote under load, the fence rejects the old leader, the RPO is a number | ✅ green — lag at failover printed, tens of messages under continuous publish |
| wire-version negotiation in the e2e | `/api/v1` and `/api` reach the same route; an unknown version is refused | ✅ green |
| `bun run test:compiled` | the `--compile` output serves, and the dashboard loads from inside it | ✅ green |
| old/new binary skew | a previous release against this broker, and the reverse | ❌ **not done** — see below |

## What this work found

Two things worth recording, because neither was in the plan as written.

**An ordering hole the `--ordered --poison` gate exposed.** The claim's in-flight check was
"nothing *leased* for this key". Once retries were paced, a message waiting out its backoff was
`pending` rather than `leased` — so the next message on its key was claimable and ran first. The
gate caught it on its first run. The fix is that only the **head** of a key may be leased:

```sql
SELECT key, MIN(message_seq) AS head FROM deliveries
 WHERE subscription_id=? AND status IN ('pending','leased') AND key IS NOT NULL
 GROUP BY key
```

A candidate is claimable only if its `message_seq` is that head. This bug predates the backoff
work — a nack with an explicit `delayMs` could always trigger it — but nothing had made it
reachable by default before.

**An end-to-end check that was asserting about the wrong message.** The lease-recovery check
published a slow message and then waited for *any* leased delivery on the subscription, rather
than the one it had just published. `/api/deliveries` is a bounded, time-ordered view across
every subscription, so under load the check could pick up a different delivery and then assert
recovery about a message it had not chosen — an intermittent failure whose message pointed at
the bus rather than at the test. It now matches on the sequence number the publish returned.

**A SIGKILLed child looks exactly like a running one.** Bun reports `exitCode: null` and
`signalCode: "SIGKILL"` for a process killed by a signal, so the soak's supervisor never noticed
the bus had died from an injected fault and the whole run hung. Checking only `exitCode` is the
kind of thing that silently disables a fault-injection harness.

## What the plan got wrong

**`soak --sync normal` cannot be "expected to lose".** The plan assumed a `synchronous=NORMAL`
run would visibly lose data under the soak's process kills. It does not, and cannot: `SIGKILL`
takes the *process*, while the page cache belongs to the kernel and survives it. What
`synchronous=FULL` protects against is **machine** failure — power loss, a kernel panic, a
yanked volume — which a local harness cannot simulate without a VM or a block-device fault
injector.

So the flag is implemented and the run prints the truth rather than a passing test that means
nothing: `synchronous=NORMAL` survived, that is expected, and the elapsed-time difference against
a `--sync full` run is what the default costs. Claiming a durability proof from a process kill
would have been worse than claiming nothing.

## Not done, on purpose or otherwise

- **Old/new binary skew test.** The mechanism it protects — `/api/v1/...`, the
  `x-bus-api-version` header, and a 400 for a version this broker does not speak — is implemented
  and exercised in the e2e. The test itself needs a *published previous release* to run against,
  so it belongs in release CI rather than in a local `bun run` against a repo with one version in
  it. Wiring it up is the first thing to do when 0.2 ships.
- **Release CI (build matrix → checksums → GitHub release assets).** `bun run build:binary --all`
  produces the matrix and `checksums.txt`; hanging it off a tag push is a workflow file and a
  repository with releases enabled, neither of which exists here yet.
- **PITR from a shipped-log archive.** `restore --until-seq` / `--until-time` covers "restore the
  snapshot and stop before the bad batch", which is the case people actually hit. Replaying log
  segments written *after* a snapshot needs somewhere those segments were archived; today that
  somewhere is a follower, so the recovery path is "promote the replica", not "replay an archive".
- **`Lease` over object storage.** `fileLease` is correct on a filesystem both nodes genuinely
  share, and the `Lease` interface is the seam for a conditional-put implementation. Shipping an
  S3 one without a way to test it against real S3 semantics would be a claim, not a feature.
- **Rate limits are per process.** In memory, not persisted: writing a row per request to bound
  requests is the wrong trade. With one writer this is exactly right; it is stated because it
  would not be if the bus ever grew a second front end.
- **The compatibility checker is a structural approximation.** Exact subset checking of JSON
  Schema is undecidable. Anything it cannot decide is reported in *both* directions, so it fails
  a strict mode rather than passing one it should not — conservative in the safe direction, and
  documented in `docs/schemas.md` rather than implied to be exact.

## Sequencing

0 → 1 → 3 first: durability holes, exactly-once, retry backoff. Those are the ones where the
current behaviour is *wrong* rather than *absent* — a poison message hot-looping and a blob that
can vanish are bugs; missing schemas are a gap. 2 and 4 next (schemas, tenant safety), 5 and 6
after (observability, continuity), 7 whenever a release is wanted — it is independent.

## Out of scope, on purpose

- Raft, Paxos, or any consensus. Multi-writer. Synchronous replication. Active/active.
- Exactly-once against an arbitrary external system — Tier 3's window is the floor, not a
  temporary state.
- A pluggable non-SQLite store. The store sits behind a seam so it *could* be swapped; shipping a
  second backend doubles the correctness surface and halves the attention each gets.
- A scheduler, a workflow engine, or anything that knows what an agent is. That is
  [dagr](https://github.com/TimMikeladze/dagr)'s job, and the bus stays a client-agnostic
  primitive.

## Claims that changed

Done. `README.md` now says:

- **Delivery** — three named exactly-once tiers with the Tier 3 window linked, plus backoff,
  priority classes, delayed publish, `maxInFlight` and quarantine.
- **Ordering** — "only the head of a key may be leased", and `onFailure: block` as the default.
- **Schemas** — a section, with the two decisions that carry it (unsupported keywords are an
  error; compatibility is computed) and a link to `docs/schemas.md`.
- **Durability** and **Observability** — new sections for the fsync/checksum work, the disk
  watermark, the restore drill, trace propagation and the metrics that were missing.
- **Security** — revocation, key rotation with an overlap window, rate limits, quotas, audit.
- **Boundaries** — replication with a **stated RPO** and a fenced promotion, instead of a flat
  "not implemented"; "still one writer" said in those words.

`docs/operations.md` gained Continuity, Running out of disk, Rate limits and quotas, and Keys,
revocation and the audit trail; its metrics table and alert list were rewritten.

New: `docs/exactly-once.md` and `docs/schemas.md`.

## Schema versions

Eight migrations now, 3–8 from this work. A database written by a newer build is still refused
rather than guessed at.

| Version | Adds |
| --- | --- |
| 3 | `messages.body_sha256`, `body_bytes` |
| 4 | `effects`; `deliveries.ack_result` |
| 5 | subscription backoff/`on_failure`/`max_in_flight`/quarantine; `messages.priority`, `available_at`; `deliveries.priority`; `blocked_keys` |
| 6 | `schemas`, `schema_bindings` |
| 7 | `audit`, `revocations`, `quotas` |
| 8 | `cluster` |
