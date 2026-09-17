# P8 — a consistent read across requests, on the mechanism §11 did not name

Written 2026-09-16, after re-running `experiments/snapshot.ts` on this machine. The plan of record
is `docs/plan-phase3.md` §P8, which had already been revised once by that spike; this file is what
building the surface on top of it found.

## 1. The answer first

**The caller design §11 wanted is real. The mechanism it named loses on measurement, and the
milestone is a route layer over R10.**

Three sentences, because the third is the one that is new:

- `sqlite3_snapshot` is **refused** — measured, re-measured here, and left bound and unwired with a
  comment at `src/sqlite/lib.ts` saying so.
- The consistent read ships as **`POST /v1/db/{db}/read`**, on `Tenant.readTxBegin` /
  `ServerRuntime.beginReadTx` exactly as R10 built them. **No engine code changed.** R10's bounds
  carry over untouched and **no error code was added**, which §5 argues is the right outcome rather
  than a corner cut.
- `docs/r10-read-transactions.md` §4 declined this surface because "the native surface's
  consistent-read answer is `BunQL-Min-Txid`". **That is wrong, and this milestone overturns it.**
  `BunQL-Min-Txid` (`src/server/exec.ts:262-263`) is a *floor* — "do not answer until the tenant has
  reached txid N" — so two reads that both satisfy it can see different databases, because the
  second sees everything that landed in between. A read session is a *point*. A floor is not a
  point, and no amount of the first adds up to the second.

One thing building it found that neither document anticipated: **a write inside a read session had
to be refused explicitly, and without that refusal it lands** (§4). That is the only new logic in
the milestone and it is a correctness fix, not a surface.

## 2. The spike, re-run

`experiments/snapshot.ts`, on this machine, in about four seconds. Both questions reproduce exactly
as `docs/plan-phase3.md` records them.

**Every checkpoint mode invalidates a snapshot handle, PASSIVE included.** 769 is
`SQLITE_ERROR_SNAPSHOT`:

| after | `sqlite3_snapshot_open` | |
|---|---|---|
| no checkpoint | `0` | valid |
| PASSIVE | `769` | invalid |
| FULL | `769` | invalid |
| RESTART | `769` | invalid |
| TRUNCATE | `769` | invalid |

A handle held outside a read transaction has no read mark, so SQLite does not know to protect it
and backfills straight over it. Keeping one alive means suppressing *all* checkpointing, by hand,
for the session's lifetime.

**And that buys nothing.** 3 000 writes, autocheckpoint off as a BunQL tenant has it:

| | isolation holds | WAL after 3 000 writes |
|---|---|---|
| **A** — held read transaction, PASSIVE checkpoint every 200 writes | yes | **12 304 KiB** |
| **B** — snapshot handle, every checkpoint suppressed | yes | **12 304 KiB** |

Identical to the kilobyte, because a PASSIVE pass cannot backfill past the oldest read mark either.
The snapshot API buys one pooled reader connection — ~17 µs to open, and a handful of descriptors.

### The four reasons it is refused

1. **It is absent on every distribution libsqlite3.** No distro ships `SQLITE_ENABLE_SNAPSHOT`
   (`docs/c6-packaging.md` §1); only the vendored build has it (`scripts/sqlite.ts:63`). The
   read-transaction path has to exist anyway, for the majority of installs.
2. **It is wrong on a replica.** Under `[replication] apply = "pages"` the applier `pwrite`s pages
   straight into the database file and keeps a zero-byte `-wal` (`src/wal/applier.ts`,
   `docs/c5-apply-pages.md`). There is no old version of a page for a snapshot to name. A read
   transaction works there, and works *because* the lease makes the applier answer `ApplyBusy` and
   back off — which `test/server/read-session-replica.test.ts` now asserts directly.
3. **It means hand-rolling read-mark protection**, in a node that would then have two mechanisms
   pinning the WAL — SQLite's and BunQL's — that must agree. Getting that wrong is a torn read.
4. **It would need its own bounds**, its own metric and its own expiry, duplicating `maxReadTx`,
   `readTxTimeoutMs` and `TX_BUSY`, which exist and are tested.

`sqlite3_snapshot_*` therefore stays bound and unused. The bindings now carry a comment
(`src/sqlite/lib.ts`) pointing at the spike and at this file, because dead bindings with no
explanation read as unfinished work to the next person — which is the whole reason this milestone
has the shape it does.

*(One thing the spike does not settle, recorded so nobody claims it was: whether a checkpoint policy
aware of open read marks could let a snapshot outlive a PASSIVE pass. It could not without BunQL
writing read marks into the wal-index for readers that do not exist, which is the same class of
trick E2 spent a session undoing on Windows.)*

## 3. What shipped: a read session on `/v1`

| | |
|---|---|
| `POST /v1/db/{db}/read` | open one. `{ read, expiresInMs, idleTimeoutMs }` |
| `POST /v1/db/{db}/read/{read}` | one statement in it |
| `DELETE /v1/db/{db}/read/{read}` | end it |

Scope is `ro`, not `rw` — it takes no writer, so requiring `rw` would be asking for a permission it
does not use. `GET /v1/db/{db}` gained `readSessions`.

Three deliberate departures from the writer transaction's shape, each because a read session is a
different thing rather than a variant of one:

**No `mode`.** `deferred` / `immediate` / `exclusive` are ways of taking the writer. There is one
way to take a reader.

**`DELETE`, not `commit` and `rollback`.** A read session has nothing to commit, and `endReadTx`
rolls back whatever it did. Offering two verbs would be two names for one act, and a client that
chose `commit` would reasonably expect it to mean something.

**It never forwards.** A writer transaction on a replica has its whole baton lifecycle on the
primary and the replica only holds the mapping. A read session is served by the node it was opened
on, on both roles — which is the point, and the case a snapshot handle could not have served at
all. `test/server/read-session-replica.test.ts` asserts it by watching the replica's own
`readSessions` rise to 1 while the primary's stays at 0.

The bounds are R10's, unchanged and untouched: `[limits] maxReadTx` = 16 per database
(`409 TX_BUSY` with `Retry-After: 1` at the bound), `[limits] txIdleTimeoutMs` = 5 s,
`[limits] readTxTimeoutMs` = 30 s. `readSessions` counts both surfaces, because the `/v1` routes and
Hrana's read transaction are one mechanism against one bound — a client refused `TX_BUSY` on one of
them wants to see the other's share.

### The caller, which is why it exists

Keyset pagination across requests, and it is not a decoration on the milestone — a mechanism with
no caller is exactly what r10 §4 declined and what `docs/prompt-phase3.md` warns against. Without a
session each page is its own snapshot, and a concurrent writer breaks the scan in a way the client
cannot detect:

- a row **inserted** below the cursor is silently skipped;
- with any sort key that is not immutable — `order by updated_at, id` being the usual one — a row
  **updated** between pages moves and is duplicated, or moves and is skipped.

Inside a session the set and the order are fixed for the whole scan, so neither can happen whatever
the key is. `docs/api.md` §"Read sessions" carries the loop a client writes.

The test drives 300 rows in pages of 50 over a compound mutable key, moving ten already-read rows
past the end and ten unread rows to the front between every page. Inside a session it reads exactly
`1..300`, once each. **The same loop on per-request snapshots is the control in the same file**, and
it reads 740 rows for 300 — so the test cannot pass by accident.

## 4. What building it found: a write inside a read session lands

This is the one piece of new logic, and it was not in either plan.

A pooled reader is **not** opened `SQLITE_OPEN_READONLY` — `Tenant.acquireReader` opens it
`{ writer: false }`, which only means it is not *the* writer connection — and `applyPragmas` sets no
`query_only`. So nothing under the route stops a write. Hrana already knew this and calls
`assertReadOnly` before every statement in a read transaction (`src/server/hrana/execute.ts:100`).
The `/v1` route had to do the same, and `executeInReadTx` does not do it for either of them.

Measured, with the guard removed:

| the write | what happens |
|---|---|
| after the session has read | `503 BUSY`, "database is locked" — SQLite refusing to promote a deferred read transaction. A misleading answer, but an answer |
| as the session's **first** statement | **`200`, `rowsAffected: 1`.** It writes |

The second row is the hazard. Before the first read there is no read transaction to promote, so the
insert simply succeeds — on a pooled reader, outside the tenant's writer and therefore outside the
WAL tailer, the log, the change feed and replication. On a replica it is a row the primary has never
heard of and never will. Under `apply = "pages"` the replica answered `200` to exactly that write.

So `readQuery` compiles the statement on the **session's own** connection and refuses a
non-`sqlite3_stmt_readonly` one with `403 SQLITE_READONLY`. On the session's connection rather than
the writer's because the writer may be busy with somebody else's write, which is the point of the
move.

`test/server/read-session.test.ts` pins both rows, on a fresh database, because a warm one hides the
dangerous case behind a lock.

### What it costs, and where the cost actually is

The guard runs inside an `applyPolicy(...)` / `handle.release()` pair, and `release` calls
`AuthorizerHub.setBase(null)`. For a token-authenticated principal that is a real
`sqlite3_set_authorizer` call, which **expires every statement prepared on that connection** — so
the execution that follows recompiles inside `sqlite3_step`. **BunQL's cache still records a hit**;
the `Statement` comes back from `Database.#cache` untouched, and SQLite recompiles behind it
anyway. That is `docs/p7-plan-cache.md` §4's finding, and an earlier draft of this section had it
backwards.

Measured here, 20 000 iterations of `prepare` + `step` of a point read on one connection with a warm
cache:

| | per statement |
|---|---|
| admin principal — the authorizer is never touched | **0.777 µs** |
| token principal, one `applyPolicy`/`release` pair (execution alone) | **2.264 µs** |
| token principal, two pairs — the guard, then the execution, which is what ships | **2.281 µs** |

87 999 cache hits and 1 miss across the run, while every token row above was recompiling: the hit
count is not evidence SQLite did not recompile.

Two things follow, and the second is the one that surprised me.

**The ~1.5 µs is not the guard's.** It is what *any* token-authenticated statement on this path
pays, read session or not — P7 §4 found it on the write path. An admin principal pays none of it:
`AuthorizerHub.#sync` makes no FFI call at all when nothing is installed and nothing is wanted, so
`setBase(null)` against an empty hub is genuinely free.

**The guard's second cycle-pair costs 0.017 µs.** It really is a second pair — the guard's
`release()` deletes `appliedPolicy`'s memo (`src/server/auth.ts:978-984`), so `executeInReadTx`'s
`applyPolicy` is a full miss rather than the early return at `:984`, and four
`sqlite3_set_authorizer` calls happen where two would do. But the recompile is **lazy**: it happens
once, inside `step`, and expiring an already-expired statement costs nothing. So the extra pair buys
two FFI calls and one `sqlite3_stmt_readonly`, and that is all it costs. The guard's own
`db.prepare` is a cache hit that touches SQLite not at all (`src/sqlite/database.ts:329-336`).

### The follow-up, named so it is not rediscovered

The separate `prepare` **can** go, and it should — but not for speed, because there is none to win.
`step()` already computes `const writes = !stmt.readonly` (`src/server/exec.ts:197`) on the very
statement it is about to run, so the guard is asking a question the execution path answers 40 lines
later. What it would take: a "refuse a write" flag on `executeInReadTx`, or on `step` itself, so the
check reads off that statement instead of preparing its own. That also removes the memo miss and
takes the four authorizer calls back to two.

The real argument for doing it is duplication, not µs: Hrana's `assertReadOnly`
(`src/server/hrana/execute.ts:100`) is the same check written a second time, and `executeInReadTx`
is the one place both surfaces already pass through. One guard there would mean no future surface
built on `readTxExec` can forget it — which, given §4 is a hazard neither R10 nor
`docs/plan-phase3.md` names, is the failure mode worth designing against. **Not done here**: the
surface is verified and this would churn it.

## 5. No new error code, and why that is the answer

`docs/plan-phase3.md`'s "New error codes" table lists `READ_SESSION_EXPIRED` (410) for P8. **It was
not added**, and the same section of the plan says that is the better outcome if the expiry does not
need distinguishing from a bad baton. It does not, for two reasons and the second is decisive.

**A caller does the same thing either way.** Expired and never-existed both mean "you cannot
continue; open a new session and start again". There is no third behaviour for a 410 to unlock.

**The server cannot tell them apart without new state.** `#forgetReadTx` deletes the map entry, so
once a session is over there is no record it ever existed. Answering 410 would mean a tombstone per
expired baton — a map that grows with every session, needing its own bound, its own sweep and its
own configuration, to change a status code that changes no client behaviour. That is a worse trade
than the one it fixes.

`404 TX_NOT_FOUND` therefore answers an expired session, an ended one and a baton that never
existed, and `docs/api.md` says so in those words rather than leaving a client to discover it.

## 6. The tests, and what each said with its mechanism removed

`test/server/read-session.test.ts` (12) and `test/server/read-session-replica.test.ts` (3). Each
removal was done in a copy of the tree under the scratch directory, never in the working tree, since
two other milestones are editing it.

| removed | what failed, and what it said |
|---|---|
| `BEGIN DEFERRED` from `Tenant.readTxBegin` (`"select 1"` instead) | **5 failed.** Both isolation cases, on the primary and on both replica mechanisms: `Expected: 1, Received: 2`. And the pagination scan read **740 rows for 300** — `Expected: 300, Received: 740` |
| the `maxReadTx` check in `ServerRuntime.beginReadTx` | **1 failed.** The seventeenth session: `Expected: 409, Received: 200` |
| `assertReadOnlyStatement` from `readQuery` | **3 failed.** The first-statement write: `Expected: 403, Received: 200` — it wrote. The after-a-read write: `Expected "SQLITE_READONLY", Received "NOT_AUTHORIZED"`. And on the replica, `Expected: 403, Received: 200` |
| `maxMs: readTxTimeoutMs` from `beginReadTx` | **1 failed.** The expiry: `Expected: 404, Received: 200` |
| `readSessions: tenant.openReadTx` from `statsOf` | **2 failed.** The counter test and the replica's served-locally test: `Expected: 2, Received: 0` and `Expected: 1, Received: 0` |

The first two are the removals `docs/r10-read-transactions.md` §5 names, and they bite here as it
says they do.

## 7. Done when — against `docs/plan-phase3.md`'s P8 criteria

| the plan asked | |
|---|---|
| a consistent read across several HTTP requests on `/v1`; a write between request one and request three invisible inside and visible outside, one test both halves | **yes.** `test/server/read-session.test.ts`, "a write committed between request one and request three…" — three requests in the session, the write outside between them, both assertions on the same page |
| the same test against a **replica** | **yes**, and on both apply mechanisms. Mechanism B shows both halves at once; mechanism A shows the applier *deferring* and then catching up when the session ends, which is the documented behaviour and the reason the case works at all |
| the seventeenth session on one database is `409 TX_BUSY` | **yes**, with `Retry-After: 1`, and ending one makes room |
| a session past `readTxTimeoutMs` is gone and its next statement says so | **yes**, against a *busy* session — a statement every 50 ms — so the wall under test is unambiguously `readTxTimeoutMs` and not the idle leash |
| the paginated read is correct under a concurrent writer | **yes**, 300 rows exactly once over a compound mutable key, with the per-request-snapshot control in the same file reading 740 |
| `docs/p8-read-sessions.md` records both spikes with numbers, the refusal and its four reasons, and the surface | this file, §2 and §3 |
| design §11's phase-3 row loses the `sqlite3_snapshot` bullet, P7's pattern | **yes**, with the paragraph below P7's |
| `src/sqlite/lib.ts:176-179` says why it is bound and unused | **yes** |
| every route in `src/server/registry.ts` and `docs/api.md`; `routes:check` passes | **yes**, 52 routes |
| each test run against a tree with the mechanism removed, and seen to fail | **yes**, five removals, §6 |
| a new error code only if the expiry needs distinguishing | **none added**, §5 |

## 8. What contradicts the plan, and what it overturns

**`docs/r10-read-transactions.md` §4 is now wrong** where it says the native surface needs no read
mode because `BunQL-Min-Txid` is its answer. `docs/api.md`'s replica section repeated that sentence
and has been corrected in place rather than deleted, because it is the contract this milestone
changed. R10's reasoning was right about read-your-writes, which is what it was actually deciding;
it was extended to a question it had not measured.

**`docs/plan-phase3.md`'s "New error codes" table still lists `READ_SESSION_EXPIRED` (410) for P8.**
It was not added, for the reasons in §5 — which the plan's own P8 section anticipates and calls the
better outcome. The table row is the optimistic half of a conditional the prose resolves the other
way; it should lose the row.

**The plan says "`ServerRuntime.beginReadTx/readTxSession/endReadTx` … are the whole engine and are
unchanged".** True — they are. But it also implies the route layer is only wiring, and §4 is the
counter-example: the guard against a write inside a session is real logic that neither R10 nor the
plan names, and without it the surface is a way to write to a replica behind its own applier's back.
Any future surface built on `readTxExec` needs it too; `executeInReadTx` still does not provide it,
which is where it belongs — §4's last subsection says what moving it there would take, and why the
argument is duplication rather than the 17 ns it would save.

**Not done, and named rather than quietly skipped:** there is no read-session helper in
`src/client/`. The caller ships as the documented loop in `docs/api.md` and as the test that drives
it, because `src/client/` was outside this milestone's file set. An SDK method that opens a session,
paginates and always ends it in a `finally` is the obvious next step and would take an hour.

## 9. What it touched

| file | what |
|---|---|
| `src/server/routes.ts` | `readBegin`, `readQuery`, `readEnd`, `assertReadOnlyStatement`; `readSessions` in `statsOf`; three imports |
| `src/server/registry.ts` | the three operations, and `readSessions` on `DbStats` |
| `src/sqlite/lib.ts` | the comment on `SNAPSHOT`: measured, refused, and where to read why |
| `test/server/read-session.test.ts` | new; 12 tests — isolation, pagination and its control, the bounds, the write guard, scope, the counter |
| `test/server/read-session-replica.test.ts` | new; 3 tests — both apply mechanisms, and served-locally |
| `docs/api.md` | the three route rows, the "Read sessions" section with the pagination loop, and the corrected replica paragraph |
| `docs/design.md` | §11 loses the `sqlite3_snapshot` bullet and gains a pointer here |

No file under `src/tenant/`, `src/wal/`, `src/replication/` or `src/realtime/` was touched, and no
configuration key was added or changed.
