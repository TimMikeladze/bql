# P9 — logical CDC, and why the decoder is refused rather than deferred

`docs/plan-phase3.md` §P9. A replica's change feed carries rows. Design §11 said a WAL decoder
would do it; a WAL decoder cannot, and this document is as much about that as about what shipped.

## 1. The finding

**A replica's change feed answered `{ txid, changes: [] }` for every transaction, and an empty
array is indistinguishable from "that transaction changed nothing."** A consumer built on a
replica's feed was wrong and had no way to find out. That silent wrong answer is what this
milestone removes, and it is removed twice over: with `[replication] logicalChanges` on, the feed
carries the same `RowChange[]` under the same `(txid, seq)` as the primary's own; with it off, a
subscription that asks for rows is refused `501 LOGICAL_UNAVAILABLE` instead of being answered with
the empty array.

**The primary records the rows it already captures. There is no decoder, and there will not be
one for this.** §2 is the argument.

## 2. Why a WAL page decoder cannot satisfy this milestone's acceptance criterion

The criterion is that a primary and its replica **agree event for event on the same transaction**.
Since L8 (`docs/l8-change-seq.md`) an event is keyed `(txid, seq)`, and `seq` is *which statement of
the transaction* the event is. It comes from `ChangeCapture.mark()`, called from `src/server/exec.ts`
after each statement — the only layer in the tree that knows where a statement ended, because the
preupdate hooks see rows and not statements.

A replica receives a `TxnRecord` whose body is one transaction's **net page delta**. Two things
follow, and they are not difficulties, they are impossibilities:

**There are no statement boundaries in a page delta, and there cannot be.** `[limits] groupCommit`
is on by default and folds every write that arrives in one event-loop turn into one transaction. A
fold of fifty writers is fifty events on the primary — that is the L8 contract — and **one record**
on the wire. Nothing a decoder could read out of those pages distinguishes the first writer's row
from the fiftieth's, because SQLite wrote them into the same pages and kept no record of the order.
A decoder's best possible output is one event per transaction with no honest `seq` to put on it,
which is the thing L8 was built to stop emitting.

**A net delta is not a change list.** A row inserted and then updated inside one transaction is two
events on the primary and one net row in the pages. A row inserted and then deleted is two events
and *no* trace at all. The decoder does not lose precision here; it loses events.

So the decoder is not a hard version of the right answer. It is a different, weaker answer — and
the part of it that is genuinely hard, which is the whole of it (page headers, cell pointer arrays,
varints, the serial-type record format, overflow chains, diffing across page splits, and a
persistent page→table map seeded by a full tree walk, because a leaf page does not name its table)
buys a result the milestone would then have to redefine downward to accept.

`docs/prompt-phase3.md` permits exactly this outcome — *"a defensible outcome is also 'this needs a
change to what the primary records, not a decoder'"* — and it is that outcome, reached from the
acceptance criterion rather than from the difficulty.

**Refused, not deferred.** There is no half-built decoder here and no TODO pointing at one. If a
later product needs to read a SQLite file nobody cooperated in writing — a foreign database, a
replica with no cooperating primary — that is a new milestone with its own justification, and
nothing in this one is a down payment on it.

*One thing the decoder route does have going for it, recorded so nobody re-derives it and thinks it
was missed: the set of pages a transaction wrote is closed under cell movement, because moving a
cell writes both pages, so a per-transaction diff is local. That is the elegant half. The page→table
map is the half that is a persistent index and a bootstrap tree walk.*

## 3. What shipped

### 3.1 Record version 2

`RECORD_VERSION_LOGICAL = 2`, written **only when a record actually carries rows**. A primary with
the flag off writes version 1 forever, and a log, a stream and a bucket may hold a mix of the two
exactly as they already may for `FLAG_ZSTD` (`src/wal/record.ts:120-127` states that contract and it
carries over unchanged).

The body is `[pages][logical][logicalLength u32]`, the length **last**:

```
v1:  plain = [pgno u32 | page]*
v2:  plain = [pgno u32 | page]*  |  logical  |  logicalLength u32
```

That placement is the whole trick. The page region keeps byte offset 0 and byte-for-byte content,
so `bodyPlainLength` covers both halves, the existing body hash still covers everything, and the
record stays self-verifying with no new field and no second hash. `test/wal/record.test.ts` asserts
that encoding the same transaction with and without rows produces identical page bytes, and that
`logical: null`, `logical: new Uint8Array(0)` and no `logical` at all all produce the byte-identical
version-1 record the tree wrote before P9.

**It is a version and not a flag bit, and the first draft of the plan had this wrong.** The plan
said a trailer behind a new flag bit would be "invisible to a reader that does not look for it". It
is not: `decode` asserts `plain.byteLength % (4 + pageSize) === 0` — "a whole number of pages" — and
an old reader hitting a trailer fails *that* assertion, with a message about page sizes. The right
failure and the wrong message. Version 2 makes the same reader say `unsupported transaction record
version 2`, which is what an operator can act on.

The bytes inside the logical section are **opaque to `src/wal/`**. It frames them, hashes them and
hands them back; `src/realtime/logical.ts` is the only module that knows they are JSON. The record
format and the change-feed shape move independently, and the module whose invariant is "a record is
self-verifying" does not acquire an opinion about design §6.4.

### 3.2 The ordering hazard, and how it is solved

This is the part most likely to have gone wrong, so it is written down rather than left in the code.

The record is **encoded and appended before the change feed publishes**. `Tenant.#file` calls
`this.log.append(record)` and only then `#publish(event)`, which reaches `realtime.afterCommit(txid)`
through the `onCommit` listener the runtime wires. `afterCommit` is what drains `ChangeCapture`. So
at encode time the captured rows are still buffered and **whichever path drains them first wins** —
a record path that simply called `takeCommitted()` would feed the replica by emptying the primary's
own feed.

The solution is that exactly one path drains, and the other reads what it left:

- `Tenant.#file` calls an opaque `LogicalRecorder` with the batch's txids, immediately before the
  append. The tenant learns nothing about what comes back.
- `TenantRealtime.recordLogical` drains the capture **once**, stages each transaction's
  `TxnChanges` under its txid, and returns the encoded bytes.
- `afterCommit(txid)` looks in the stage first and drains only if it finds nothing.

One materialisation, two feeds, and `seq` computed from the same `marks` on both sides by
construction rather than by agreement. With the flag off the stage is always empty and `afterCommit`
behaves exactly as it did.

`test/replication/logical.test.ts` asserts the hazard directly: *"the feed on a primary is
unaffected by what the record carries"*. Removing the `#stage` call — draining without staging —
makes that test time out waiting for an event the primary never publishes. That is the failure this
design exists to prevent, and it is pinned.

**The seam is an option, not a dependency edge.** `src/tenant/` must not import `src/realtime/` —
the tenant deliberately knows nothing about the hook slots that module owns — so `setLogicalRecorder`
takes a function the server runtime installs, and `TxnRecord.logical` is `Uint8Array`.

### 3.3 Lining records up with transactions, and refusing when they do not

`recordLogical` returns `null` — recording nothing for the whole batch — unless the number of
transactions buffered in the capture equals the number of records about to be filed. They are 1:1
in the ordinary write path, deferred append included, because both queues fill from the same
commits. They are not 1:1 when a WAL transaction changed no rows at all (the commit hook buffers
nothing for it), or when `maxBufferedTxns` has dropped the oldest.

**When they do not line up, nothing is drained and the batch is recorded as version 1.** A replica
then sees no rows for those txids, which is honest. The alternative — pulling from a queue by
position and hoping — files one transaction's rows under another transaction's txid, and a wrong row
under a right key is worse than no row at all. This is the one place P9 deliberately gives up rather
than guesses.

### 3.4 `LOGICAL_UNAVAILABLE`, 501

Raised from `TenantRealtime.subscribeChanges` — not from a route — so SSE, the long poll and the
WebSocket all answer it without `src/server/routes.ts` being touched.

| primary's `logicalChanges` | `include=none` | `include=pk` / `row` / `row+old` |
|---|---|---|
| off (default) | served, `changes: []` | **501 `LOGICAL_UNAVAILABLE`** |
| `"pk"` / `"row"` / `"row+old"` | served | served, capped at the recorded level |

`include=none` promises no rows, so it is served: a live-query client and a "something changed,
re-read" consumer work on a replica exactly as they always did, which is what keeps this from being
a breaking change for the thing replicas are mostly used for.

**How a replica knows.** Two answers, in this order:

1. The primary **announces it**, per database, on `SUBSCRIBED` (`logical?: boolean`, optional and
   additive). This is the one that matters: a replica that has just bootstrapped holds no record
   yet, and refusing a subscription for the length of one idle database would be a wrong answer with
   a long tail.
2. Failing that, the version of the last record in the replica's **own log**, which covers a replica
   that is up but not currently connected.

And a version-2 record arriving on the engine settles it whatever anyone said.

### 3.5 Version negotiation, so an old replica keeps replicating

`HELLO` gains an optional `maxRecordVersion`. **Absent means 1**, which is what every replica built
before P9 sends by saying nothing. `PROTO_VERSION` stays 1 — the same call R7 made when `HELLO`
gained `generations`.

A primary **never streams a record its peer will reject**: `ReplicationServer.#emit` compares the
record's version byte against what the peer announced and calls `stripLogical` when it has to,
which decodes and re-encodes the same transaction as version 1. The comparison is one byte on every
record; the round trip is paid only for an old peer that is actually attached. "Upgrade the replica
first" is an operational rule this makes unnecessary rather than documents.

`test/replication/logical.test.ts` drives a raw socket that sends no `maxRecordVersion`, against a
primary with the flag **on**, and asserts it receives version-1 records with no logical section —
while the primary's own log holds the version-2 record they were downgraded from.

### 3.6 The recorded level

`[replication] logicalChanges` is the level, not a boolean: `false`, `"pk"`, `"row"`, `"row+old"`,
with `true` meaning `"row"`. Default **`false`**.

A level and not a boolean because the primary captures at whatever its highest *local* subscriber
asked for, and that is no basis for deciding what crosses the network — `row+old` is the whole row
twice. The recorded level **caps** what leaves the node, narrowing each `RowChange` on the way into
the record, and it **floors** the capture level, because with the flag on the record is a subscriber
whether or not anything local is watching.

Both halves are tested. The cap test raises the primary's capture to `row+old` with a local
subscriber while the config says `"pk"`, and asserts the primary's feed has `row` and `old` while
the replica's has only `pk`. It was written once without the local subscriber and **passed against a
tree with the narrowing removed** — the capture level was already `pk`, so narrowing was a no-op and
the test proved nothing. It is in its current form because of that.

## 4. What the machine said

`docs/performance.md` §11 has the tables. Three numbers matter here.

**Record size: 1.04x to 1.35x, and the plan expected worse.** `docs/plan-phase3.md` warned that "a
row-heavy transaction can carry more logical bytes than page bytes", which would be above 2x. It
never approaches one:

| shape | ratio |
|---|---|
| single-row insert | 1.11x |
| wide row, 200 B of random text | **1.04x** |
| 1000 small rows in one txn | 1.28x |
| 1000 updates at `row+old` | 1.35x |

**The reason is zstd, and it is worth understanding rather than just recording.** The body is
compressed as a whole, and the row values are *already in the page images* the same body carries, so
the logical section is largely a second copy of bytes the compressor has just seen and codes as a
back-reference. The wide-row shape makes this vivid and counter-intuitive: 200 bytes of
incompressible text per row adds **76 bytes** to the record, not 250. The expensive shape is the
opposite one — many *small* rows in one transaction, where the pages are few and the logical section
is paid per row.

Taken at load average 10.6–13, and quoted anyway: a byte count is deterministic, and two runs of the
unchanged shapes agreed to the byte.

**The write path did not resolve.** Four interleaved A-B rounds put the flag at +2.9% against a
within-leg spread of 25.2%; two rounds of the same script said +15.5%. The instrument is the noise.
**Reported as unresolved**, which is L5's outcome and a result.

**Design §4.6's "hook cost ≈ 50 ns/row" does not reproduce, and §5 says what it actually is.**

## 5. What contradicts the plan, or the tree

Three things, in descending order of how much they matter.

**1. Design §4.6's preupdate cost was the update hook's number.** §4.6 says the change feed's
capture costs "≈ 50 ns/row", and the plan repeated it as the figure to confirm. Measured — fifteen
interleaved rounds, the delta taken *within* each round — the preupdate hook costs **252 ns/row at
`pk` and 349 ns/row at `row`**, with a floor of 228 ns/row that load cannot explain away, because
load biases upward. Run again on the `update` engine, the same script reports **85 ns/row and
76 ns/row**, with a paired minimum that goes negative. That is the ~50 ns. Design §2.3's own table
is where it came from — 0.18 µs for an insert against 0.23 µs "with JS `update_hook` firing" — and
§4.6 attached the fallback engine's number to the preupdate bullet. Both lines in `docs/design.md`
are corrected and point at `docs/performance.md` §11.

This is not a cost P9 introduced. Any database with a subscriber has paid it since phase 0; what the
flag adds is the `pk` → `row` step and the same capture on databases that had no subscriber.

**2. The size warning the flag's default was justified by is too pessimistic.** `logicalChanges`
defaults off "because the honest cost is record size: a row-heavy transaction can carry more logical
bytes than page bytes". It does not, in any shape measured — the worst is 1.35x. **The default
should still be off**, and the justification changes rather than disappears: the real costs are the
capture the flag forces on every database (§5.1 above, and 250–350 ns a row is not nothing on a bulk
load) and the fact that it is a format change every reader of the log, the stream and the bucket has
to be able to parse. Neither is a reason to make it the default, and the size is no longer one at
all.

**3. The plan's "trailer behind a flag bit" was already corrected in the plan, and the correction
is right.** Recorded here because the reasoning is load-bearing for anyone extending the format:
`decode`'s page-count assertion means there is no such thing as an additive body change a
version-blind reader ignores.

Two residuals, neither a contradiction but both worth stating:

- **A primary that turns the flag off mid-life** leaves a connected replica's feed published with
  empty `changes` for the txids that follow, until it re-subscribes and the announcement corrects it.
  The subscription is not re-refused under a running feed.
- **A batch whose records cannot be lined up** (§3.3) publishes empty `changes` for those txids on
  the replica, on a feed that has already promised rows. It is bounded to transactions that changed
  no rows and to `maxBufferedTxns` overflow, and the alternative is filing rows under the wrong key.

## 6. No preupdate hook, no rows

A primary on a libsqlite3 built without `SQLITE_ENABLE_PREUPDATE_HOOK` runs the update-hook
fallback: no values and no `WITHOUT ROWID` tables. It records what it has — table, op, rowid, and an
`INTEGER PRIMARY KEY` alias where there is one — and the payload states the level it recorded, so a
replica shows exactly that and nothing more. It does not claim `row` and deliver keys. This is the
same degradation the primary's own feed has always had on such a build, carried across the wire
unchanged rather than papered over.

## 7. Done when — against `docs/plan-phase3.md`'s P9 criteria

| criterion | result |
|---|---|
| `logicalChanges = true` on a primary, and a replica's feed carries the same `RowChange[]` under the same `(txid, seq)`, **asserted event for event against a fold of fifty concurrent writes** | **yes.** `test/replication/logical.test.ts`, "a fold of fifty writes reaches the replica event for event": fifty concurrent writes, and the test first asserts the fold actually happened (fewer distinct txids than events) so it cannot pass on a tree where nothing folded. The two feeds are compared with `toEqual` — key, order and rows |
| a replica whose primary has the flag off answers `LOGICAL_UNAVAILABLE`, in `docs/api.md` and the OpenAPI document, rather than `changes: []` | **yes.** Asserted on the WebSocket and over HTTP (501, code in the body). `docs/api.md` §6.6's table and a new "The change feed on a replica" section; `src/server/registry.ts`'s `changes` entry lists the code, and `bun run routes:check` passes |
| a v1 record is byte-identical to what the tree writes today, proved by encoding the same transaction with the flag off and comparing bytes | **yes.** `test/wal/record.test.ts`, "a record with no logical changes is byte-identical to what v1 always wrote" — and the v2 page region is compared against the v1 one page by page |
| a replica announcing `maxRecordVersion: 1` against a primary with the flag **on** receives v1 records and keeps replicating | **yes.** A raw socket that sends the field not at all, which is the real case |
| `bench/replication.ts` reports the size ratio; `docs/performance.md` carries it | **yes.** Four shapes, `docs/performance.md` §11 |
| `docs/p9-logical-cdc.md` exists, argues the refusal, scores itself | this file |
| design §11's phase-3 row loses "WAL-decoded", with a pointer | **yes**, plus §11's prose, the "Deferred to phase 3" paragraph, the as-built differences line, and §6.4 |
| `bun test` and `bun test` with `BQL_WAL_NATIVE=0` both green; each new test run once against a tree with the fix removed and seen to fail | **yes**, both green; the removals and what they said are in §8 |

## 8. Each test, run against a tree with the mechanism removed

Nine breaks, one at a time, each reverted before the next.

| removed | what failed |
|---|---|
| `recordLogical` returns null always | "a fold of fifty writes…" (timed out, then `toEqual` mismatch), "the recorded level caps…", "a v1-only replica…" — 3 fail |
| `#stage` call dropped: drain without staging | "a fold of fifty writes…" **and "the feed on a primary is unaffected…"** — both time out. The hazard, pinned |
| the `LOGICAL_UNAVAILABLE` throw | "a replica whose primary records nothing…" — 1 fail |
| `narrowRowChange` returns the row unchanged | **passed. The test was wrong** — it set `logicalChanges: "pk"` with no local subscriber, so the capture level was `pk` and narrowing was a no-op. Rewritten to raise the primary's capture to `row+old` with a local subscriber; it then fails as it should |
| `stripLogical` returns its input | "stripLogical downgrades…" and "a v1-only replica…" — 2 fail |
| `#emit` ignores `conn.maxRecordVersion` | "a v1-only replica…" — 1 fail |
| `encode` writes version 2 unconditionally | 6 fail, three of them pre-existing tests: "round-trips every field", "flags survive and combine with zstd", "records sit back to back". The version byte is load-bearing outside P9's own tests |
| the logical trailer's bounds check | **passed.** The bad length fell through to the page-count assertion, which threw `WalFormatError` too — so the test asserted "refused", not "refused by this guard". Tightened to match the message; it then fails |
| `setPath`'s `logicalChanges` exception | "[replication] logicalChanges is a level…" — 1 fail. Without it, `BQL_REPLICATION_LOGICAL_CHANGES=row` coerces through the boolean branch to `false` and the feature is silently off |

Two of the nine did not bite, and both were the test's fault rather than the mechanism's. Both are
fixed and re-checked.

## 9. What it touched

**Format.** `src/wal/record.ts` (`RECORD_VERSION_LOGICAL`, `MAX_RECORD_VERSION`, `TxnRecord.logical`,
the trailer in `encode`/`decode`, `stripLogical`, the layout comment), `src/wal/index.ts`.

**Capture and feed.** `src/realtime/logical.ts` (**new**: the payload codec, `toRowChange`,
`narrowRowChange`, `sliceEnds`, moved here so the record path and `afterCommit` slice identically),
`src/realtime/index.ts` (`recordLogical`, the stage, `afterCommit` reading it, `afterApply` taking
the section and fanning out per table, the `LOGICAL_UNAVAILABLE` refusal, the capture-level floor).

**Write path.** `src/tenant/tenant.ts` (`LogicalRecorder`, `setLogicalRecorder`, the call in `#file`,
`lastRecordVersion`, the module header's hook-slot paragraph).

**Replication.** `src/replication/protocol.ts` (`HelloBody.maxRecordVersion`,
`SubscribedBody.logical`), `src/replication/primary.ts` (`recordsLogical`, `conn.maxRecordVersion`,
the downgrade in `#emit`), `src/replication/replica.ts` (announces `maxRecordVersion`, records what
`SUBSCRIBED` said, `recordsLogical(db)`).

**Server.** `src/server/config.ts` (`logicalChanges`, `LogicalChangeLevel`, validation, the `setPath`
exception), `src/server/errors.ts`, `src/client/protocol.ts` (the code), `src/server/registry.ts`
(the `changes` entry), `src/server/runtime.ts` (the recorder wiring, the eager engine on tenant open,
`recordsLogicalUpstream`, `afterApply`'s new argument).

**Tests.** `test/replication/logical.test.ts` (**new**, 5), `test/wal/record.test.ts` (+6),
`test/replication/config.test.ts` (+1), `test/replication/realtime.test.ts` (the phase-1 limitation
it pinned, rewritten rather than deleted: it now pins the half that did not change).

**Benchmarks and docs.** `bench/replication.ts` (the size section), `docs/performance.md` §11,
`docs/api.md`, `docs/design.md` §2.3, §4.6, §6.4, §11.
