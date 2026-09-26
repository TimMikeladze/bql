# The prompt for phase 3

**This is a prompt, not a plan of record.** It is what the next session should be handed; its
first instruction is to write `docs/plan-phase3.md`, which *will* be the plan of record. Written
2026-09-16, at the end of the session that built the L track (L1–L8), against the tree at
`14e7f91`. Every file and line number below was checked against that tree.

It is kept because the facts in it were expensive to establish and cheap to lose: two of the four
phase-3 items look, on inspection, like they should be *refused* rather than built, and a session
starting cold would spend a day rediscovering that.

Paste the block below into `/goal`.

---

```
Work in /Users/tim/workspace/bql/packages/db. The L track (docs/plan-limits.md, L1–L8) is
finished and pushed; CI is green on macOS, Linux, Windows and the new tarball job. This is
phase 3 of docs/design.md §11 — the last named phase.

Read docs/next.md ("House rules for this repo" and "Where things stand") first, then
docs/design.md §11 (the phase table), §4.5, §4.6, §5.2, then docs/api.md. Then read
docs/l5-fsync-sweep.md and docs/l6-upload-budget.md before anything else — not for their
subject but for their shape: L5 shipped its feature turned **off** because the benchmark
said so, and L6 found its own plan's premise was half false. Both outcomes are wins. Phase 3
has at least one of each in it.

Also read ../../docs/timeseries-assessment.md, "The principal blockers". Three of its findings
the L track just closed. The rest tell you what phase 3 must **not** pretend to solve:
columnar storage, a second execution engine and within-tenant partitioning are a different
product and are out of scope here.

## The track in one line

Design §11 lists four "frontier extras" for phase 3, and they are not four equal pieces of
work: one is probably already built, one is nearly free, one is a serious piece of
engineering, and one may not survive contact with "zero runtime dependencies". Find out which
is which before writing code for any of them.

## P0 — write the plan of record, then the cheap sweep

Write docs/plan-phase3.md the way docs/plan-limits.md was written: from an actual read of the
tree, naming files and line numbers, with a "Done when" per milestone that is an assertion
rather than an intention. It must settle the real scope of the four items below, including
the ones whose answer is "this does not exist as a problem" or "this cannot be done under the
house rules". Do not start P1 until that document says what P1 is.

While you are in the docs: docs/next.md's "Known gaps worth fixing along the way" has four
bullets that contradict the rest of the same file — "a replica cannot be promoted" (C2 built
it), "a database deleted on the primary is never dropped by a replica" (R7), "schema events
reach WebSocket subscribers only" (the SSE feed carries them), and "bench/http.ts
authenticates with the admin key" (there is a minted-token leg). That rot already cost one
session a wrong belief about group-commit defaults. Sweep it as part of P0.

## P1 — the query-plan cache, which may already exist

design §11 asks for one. `Database.#cache` (src/sqlite/database.ts:144, 279-295) is already an
LRU of prepared statements keyed by SQL text, and the time-series assessment says in as many
words that it "should not be mistaken for a missing feature merely because older plans
mention a future plan cache".

So P1 is a measurement, not a build. What, if anything, is left: is the cache per connection
where it could be shared, is SQLITE_PREPARE_PERSISTENT worth setting, what happens to cached
statements across DDL, and does any of it show up in `bun run bench --only driver` or
`bench/profile.ts`? If the honest answer is "nothing measurable is left", **delete the line
from design §11** and write that down. A negative result here is the correct deliverable and
costs an afternoon; building a second cache on top of the first costs a week and a bug.

**Done when:** docs/p7-plan-cache.md states the finding with numbers, and either a measured
improvement landed or design §11's phase-3 row lost a bullet.

## P2 — snapshot reads across requests

Most of the plumbing is already there and unused: `sqlite3_snapshot_get/open/free/cmp` are
bound in src/sqlite/lib.ts:176-179 and 331-334, `features.snapshot` exists at :366, and
`-DSQLITE_ENABLE_SNAPSHOT` is already in the vendored flag list (scripts/sqlite.ts:63). No
distribution libsqlite3 ships it (docs/next.md, docs/c6-packaging.md §1), so it needs C5's
shape exactly: use it where the loaded library has it, fall back with a documented reason
where it does not, and never let a query's answer depend on which library was found.

The harder half is the product question, and it must be answered in the plan **before** any
code: what is this for that `BQL-Min-Txid` does not already do? docs/r10-read-transactions.md
§4 declined a fourth baton mode for exactly this reason, and P2 repeats that mistake if it
ships a mechanism looking for a caller. If the answer is "a multi-request consistent read that
holds no transaction and no reader", say so and design the surface around that; if there is no
such caller, refuse the milestone and record it.

**Done when:** a client can take a consistent read across several requests without holding a
reader open, a node whose library lacks the capability answers the documented fallback rather
than a wrong result, and a test proves a concurrent write is invisible inside the snapshot.

## P3 — WAL-decoded logical CDC. The real one.

A replica's change feed is `{ txid, changes: [] }` (src/realtime/index.ts:327), because a
replica receives **page images** — `TxnRecord.pages` is a `Map<number, Uint8Array>`
(src/wal/record.ts:83-86) — and row-level capture on a primary comes from SQLite's preupdate
hook, which a replica never runs.

Making a replica emit row events means decoding SQLite's own b-tree leaf format from those
pages: page header, cell pointer array, varint payload lengths, the serial-type record format,
and overflow chains. Then diffing the pre-image against the post-image of each changed page to
derive insert / update / delete, which is not a local operation when a cell moves between
pages or a page splits. And interpreting any of it needs the schema, which lives in pages too.

This is the milestone with real risk, and the plan must say honestly where it stops. A
defensible narrow first cut: rowid tables only, no overflow, no WITHOUT ROWID, no index pages,
and a loud typed refusal for everything else — shipped behind a flag that is off. A defensible
outcome is also "this needs a change to what the primary records, not a decoder", in which
case say that and cost it.

L8 already put the wire shape in place: events are keyed `(txid, seq)` and a replica's
txid-only events carry no `seq`, so filling the array does not move the contract.

**Done when:** a replica's change feed carries row changes for the narrow case the plan
committed to, a primary and its replica agree event for event on the same transaction, and
anything outside that case is refused with a code in docs/api.md rather than silently emitting
an empty array.

## P4 — per-tenant encryption at rest, which may have to be refused

Nothing exists today: no match for `encrypt` or `cipher` anywhere in src/. SQLite's own answers
are SQLCipher and SEE — one is a dependency and a fork of the amalgamation, the other is
commercially licensed. The alternatives are a VFS that encrypts pages beneath SQLite, or
encrypting the files and holding keys outside the database.

This collides head-on with "zero runtime dependencies", and it also collides with things the
tree already relies on: mechanism A writes the wal-index through its own mapping (E2), the
shipper uploads segments and snapshots as files, and replicas ship raw pages. Every one of
those is a plaintext path that encryption at rest has to answer for.

Do not half-build it. Either the plan finds a design where the whole path is covered and the
house rules survive, or P4 is refused with the reasoning written down and design §11 loses the
bullet. Both are acceptable; a `[security] encrypt = true` that encrypts the main database and
leaks the WAL, the log and the bucket is not.

**Done when:** docs/p9-encryption.md either describes a design that covers the database, the
WAL, the log, snapshots and the bucket — with a key lifecycle and a rotation story — or states
why phase 3 does not ship it.

## Beyond phase 3, in the order it is worth doing

1. **The durable change ring.** The last realtime gap: `Last-Event-ID` from before a restart
   answers `reset`. This was unfixable in principle until L8, because a durable feed needs a
   key that survives a replay and a bare txid was not one. `(txid, seq)` is that key now.
   Spill the ring to disk, or serve old positions from the log. docs/next.md §3.
2. **The npm release**, which is blocked on Tim and not on you: `NPM_TOKEN` in the repository
   settings, then set `version` and push a `v` tag. Everything else is built and has never
   run. Do not attempt it; remind him it is one secret away.
3. **`@bql/sqlite-*` prebuilt libraries.** docs/c6-packaging.md §6. Removes the C-compiler
   requirement for consumers, and L7 just proved the tarball builds its own engine.
4. **Re-measure docs/performance.md §5's worker ladder** — it still describes the *old*
   defaults and could not be retaken on a noisy machine. §8 says how to tell whether the
   machine is quiet enough. Do it only when it is.

## Non-negotiables

- Zero runtime dependencies. Never import bun:sqlite in src/ (tests and bench/driver.ts may).
  Every module header states its invariant; keep it true when you touch one. P4 is where this
  rule gets tested — the answer is to refuse the milestone, not to relax the rule.
- A new /v1 route is an entry in src/server/registry.ts, never a hand-written line in
  createApp. New error codes go in docs/api.md and the OpenAPI document, and
  `bun run routes:check` must pass.
- docs/design.md is the design of record and docs/api.md is the as-built reference. A phase-3
  item that turns out not to exist gets **removed** from design §11 rather than left there for
  the next reader to believe.
- Tests in test/<area>/, temp dirs under os.tmpdir(). Test the externally visible guarantee.
  Before claiming a test proves something, run it against a tree with the fix removed and
  check it fails — two tests this session passed against the bug they were written for.
- Delegate implementation milestones to Opus subagents with a long precise brief; verify each
  one yourself before the next starts. docs/next.md, "How the work is run".

## Gates — all green before anything is called finished

    bun test                              baseline today: 1530 pass, 2 skip, 0 fail, 133 files, ~50s
    bun test  with BQL_WAL_NATIVE=0     proves the JavaScript WAL-checksum fallback
    bun run typecheck
    bun run bytes                         from the repo root
    bun run routes:check
    bun run pack:check                    L7's gate: packs, installs, builds SQLite, smokes it
    bun run bench --only driver           P1 must not move the 100-row scan by more than 2%

This machine is rarely quiet — it ran at load 4 to 11 for the whole L-track session with
`mobileassetd` at 116% of a core. Check `uptime` before trusting a number, interleave A-B-A-B,
and read docs/performance.md §8 first. Reporting "this could not be resolved on this machine"
is a result; reporting a number you could not resolve is not.

Report what actually happened. If a measurement says a milestone is not worth building, say so
and delete its line from the design. If a plan's premise turns out to be false, write that down
the way L6 and R9 did. When a milestone lands, record its deviations in docs/p<N>-<name>.md and
update docs/next.md's "Where things stand".

Start with P0. Nothing else begins until docs/plan-phase3.md says what the other four are.
```

---

## Why P1 and P4 are written to be refusable

Not pessimism — both were checked against the tree on the day this was written.

**P1.** `src/sqlite/database.ts:144` is `#cache = new Map<string, Statement>()`, and :279-295 is an
LRU touch-and-insert around it. A prepared-statement cache keyed by SQL text is what design §11's
"query-plan cache" describes. `../../docs/timeseries-assessment.md` reached the same conclusion
independently. If a second one is built without measuring the first, the result is two caches and
a coherence bug.

**P4.** `grep -ri "encrypt\|cipher" src/` returns nothing, so there is no partial implementation to
finish — and the two real SQLite answers are a dependency (SQLCipher, which is a fork of the
amalgamation `scripts/sqlite.ts` pins by hash) or a commercial licence (SEE). Meanwhile the WAL,
the log segments, the snapshots and the S3 objects are all separate plaintext paths. A design that
covers all of them may exist; one that covers the main database file only is worse than nothing,
because it reads as a security property that is not there.

If either turns out to be worth building after the measurement, that is the plan's call to make —
made on evidence, which is the point of P0.
