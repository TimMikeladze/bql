# L8 — a change event per statement inside a fold

`docs/plan-limits.md` L8, the stretch item. It unblocks two things at once, and the second one is
the reason it was worth doing.

## 1. The problem

`[limits] groupCommit` has been on by default since 2026-09-13, and it folds writes that arrive in
the same event-loop turn into one transaction. Each statement still gets its own result and its own
failure — but the change feed emitted **one event per transaction**, so fifty concurrent writers
produced one fat event and a consumer could not tell them apart.

Worse than fat: `txid` was not a **key**. Two events from different replays of the same history
could share it, and one event could cover work a consumer had already seen. A downstream consumer
that wants to dedupe — which is every durable one — had nothing to dedupe on. That is the gap
`docs/next.md`'s "the change ring is in memory, so `Last-Event-ID` returns `reset` across a
restart" sits in front of: a ring that answers `reset` is survivable if the client can resume from
a stable position, and impossible if it cannot.

## 2. What it is now

**One event per statement, keyed `(txid, seq)`.** `seq` is which statement of the transaction the
event is, counted from 0. A transaction that ran one statement has one event with `seq: 0`; an
atomic batch of ten has ten; a fold of fifty has fifty, sharing one txid.

Three pieces:

**The capture records statement boundaries.** The preupdate hooks see rows, not statements, so
`ChangeCapture.mark()` is called from the one layer that knows — `src/server/exec.ts`, after each
statement it runs on the writer. It appends the current row count to `marks`, which `afterCommit`
slices the row list at. A transaction nobody marked has no marks and publishes exactly as it did
before, which is what leaves the embedded API, the replica apply path and every internal write
unchanged.

**The position on the wire is `<txid>.<seq>`.** That is the SSE `id:`, and `Last-Event-ID`,
`?since=` and the WebSocket `subscribe` frame all take it. **A bare txid is still accepted** and
means "the whole of that transaction has been seen" — which is what every position issued before L8
meant, so an existing client resumes correctly without changing a line.

**The ring compares positions, not txids.** `ChangeRing.since` takes `{ txid, seq? }`, and the
eviction watermark is a position too: a ring that dropped `(5, 0)` while keeping `(5, 1)` can still
serve a client that already had `(5, 0)`, and must still refuse one that had only `(4, …)`. Getting
that wrong would have been a silent gap rather than a `reset`, which is the one failure mode this
part of the system must not have.

## 3. Decisions worth writing down

**`seq` numbers the events, not the statements.** A statement that changed no rows produces an
empty slice and therefore no event. Numbering statements instead would leave holes in the sequence
for work a consumer cannot see anyway, and a dedupe key does not need to be an index into anything
— it needs to be distinct, ordered and stable. It is all three.

**`CommitReport.change` is the first event, not all of them.** Everything that reads it — the
storage shipper, the replication server, the embedded `on("commit")` — wants "what happened in this
transaction" and predates the split. Handing it the first event keeps every one of those callers
working; a caller that wants the whole fold subscribes to the feed, which is where the fold is.

**A table-filtered subscriber gets the same `seq`.** When a fold touches several tables, each
table's topic receives that statement's slice narrowed to its own rows, carrying the same
`(txid, seq)`. So two subscribers watching different tables agree on the key for the same
statement, and a statement that touched neither of their tables is not delivered to either.

## 4. Done when — against the plan's criteria

| criterion | result |
|---|---|
| a fold of 50 writes emits 50 events sharing one txid with distinct `seq` | **yes.** `test/server/change-seq.test.ts`: fifty concurrent writes, fifty events, and the test asserts the fold actually happened (fewer distinct txids than events) — otherwise it would be proving nothing |
| SSE and WebSocket agree | **yes**, asserted on the same key from both surfaces |
| `docs/api.md` describes the key | **yes**, §6.4's example now shows two events under one txid, and the group-commit section's "one event per fold" bullet is struck through rather than quietly edited |

Two more, not asked for but load-bearing: a resume from the *middle* of a fold receives the rest of
that transaction, and a bare txid still resumes as it always did. Both are tested.

## 5. Also fixed: the stale line

`docs/next.md` said group commit was off while the same file's "three defaults, settled" said it was
on. The plan asked for that to be fixed as part of this; it was already corrected on 2026-09-14 and
the contract it names is what this milestone changed.

## 6. What it touched

`src/realtime/capture.ts` (`mark()`, `TxnChanges.marks`), `src/realtime/index.ts`
(`markStatement()`, `afterCommit` slicing into one event per statement, `sliceEnds`, `mergeChanges`
offsetting marks), `src/realtime/ring.ts` (`RingPosition`, `parsePosition`, `positionOf`,
`isAfter`, the evicted watermark as a position), `src/client/protocol.ts` (`ChangeEvent.seq`),
`src/server/exec.ts` (the four statement boundaries: a plain write, a folded write, an atomic batch,
a baton transaction), `src/server/runtime.ts` (`markStatement`), `src/server/sse.ts`
(`resumeFrom` parsing a position), `src/server/routes.ts` (the SSE id, the long poll),
`src/server/ws.ts` (`since` as a number or a string), `test/server/change-seq.test.ts` (**new**),
`test/e2e/scenario.test.ts` and `test/server/realtime.test.ts` (the contract they pin, rewritten
rather than deleted), `docs/api.md`, `docs/design.md` §6.4.
