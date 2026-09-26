# Phase 3 — the frontier extras, three of which are not what design §11 thinks they are

Written 2026-09-16, from a read of the tree at `a7e7f41`, in answer to `docs/prompt-phase3.md`.
This is the plan of record for the **P track** (P7-P10), the last named phase of
`docs/design.md` §11. `docs/plan-phase2.md`, `docs/plan-surfaces.md` and `docs/plan-limits.md` are
its three predecessors and every milestone of all three is closed.

Read `docs/l5-fsync-sweep.md` and `docs/l6-upload-budget.md` first if you have not: L5 shipped its
feature turned off because the benchmark said so and L6 found its own premise half false. Phase 3
has one of each and an outright refusal besides.

## The one sentence

Design §11 lists four frontier extras as though they were four comparable pieces of work; read
against the tree, **one is already built, one is a real caller served by the wrong mechanism,
one cannot satisfy its own acceptance criterion by the method its name implies, and one has a
design that survives the house rules but costs more than the rest of phase 3 put together.**

| § | item as design §11 names it | what the tree says | milestone |
| --- | --- | --- | --- |
| P7 | query-plan cache | **exists** (`src/sqlite/database.ts:144`, `:279-302`), persistent flag already set, and the one improvement its name suggests — sharing across connections — is impossible in SQLite, not merely unbuilt | **done.** `docs/p7-plan-cache.md`; §11 lost the bullet, and the measurement found the ceiling binds |
| P8 | snapshot reads across requests | the bindings are dead code (`src/sqlite/lib.ts:176-179`, zero call sites) and **measurement says leave them that way**: a held read transaction pins the WAL by exactly the same 12 304 KiB, on every library and on a replica. The *caller* is real; the mechanism §11 named is not the way to serve it | **done.** `POST /v1/db/{db}/read`, no engine change, no new error code, and it found a write that landed on a replica. `docs/p8-read-sessions.md` |
| P9 | WAL-decoded logical CDC | a decoder **cannot** produce the per-statement `(txid, seq)` key L8 made the contract, because a replica receives one folded transaction and no statement boundaries. The answer is a change to what the primary records | **done.** Record version 2, `[replication] logicalChanges`, decoder refused. `docs/p9-logical-cdc.md` |
| P10 | per-tenant encryption at rest | nothing exists (`grep -rn "encrypt\|cipher" src/` is empty). A design that covers the whole path **does** exist and keeps zero runtime dependencies — a page-encrypting VFS in `scripts/native/` — and it is roughly the size of phases 0 and 1 | **done as a document, refused as a build.** `docs/p10-encryption.md` |

Two of the four therefore end with design §11 losing a bullet. That is the deliverable, not a
failure to deliver one.

## What does not change

Zero runtime dependencies. No new wire transport. `bun:sqlite` stays out of `src/`. Every new
`/v1` route is an entry in `src/server/registry.ts`. P9 changes the `TxnRecord` body and is the
only milestone that touches the replication format; it does so additively, behind a flag bit that
an older reader already ignores.

**Out of scope, named so nobody re-derives it.** `../../docs/timeseries-assessment.md` proposes
columnar storage, a second execution engine and within-tenant partitioning. Those are a different
product. Phase 3 does not begin them, does not prepare for them, and no milestone here should be
argued for on their behalf.

## Config

| key | default | milestone |
| --- | --- | --- |
| `[sqlite] statementCache` | `64` | P7, only if the measurement finds the number binds |
| `[limits] maxReadTx` | `16`, **unchanged** | P8 uses the existing bound rather than adding one |
| `[replication] logicalChanges` | `false` | P9, primary records row changes in the TxnRecord |

## New error codes

| code | status | when |
| --- | --- | --- |
| `LOGICAL_UNAVAILABLE` | 501 | P9: row events asked of a feed whose primary did not record them |

**P8 added none**, as built: it reuses `TX_BUSY` (409) at the bound and `TX_NOT_FOUND` for an
expired, ended or never-existent baton — R10's vocabulary, unchanged. The `READ_SESSION_EXPIRED`
(410) this table used to propose was dropped, because a caller does the same thing either way and
telling the two apart would need a tombstone per expired baton, with its own bound and its own
sweep, to change a status code that changes no behaviour. `docs/p8-read-sessions.md` §5. Each new
code goes in `src/server/errors.ts` `ERROR_STATUS`, `docs/api.md` §6.6's table, and the OpenAPI
document via `src/server/registry.ts`. `bun run routes:check` is the gate.

---

# P7 — the query-plan cache, which is a measurement

## What is actually there

`Database.#cache` (`src/sqlite/database.ts:144`) is a `Map<string, Statement>` in insertion order
used as an LRU: `prepare()` (`:278-303`) returns a live hit after re-inserting it to refresh
recency, and evicts and finalizes the oldest past `CACHE_LIMIT = 64` (`:129`).
`Statement.finalize()` calls back into `#drop` (`:844-847`) so a finalized statement cannot be
served from the cache. `close()` (`:792`) finalizes the lot.

Three of `docs/prompt-phase3.md`'s four questions are already answered by reading it:

**`SQLITE_PREPARE_PERSISTENT` is already set.** `:291` — `prepareStatement(this, sql,
SQLITE_PREPARE_PERSISTENT)`. There is nothing to turn on.

**The cache cannot be shared across connections, and this is a SQLite fact rather than a bql.sh
omission.** A `sqlite3_stmt*` belongs to the `sqlite3*` it was compiled against; there is no API
that lets two connections execute one prepared statement, and no API that exposes a compiled plan
apart from a statement. A tenant holds one writer and up to `readers` (default 2,
`src/tenant/tenant.ts:535`) pooled readers, so a hot database holds three independent 64-entry
caches — and that is the only shape SQLite permits. The design §11 bullet, read literally, asks
for something that cannot exist.

**A cached statement survives DDL on its own.** Since `prepare_v2`, `sqlite3_step` re-prepares
transparently on `SQLITE_SCHEMA`; the handle stays valid and the caller never sees the code.
The one BQL-specific hazard is not DDL but the authorizer: `authorizer()`
(`src/sqlite/database.ts:423`) re-arms `sqlite3_set_authorizer` on every change precisely because
that is what expires statements compiled under the old verdicts — the file header says so and it
is correct. **Both belong in a test rather than in a belief**, and P7 writes them.

## So what is left

Exactly two questions, and both are numbers:

1. **Is 64 the right ceiling, and does any real workload thrash it?** The data API generates a
   statement per operation per table (`src/dataapi/`), so a 30-table database can exceed 64 live
   SQL texts on one connection. A thrashing cache is silently 2-3 orders of magnitude worse than a
   hitting one and nothing reports it today.
2. **Does the miss cost anything measurable on the paths that matter?** `bun run bench --only
   driver` and `bench/profile.ts` are the instruments.

## Method

A hit-rate counter behind the existing `RegistryStats` shape, then: `bench/driver.ts`'s
100-row scan as the control; a new leg that cycles more distinct SQL texts than `CACHE_LIMIT`
against one that stays under it; the ratio between them is the whole finding.

**Read `docs/performance.md` §8 before taking any number, and check `uptime` first.** This
machine ran at load 4-11 for the whole L-track session. Interleave A-B-A-B. If the effect cannot
be resolved, *say it could not be resolved* — that is the L5 outcome and it is a result.

## Done when

`docs/p7-plan-cache.md` exists and states, with numbers:

- the measured hit rate of the default 64 on the data API's generated workload;
- the cost of a forced miss against a hit on the driver bench, or an explicit "below this
  machine's resolution" with the interleaved rounds that say so;
- **and either** `[sqlite] statementCache` landed because the measurement found 64 binds,
  **or** design §11's phase-3 row lost the "query-plan cache" bullet and §11 gained a one-line
  pointer to this file.

Two tests regardless, because they pin claims this milestone is making: a cached statement keeps
answering across a `CREATE TABLE` on the same connection, and changing the authorizer invalidates
a statement compiled under the old one. Run each against a tree with the mechanism removed and
check it fails — `bun run bench --only driver` must not move the 100-row scan by more than 2%.

## P7 as built — `docs/p7-plan-cache.md`

Three deviations from the above, all measured.

**64 binds at six tables, not at thirty.** This plan's estimate — "a 30-table database can exceed
64 live SQL texts on one connection" — counted one statement per operation per table. The generator
writes a text per *shape*, and a `?select=`, a filter set, an order and a bulk-insert row count are
each a shape. Twelve texts per table is a modest client, and twelve times six is past 64: the
measured hit rate is 100% at five tables and **0% at six**.

**The Done-when's "either/or" is both.** `[sqlite] statementCache` landed *and* design §11 lost the
bullet, because the two are answers to different halves: the ceiling is real and had no setting,
and the cache the bullet names already exists with `SQLITE_PREPARE_PERSISTENT` set.

**The 2% gate could not be resolved and is reported as unresolved**, the L5 way. Fifteen
interleaved A-B rounds: 9.08 µs p50 against the parent's 9.24, inside a within-leg spread of 21%.

And one thing this plan does not know about: **`sqlite3_set_authorizer` expires every statement on
a connection, and a token-authenticated *write* cycles the authorizer twice per request** — so the
writer's cache hits while SQLite recompiles underneath, 5.119 µs against 0.843. Readers are scoped
once and stay scoped, and an admin principal pays nothing, which is why no benchmark has shown it.
Recorded in `docs/p7-plan-cache.md` §4 with its number; not fixed by P7, because keeping the
writer's policy installed between requests is a security-shaped decision rather than a tuning one.

### P7 as built — what the measurement changed

**Done, `docs/p7-plan-cache.md`.** The plan called this "probably nothing measurable is left" and
was half right and half wrong, in the useful direction.

Right: the cache exists, `SQLITE_PREPARE_PERSISTENT` is already set, sharing across connections is
impossible, and design §11 lost its bullet.

**Wrong about the ceiling.** This document guessed 64 would bind "at about thirty tables". It binds
at **six**: the generated data API writes a text per *shape* — a `?select=` list, a filter set, an
order, a bulk-insert row count are each a shape — not one per operation per table. Six tables took
the workload from a 100% hit rate to **0%**, and the `prepare` past the ceiling costs **81x** a hit
(186x under load). So `[sqlite] statementCache` landed with three counters, because a cliff nothing
reports is worse than a cliff.

**And one finding nobody was looking for.** On the *token-authenticated write* path, the cache hits
and SQLite recompiles anyway: `applyPolicy` installs a policy and `handle.release()` takes it off in
a `finally` (`src/server/exec.ts:310`), so every such write cycles `sqlite3_set_authorizer` twice,
and that is exactly what expires the connection's cached statements. Measured at **4.28 µs** on a
~27 µs write. The read path does not do it — `withReader` (`src/server/runtime.ts:896-903`) scopes
once and never releases — and no benchmark has ever shown it, because benchmarks authenticate with
the admin key and an admin principal installs no policy at all. **Not fixed here**: leaving a
connection scoped to the last request's token is a security decision, not a tuning one. It is
recorded in `docs/next.md` as its own gap.

---

# P8 — a consistent read across requests, and the measurement that changed its mechanism

**Revised 2026-09-16, after the spike this section originally asked for.** The first draft of this
plan proposed building on `sqlite3_snapshot` with a held read transaction as the fallback. The
spike says the fallback is the whole answer and the snapshot API is not worth its cost. It is
`experiments/snapshot.ts`, it runs in about four seconds, and a milestone should re-run it rather
than trust this paragraph.

## The product question, answered first — and the answer is yes, there is a caller

`docs/r10-read-transactions.md` §4 declined a fourth baton mode on the grounds that the native
surface's consistent-read answer is `BQL-Min-Txid`. That is correct about read-your-writes and
**not** an answer to this milestone, because the two do different things:

- `BQL-Min-Txid` (`src/server/exec.ts:262-263`) is a **floor**: "do not answer until the tenant
  has reached txid N." Two reads that both satisfy it can see different databases, because the
  second sees every write that landed in between.
- A read transaction (`Tenant.readTxBegin`, `src/tenant/tenant.ts:1313`) is a **point**.

The caller is anything that needs a point and takes more than one request to read it: keyset
pagination that must not skip or duplicate rows under concurrent writes, a dashboard issuing eight
queries that must agree, an export read by an external tool. R10 built the mechanism for **Hrana
only** (`src/server/hrana/execute.ts`), so today that capability exists for a `@libsql/client`
caller and for nobody on bql.sh's own `/v1` surface.

**So the gap is a surface, not a mechanism.** That is what P8 ships.

## The spike, and why the snapshot API loses

**Every checkpoint mode invalidates a snapshot handle, PASSIVE included.** Take a handle, write,
checkpoint, re-open: `sqlite3_snapshot_open` answers **769** — `SQLITE_ERROR_SNAPSHOT` — for
PASSIVE, FULL, RESTART and TRUNCATE alike. A snapshot handle held outside a read transaction has
**no read mark**, so SQLite does not know to protect it and backfills straight over it. Keeping one
alive therefore means suppressing *all* checkpointing for the session's lifetime, by hand.

The obvious hope is that this buys bounded WAL growth where a held reader does not. It does not.
Measured — 3 000 writes, autocheckpoint off as a bql.sh tenant has it:

| | isolation holds | WAL after 3 000 writes |
| --- | --- | --- |
| **A** — held read transaction, PASSIVE checkpoint every 200 writes | yes | **12 304 KiB** |
| **B** — snapshot handle, every checkpoint suppressed | yes | **12 304 KiB** |

**Identical, to the kilobyte.** A PASSIVE checkpoint cannot backfill past the oldest read mark, so
a held reader pins the WAL exactly as completely as a suppressed checkpoint does. The snapshot API
buys no WAL, no latency and no throughput. It buys one pooled reader connection — ~17 µs to open
(design §2.4) and a handful of descriptors.

Against that it costs four things:

1. **It is absent on every distribution libsqlite3.** No distro ships `SQLITE_ENABLE_SNAPSHOT`
   (`docs/c6-packaging.md` §1); only the vendored build has it (`scripts/sqlite.ts:63`). So the
   read-transaction path has to exist anyway, for the majority of installs.
2. **It is *wrong* on a replica.** Under mechanism A the applier `pwrite`s pages straight into the
   database file and keeps a zero-byte `-wal` (`src/wal/applier.ts:613`, `docs/c5-apply-pages.md`).
   There is no old version of a page for a snapshot to name. A read transaction works there, and
   works *because* the lease makes the applier answer `ApplyBusy` and back off.
3. **It means hand-rolling read-mark protection**, in a node that would then have two mechanisms
   pinning the WAL — SQLite's, and bql.sh's — that must agree. Getting that wrong is a torn read.
4. **It would need its own bounds**, its own metric and its own expiry, all duplicating
   `maxReadTx`, `readTxTimeoutMs` and `TX_BUSY`, which already exist and are already tested.

**Refused.** `sqlite3_snapshot_*` stays bound and unused, and `src/sqlite/lib.ts:176-179` gains a
comment saying it was measured and why it is not wired, so the next reader does not mistake dead
bindings for unfinished work. Design §11's phase-3 row loses "snapshot reads across requests
(`sqlite3_snapshot`)"; what replaces it is the surface below, which is smaller and works
everywhere.

*(One thing the spike does not settle, recorded so nobody claims it was: whether a future
checkpoint policy that is aware of open read marks could let a snapshot outlive a PASSIVE pass.
It could not without bql.sh writing read marks into the wal-index for readers that do not exist,
which is the same class of trick E2 spent a session undoing on Windows.)*

## What P8 builds

**A read session on the native `/v1` surface, on R10's mechanism, with no new consistency
primitive.** `Tenant.readTxBegin/readTxExec/readTxEnd` and `ServerRuntime.beginReadTx/
readTxSession/endReadTx` (`src/server/runtime.ts:1193-1246`) are the whole engine and are
unchanged. What is new is the route layer and the caller.

| | |
| --- | --- |
| `src/server/registry.ts` | the routes, as `Operation`s — never a hand-written line in `createApp` |
| `src/server/routes.ts` | the handlers, taking a baton the way the writer transaction already does |
| `docs/api.md` | the surface, the baton's lifetime, and **why a read session is not a transaction** |
| `GET /v1/db/{db}` | open read sessions, beside the counters already there |

R10's own bounds carry over untouched: `[limits] maxReadTx` = 16 per database, `readTxTimeoutMs` =
30 s, `409 TX_BUSY` at the bound, `TX_NOT_FOUND` after expiry. **No new limit, no new error code
except `READ_SESSION_EXPIRED` if the expiry needs distinguishing from a bad baton** — and if it
does not, P8 adds no code at all, which is the better outcome.

**The milestone includes the caller.** A mechanism with no caller is what `docs/r10-read-transactions.md`
§4 declined and what `docs/prompt-phase3.md` warns against; P8 ships the paginated read that uses
the session, so the surface is exercised by something a client would actually write.

## Done when

- A client takes a consistent read across **several HTTP requests** on `/v1`, and a write committed
  between request one and request three is **invisible** inside the session and **visible** outside
  it. One test, both halves.
- The same test passes against a **replica**, which is the case a snapshot handle would have got
  wrong.
- The bounds bite: the seventeenth session on one database is `409 TX_BUSY`, and a session left
  past `readTxTimeoutMs` is gone and its next statement says so.
- `docs/p8-read-sessions.md` records the two spikes with their numbers, the refusal and its four
  reasons, and design §11's phase-3 row has lost the `sqlite3_snapshot` bullet.
- `src/sqlite/lib.ts:176-179` says why it is bound and unused.
- Every new code in `docs/api.md` and the OpenAPI document; `bun run routes:check` passes.
- Each test run once against a tree with the mechanism removed, and seen to fail.

---

# P9 — logical CDC, and why the decoder is the wrong instrument

## The finding, first

**A WAL page decoder cannot satisfy this milestone's own acceptance criterion.** The criterion is
that "a primary and its replica agree event for event on the same transaction". Since L8
(`docs/l8-change-seq.md`) an event is keyed `(txid, seq)` and `seq` is *which statement of the
transaction* the event is. `seq` comes from `ChangeCapture.mark()`, called from `src/server/exec.ts`
after each statement — the only layer that knows where a statement ended.

A replica receives a `TxnRecord` whose body is `zstd([pgno u32 | page]*)`
(`src/wal/record.ts:12-25`), which is one transaction's **net page delta**. It contains no
statement boundaries, and it cannot: group commit folds fifty writers into one transaction
(`[limits] groupCommit`, on by default), and the primary emits fifty events for the one record the
replica gets. A decoder would emit at most one event per fold, with no honest `seq` to put on it.
It also loses a row inserted and then updated within one transaction — the primary emits two
events, the net delta shows one.

So the decoder is not a hard version of the right answer. It is a different, weaker answer, and the
part of it that is genuinely hard — page header, cell pointer array, varints, the serial-type
record format, overflow chains, diffing across page splits, and a persistent page→table map
seeded by a full tree walk because a leaf page does not name its table — buys a result the
milestone would then have to redefine to accept.

*(One thing the decoder route does have going for it, recorded so nobody thinks it was missed: the
set of pages a transaction wrote is closed under cell movement, because moving a cell writes both
pages. A per-transaction diff is therefore local. That is the elegant half; the page→table map is
the half that is a persistent index and a bootstrap tree walk.)*

## What P9 builds instead

**The primary records the row changes it already has.** `src/realtime/capture.ts` produces exactly
the right object — `RowChange` with `op`, `rowid`, `pk`, `row`, `old`
(`src/client/protocol.ts:112`) — sliced per statement. Today it is published and dropped. P9
appends it to the `TxnRecord` body behind a new flag bit, and `TenantRealtime.afterApply`
(`src/realtime/index.ts:323`) publishes it instead of `changes: []`.

This is the outcome `docs/prompt-phase3.md` explicitly permits: *"a defensible outcome is also
'this needs a change to what the primary records, not a decoder'"*. It is that outcome, and the
reason is the acceptance criterion rather than the difficulty.

Four things make it cheap where the decoder is not:

- **Event-for-event agreement is true by construction**, not by argument. Both feeds come from one
  capture, with one `seq`.
- **The record format has room, but not the free kind — checked, and the first draft of this plan
  had it wrong.** `flags` is a `u8` with two bits used (`FLAG_ZSTD = 0x01`,
  `FLAG_SNAPSHOT_BOUNDARY = 0x02`, `src/wal/record.ts:51-52`), so a bit is available — but
  `decode` asserts `plain.byteLength % (4 + pageSize) === 0`, "a whole number of pages"
  (`:260-263`), and the body hash covers `plain` entire. A trailer is therefore **not** invisible
  to an old reader: it fails that assertion. Which is the right failure and the wrong message.

  So: **`RECORD_VERSION` 2, emitted only when a record actually carries logical changes.** A
  primary with `logicalChanges` off writes v1 forever; a reader that cannot parse v2 already says
  `unsupported transaction record version 2` (`:225-227`), which is the message an operator needs.
  A log, a stream and a bucket may hold a mix, exactly as they already may for `FLAG_ZSTD` — the
  comment at `:120-127` states that contract and it carries over unchanged.

- **The replica must be able to say it cannot read v2, and the primary must honour it.** `HELLO`
  carries a protocol version that is still 1 after R7 added three optional fields
  (`src/replication/protocol.ts:29-30`); follow that pattern — an optional `maxRecordVersion` on
  the replica's `HELLO`, absent meaning 1, and a primary that omits the logical section for a
  replica that did not ask for it. A primary must never stream a record its peer will reject, and
  "upgrade the replica first" is an operational rule this milestone should make unnecessary rather
  than document.
- **The schema problem disappears.** The decoder's worst part is needing the schema to interpret a
  page; a `RowChange` carries column names already.
- **It works on every library**, because it needs no capability a replica does not have.

The honest costs, stated rather than discovered later:

- **Record size.** A row-heavy transaction can carry more logical bytes than page bytes. Hence
  `[replication] logicalChanges` defaults **off**, and hence the milestone measures the ratio on
  `bench/replication.ts` and publishes it. The zstd the body already uses applies to both halves.
- **The primary must capture when nobody local is subscribed.** Capture level is per database and
  driven by subscribers (`docs/design.md` §4.6); the flag makes shipping a subscriber. Preupdate
  capture is ~50 ns/row, which is the number to confirm rather than assume.
- **`row+old` on the wire is the whole row twice.** The recorded level is its own setting, floored
  at `pk` and capped at whatever the primary is capturing.
- **A replica whose primary did not record them** must answer `LOGICAL_UNAVAILABLE` rather than
  the empty array it sends today — an empty array is indistinguishable from "nothing changed" and
  that is the silent-wrong-answer this milestone is here to remove.
- **No preupdate hook, no rows.** A primary on a libsqlite3 without `SQLITE_ENABLE_PREUPDATE_HOOK`
  runs the update-hook fallback, which has no values and no `WITHOUT ROWID` tables. It records
  what it has and says so; it does not pretend.

## And the decoder

**Refused, with the reasoning in `docs/p9-logical-cdc.md` §2**, and design §11's phase-3 row loses
the words "WAL-decoded". The mechanism it would serve is built; the method is the wrong one. If a
later product needs a decoder for something else — reading a foreign SQLite file, a replica with no
cooperating primary — that is a new milestone with its own justification, not a debt this one left.

## Done when

- `[replication] logicalChanges = true` on a primary, and a replica's change feed carries the same
  `RowChange[]` under the same `(txid, seq)` as the primary's own feed, asserted **event for event
  against a fold of fifty concurrent writes** — the case that makes the decoder impossible is the
  case the test uses.
- A replica whose primary has the flag off answers `LOGICAL_UNAVAILABLE`, in `docs/api.md` and the
  OpenAPI document, rather than `changes: []`.
- A v1 record is byte-identical to what the tree writes today, proved by a test that encodes the
  same transaction with the flag off and compares; and a replica announcing `maxRecordVersion: 1`
  against a primary with the flag **on** receives v1 records and keeps replicating, rather than
  failing on a version it never asked for.
- `bench/replication.ts` reports the record-size ratio with and without, in `docs/performance.md`.
- `bun test` and `bun test` with `BQL_WAL_NATIVE=0` both green; each new test run once against a
  tree with the fix removed and seen to fail.

---

# P10 — encryption at rest: a design, a price, and a recommendation not to pay it now

## The state of the tree

`grep -rn "encrypt\|cipher\|Cipher\|AES" src/` returns nothing. There is no key, no keyring, no
setting and no plaintext boundary written down anywhere.

The primitive is not the problem: Bun ships WebCrypto and `node:crypto`, so AES-256-GCM costs no
dependency. **The problem is that bql.sh does not own the writes.** SQLite writes `main.db` and
`-wal` through its own VFS, and bql.sh has never registered one — it reaches `sqlite3_file*` through
`file_control` for locks (`src/wal/shmlock.ts`) and nothing more.

Every one of these is a plaintext path and a full answer must cover all of them:

| path | who writes it | what encryption has to do |
| --- | --- | --- |
| `main.db` | SQLite's VFS | pages encrypted beneath SQLite |
| `-wal` | SQLite's VFS | frames encrypted; `src/wal/tailer.ts` reads this file directly and must decrypt |
| `-shm` | SQLite, and bql.sh through its mapping (E2) | page numbers and checksums, no row data — out of scope, and say so |
| replica apply | `WalApplier` `pwrite`s pages into the file (`src/wal/applier.ts:613`) | must encrypt with the same key, bypassing the VFS entirely |
| log segments | `src/wal/log.ts` | `TxnRecord` bodies are page images |
| snapshots | `src/wal/snapshot.ts:137`, a reflink copy | ciphertext copies fine; the key must outlive the copy |
| bucket | `src/storage/shipper.ts` | same objects |
| replication wire | `src/replication/` | page images to a peer, which needs the key |

A `[security] encrypt = true` that covers the first row and not the rest is the thing
`docs/prompt-phase3.md` forbids, and it is what every half-build of this becomes.

## The design that does work

**A page-encrypting VFS shim written in C, compiled into the vendored artefact beside
`scripts/native/walsum.c`.** This is not a new kind of thing: P3 already ships bql.sh's own C in
that artefact and resolves it as optional symbols (`src/sqlite/lib.ts`, `docs/p3-wal-checksum.md`).
It keeps zero runtime dependencies — nothing is installed, the same `bun run sqlite:build` produces
it — and it costs no `JSCallback` on the page path, which a VFS written in Bun FFI would, once per
page read and write, re-entering JS from inside a SQLite call. That is the segfault surface
`src/sqlite/database.ts`'s header exists to keep small, and it is also the performance answer: a
point read is 0.79 µs today.

It also answers every row of the table above, because the three writers that bypass the VFS are
bql.sh's own and share the key: the applier encrypts the pages it writes, the tailer decrypts the
frames it reads, and the log, the snapshots and the bucket carry ciphertext pages end to end. The
rolling checksum picks one side — **ciphertext**, so that a replica verifies what it received
without holding a key — and says so.

The parts nobody should discover late: a key lifecycle (per tenant, derived from a node key, held
where?), a rotation story (rotation is a rewrite of every page of a database, so it is a fork), a
`-shm` exclusion documented rather than forgotten, and the fact that **the feature is absent on a
distro libsqlite3**, which makes it the first bql.sh feature where the vendored build is not a
performance preference but a requirement.

## The recommendation

Write it down; do not build it in phase 3. The estimate is not "an afternoon" like P7 or "a
milestone" like P8 and P9 — it is a C VFS, a keyring, a rotation path, changes to the applier, the
tailer, the shipper and the replication handshake, and a threat model that has to be honest about
what a live node's memory contains. That is a track, not an item, and it should be Tim's call made
against a written cost rather than a coordinator's call made mid-phase.

The near answer for a deployment that needs encryption today is the one that is already true and
unwritten: full-disk encryption (LUKS, FileVault, an encrypted EBS volume) plus S3 SSE covers every
row of that table except the threat model where the operator is the adversary — which is the only
threat model a per-tenant key actually improves on. **`docs/api.md` should say that**, because a
deployment reading design §11 today learns that encryption is coming and nothing about what to do
in the meantime.

## Done when

`docs/p10-encryption.md` exists and contains: the plaintext-path table above with each row
answered; the VFS design and the reason it is C and not FFI; the key lifecycle and the rotation
story; the explicit `-shm` exclusion; the capability consequence for distro libsqlite3; and the
cost. **Then design §11's phase-3 row loses the "per-tenant encryption at rest" bullet** and gains
a pointer to that file, so the next reader finds a costed design instead of a promise.

If Tim reads the cost and wants it, it is a track of its own with its own plan. Phase 3 does not
half-build it.

---

---

# The track as run — what the four actually were

| | the plan said | what happened |
|---|---|---|
| **P7** | a measurement; probably delete the line | **both.** §11 lost the bullet *and* `[sqlite] statementCache` landed, because the ceiling binds at **six tables**, not the thirty this plan guessed, and crossing it costs 81x a hit. Found, unlooked-for, that a token-authenticated write expires its own statement cache twice per request |
| **P8** | build on `sqlite3_snapshot` with R10 as the fallback | **reversed by the spike before a line was written**, then reversed once more by building it: the surface is `POST /v1/db/{db}/read` on R10, no engine change, **no new error code** — and it found that a write as a read session's *first* statement **landed**, on a pooled reader, outside the writer, the log, the feed and replication, on a replica included |
| **P9** | build the recorded form, refuse the decoder | as planned, and the refusal held up under construction. Two of its own tests **did not bite** when their mechanism was removed and were rewritten. Record size came in at 1.04-1.35x where this plan feared above 2x, because zstd sees the row bytes twice |
| **P10** | write the design and the cost; do not build | as planned |

**Two of the four ended in a deletion from design §11 and a third lost two words.** That is the
shape of a phase whose items were named before the tree existed, and it is the right outcome rather
than a shortfall.

Three findings outlived their milestone and are in `docs/next.md`'s gap list rather than buried
here: the authorizer cycle on the write path (P7 §4), `executeInReadTx`'s missing write guard
(P8 §8), and design §4.6's preupdate cost, which was the *update* hook's number — 252-349 ns/row
measured against the 50 ns the design claimed (P9 §5).

# Order, and what each one blocks

1. **P0 (this document) and the `docs/next.md` sweep.** Done at the top of the session; four
   bullets in "Known gaps worth fixing along the way" contradicted the rest of the same file and
   have cost one session a wrong belief already.
2. **P7**, first, because it is a measurement and the answer might be "delete the line." An
   afternoon, and it must not move `bun run bench --only driver`'s 100-row scan by more than 2%.
3. **P9 and P8 in parallel** — disjoint file sets, now that P8 has stopped touching
   `src/sqlite/`. P9 owns `src/wal/record.ts`, `src/realtime/`, `src/replication/` and
   `src/tenant/tenant.ts`'s record path; P8 owns `src/server/routes.ts` and the read-session half
   of `src/server/runtime.ts`. Both touch `src/server/registry.ts`, `src/server/errors.ts` and
   `docs/api.md`: P9 lands those first and P8 rebases, or they land sequentially. Tell each agent
   which paths it does not own.
4. **P10 is a document**, written last, and it ends the phase by removing a bullet.

## Gates — all green before anything is called finished

    bun test                              baseline: 1530 pass, 2 skip, 0 fail, 133 files, ~50s
    bun test  with BQL_WAL_NATIVE=0     proves the JavaScript WAL-checksum fallback
    bun run typecheck
    bun run bytes                         from the repo root
    bun run routes:check
    bun run pack:check
    bun run bench --only driver           P7 must not move the 100-row scan by more than 2%

Check `uptime` before trusting any number and read `docs/performance.md` §8 first. Reporting
"this could not be resolved on this machine" is a result; reporting a number that could not be
resolved is not.
