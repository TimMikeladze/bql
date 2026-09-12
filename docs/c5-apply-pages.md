# C5 — replica apply mechanism A (page apply)

Phase-2 milestone 5 (`docs/plan-phase2.md` C5), design §4.5. Written 2026-09-12, **before any
code**, because this is the most correctness-sensitive milestone left and the decision worth
getting right is not "write pages instead of frames" — that part is obvious — but **which locks,
in what order, what a reader mid-transaction sees while it happens, and what the applier does when
it loses the race.**

Everything in §3 was measured with two probes before a line of `src/` changed. They are quoted
inline; the interesting ones are reproduced by `test/wal/apply-pages.test.ts`.

## 1. Why

Two measurements point here, and mechanism A moves both.

**The replica read leg is 48.1 µs** (`bun run bench/wal.ts`, p50). It is not the read: a point read
on this machine is 0.79 µs in the driver. It is mechanism B's shm invalidation — B appends the
primary's pages to the replica's *own* `-wal` and then zeroes the 136-byte wal-index header, so the
next reader runs SQLite's recovery and rebuilds the index by walking every frame in the WAL. That
cost grows with the WAL and is paid by *readers*, which is the wrong side of the ledger on a node
whose whole job is serving reads.

**The replica apply leg pays SQLite's WAL frame checksum.** `encodeFrame` checksums the 24-byte
frame header and the whole 4 KiB page for every page it ships. `docs/performance.md` §3.6 measured
that loop at **5.16 µs per page** on the primary's tailer and proved it memory-bound rather than
overhead-bound: an allocation-free rewrite moved 7.25 µs to 7.21 and was reverted. The replica pays
the same 5 µs, on a page it has just decompressed. Mechanism A writes no frames, so it does not
compute the checksum at all.

It does **not** change the primary. `docs/performance.md` §3.6 names two levers for the write
path's four touches per page — "apply mechanism A **and** capturing pages from SQLite directly".
This is the first. The primary still tails its own WAL and still checksums each page as it reads it
back; that is the second lever and it is not this milestone. Saying otherwise would be the kind of
unmeasured claim this file exists to avoid.

## 2. What A is

Design §4.5:

> Replica keeps `main.db` with an empty `-wal`. Per TxnRecord: verify `prevTxid == local txid` and
> `epoch >= local epoch` (fencing); take the WAL lock set (WRITE, CKPT, RECOVER, READ0..4) through
> SQLite's own VFS — `file_control(SQLITE_FCNTL_FILE_POINTER)` gives the `sqlite3_file*`, and its
> `xShmLock` is the same routine SQLite uses, so in-process and cross-process readers are both
> respected; `pwrite` each page into the file, `ftruncate` to `commitSize`, verify `postChecksum`,
> rewrite the 136-byte `-shm` header … release locks, ACK.

The one place the design is amended: **verification happens before anything is written, not after.**
That is already true of mechanism B (`src/wal/applier.ts`, second invariant) and it is strictly
safer — a record that does not reproduce the replica's own pre-images leaves the replica byte for
byte as it was, rather than leaving it half-written and then complaining.

**The invariant A adds: a replica's `-wal` is always zero bytes.** The database file is the whole
state. Everything else follows from it — there are no frames to rescan, no `nBackfill` to reset,
no replica-side checkpoint to schedule, and `computeFull(dbPath, { includeWal: false })` is a
complete oracle at any moment the applier is not inside `apply`.

## 3. What was measured before deciding

M5 Pro, macOS 26.6.2, Bun 1.4.0, vendored SQLite 3.53.4.

**`xShmLock` is reachable, and it is the real one.** `sqlite3_file_control(db, "main",
SQLITE_FCNTL_FILE_POINTER /* 7 */, &pFile)` returns `SQLITE_OK` and yields a `sqlite3_file*`. Its
`pMethods` reports `iVersion == 3`, so the version-2 shm methods are present, and `xShmLock` sits
at byte offset 112 of `sqlite3_io_methods` on a 64-bit target (`int iVersion` plus four bytes of
padding, then thirteen pointers). `bun:ffi`'s `read.ptr` walks it and `CFunction` calls it.

**It respects an in-process reader, which is the whole question.** With a second connection in the
same process holding an open read transaction, `xShmLock(pFile, 0, 8, SQLITE_SHM_LOCK |
SQLITE_SHM_EXCLUSIVE)` returns **`SQLITE_BUSY` (5)**. The moment that reader commits, the same call
returns `SQLITE_OK`. This is the property that makes A safe and the one a hand-rolled `fcntl` on
the `-shm` file would *not* have: POSIX byte-range locks are per process, so a lock taken on our
own descriptor would be invisible to a reader in the same process and would be dropped by any
`close()` of any descriptor for that file. Going through the VFS gets `unixShmNode`'s in-process
bookkeeping for free.

**A page apply is visible to a reader that was already open.** A reader opened *before* the apply,
having already run a query, sees the new row on its next statement, and `pragma integrity_check`
answers `ok`. The `-wal` stays 0 bytes. That is the pager dropping its page cache because the
wal-index header changed, exactly as §4.5 predicted.

**The lock choreography is nearly free.**

| | p50 | p99 |
|---|---|---|
| `xShmLock` exclusive 0..8, lock + unlock | **0.542 µs** | 0.666 µs |
| wal-index header rewrite, 3 `pwrite`s | 1.666 µs | 2.250 µs |
| mechanism B's shm zero, 1 `pwrite` | 0.583 µs | 0.958 µs |
| `pwrite` one 4 KiB page | 0.708 µs | 0.917 µs |

So A costs about **1.6 µs more per apply than B** in lock and header work, against a 48 µs read leg
and a ~5 µs per-page frame checksum. The header rewrite drops to two `pwrite`s in the
implementation (§4.3) — measured again afterwards at **1.125 µs p50**, so the whole added cost is
about 1.1 µs.

## 4. The decision

### 4.1 Which locks, and in what order

**All eight slots, in one call: `xShmLock(pFile, 0, 8, SQLITE_SHM_LOCK | SQLITE_SHM_EXCLUSIVE)`.**

SQLite names them `WAL_WRITE_LOCK` 0, `WAL_CKPT_LOCK` 1, `WAL_RECOVER_LOCK` 2 and
`WAL_READ_LOCK(0..4)` 3..7 — `SQLITE_SHM_NLOCK` is 8 and the set is exactly the WAL lock set.

There is no order to get right, and that is the point. SQLite's own rule — recovery, then
checkpointer, then writer, then readers — exists to stop a caller that *escalates* one lock at a
time from deadlocking against a caller escalating in the other direction. A single `xShmLock` over
the whole range is taken or refused atomically inside `unixShmLock`, so the applier never holds a
partial set and never has anything to deadlock on. `assert( n==1 || lockType==_SHM_EXCLUSIVE )` in
`unixShmLock` is the permission to do it in one call; SQLite itself takes `WAL_ALL_BUT_WRITE` over
`WAL_NREADER+1` slots the same way.

Why each of the eight is needed, rather than only the read locks:

| slot | why the applier must hold it |
|---|---|
| WRITE (0) | a replica has no writer today, but a **promoted** one does (C2), and the promotion is a config change rather than a restart. Holding it means the day a writer exists it is already excluded. |
| CKPT (1) | a checkpointer backfilling frames into the database file while we are writing pages into the same file would interleave two ideas of what the file holds. A has no frames to backfill, but `POST /v1/db/{db}/checkpoint` and the idle sweep can still reach a replica. |
| RECOVER (2) | a reader that caught a torn header (§4.4) runs `walIndexRecover`, which rebuilds the index from the WAL. We are in the middle of declaring that WAL empty. |
| READ 0..4 (3..7) | the one that matters: a reader holding any read-mark is mid-transaction on the *old* database file, and mechanism A changes the database file under it. |

### 4.2 What a reader mid-transaction sees

Nothing. That is the answer, and it is enforced rather than hoped for.

- **A reader already in a read transaction** holds a shared lock on its read-mark slot
  (`walTryBeginRead` → `walLockShared(pWal, WAL_READ_LOCK(i))`). The applier's exclusive acquire
  therefore returns `SQLITE_BUSY` and **no page is written**. The reader finishes against the old
  database, correctly and at full speed. Measured in §3.
- **A reader arriving during an apply** cannot take a read mark, gets `SQLITE_BUSY` from
  `walTryBeginRead`, and enters SQLite's own `WAL_RETRY` loop — a scheduler yield for the first few
  attempts, then a growing `sqlite3OsSleep`, bounded by the connection's busy handler.
  `busy_timeout` is already 5000 on every connection BunQL opens. An apply holds the locks for the
  length of §4.3, which is microseconds plus one `fdatasync`.
- **A reader that reads the wal-index header before taking any lock** — which is what
  `walTryBeginRead` does, `walIndexReadHdr` running before the read mark is claimed — can catch a
  half-written header. SQLite has a protocol for exactly this: the header is stored twice, a reader
  reads copy 0 then copy 1 and treats a mismatch as a dirty read, and `walIndexWriteHdr` writes
  copy 1 first and copy 0 second so the mismatch is guaranteed. **The applier writes in the same
  order for the same reason** (§4.3). A dirty read costs the reader a retry, not a wrong answer.
- **After the apply**, the next `walIndexTryHdr` sees a `WalIndexHdr` that differs from the one the
  connection cached, sets `*pChanged = 1`, and the pager resets its page cache and reads the
  database file. `iChange` is the field that guarantees "differs" even when a transaction changed
  neither `nPage` nor anything else in the header.

The one hazard worth naming: a reader with `[sqlite] mmapSize` set has the database file mapped,
and A can `ftruncate` it. A reader never touches a page above `nPage`, no reader is running while
the truncate happens, and the new `nPage` is published in the same critical section — so the
mapping and the header can never disagree in the direction that produces a `SIGBUS`. It is still
the reason `ftruncate` happens **before** the header is rewritten and **inside** the locks.

### 4.3 The apply, in order

Everything from step 3 to step 8 is inside the exclusive lock.

1. `prevTxid == txid`, `epoch >= epoch`, `pageSize` agrees. Unchanged from B.
2. `foldTransaction` against a page source reading the database file: reject on `preChecksum`,
   compute the fold, reject on `postChecksum`. **Nothing has been written and nothing is mutated.**
3. Take the lock set (§4.1), with the backoff of §4.5.
4. `pwrite` each page at `(pgno - 1) * pageSize`, ascending by page number.
5. `ftruncate` to `commitSizePages * pageSize`, and only when the database shrank.
6. `fdatasync` the database file.
7. Rewrite the wal-index header, in two writes so the torn-read protocol of §4.2 holds:
   - **72 bytes at offset 48** — the second `WalIndexHdr` copy (48..95) and the whole `WalCkptInfo`
     (96..119) in one `pwrite`, because they are contiguous.
   - **48 bytes at offset 0** — the first `WalIndexHdr` copy.

   Bytes **120..127 are never written**: they are `WalCkptInfo.aLock`, and the amalgamation says
   "these bytes should never be read or written". Mechanism B zeroes all 136 and gets away with it;
   A does not need to, so it does not. Bytes 128..135 (`nBackfillAttempted`, `notUsed0`) are zeroed
   once, when the applier first takes ownership of the header.
8. Release the lock set.
9. `fold.commit()`, advance `txid`/`epoch`, persist `meta.json`.

The header fields, all **native byte order** (this is shared memory, not a file format):

| field | offset | value |
|---|---|---|
| `iVersion` | 0 | `3007000` (`WALINDEX_MAX_VERSION`) |
| `unused` | 4 | 0 |
| `iChange` | 8 | previous + 1 |
| `isInit` | 12 | 1 |
| `bigEndCksum` | 13 | 0 |
| `szPage` | 14 | page size, or 1 for 65536 |
| `mxFrame` | 16 | **0** |
| `nPage` | 20 | `commitSizePages` |
| `aFrameCksum[2]` | 24 | 0, 0 |
| `aSalt[2]` | 32 | 0, 0 |
| `aCksum[2]` | 40 | `walChecksumBytes` over bytes 0..39, native order, seed 0 |
| `nBackfill` | 96 | 0 |
| `aReadMark[0]` | 100 | 0 |
| `aReadMark[1..4]` | 104..119 | `0xffffffff` (`READMARK_NOT_USED`) |

`mxFrame == 0` with `nBackfill == 0` is the state `walTryBeginRead` short-circuits: "the WAL has
been completely backfilled (or it is empty) and can be safely ignored", take `WAL_READ_LOCK(0)`,
read everything from the database file. The reader never opens the `-wal`. That is the 48 µs.

`aCksum` uses the same `s1 += x[i] + s2; s2 += x[i+1] + s1` chain as the WAL frame checksum but
always reads words in **native** order and seeds from zero — `walChecksumBytes(1, …, 40, 0, …)`.
It is a different function from `codec.ts`'s `checksum`, which takes its endianness from the WAL
magic, so it lives in its own module rather than growing a flag onto that one.

### 4.4 Crash mid-apply, and why A's window is wider than B's

Be direct about this, because it is the one place A is worse.

B writes a record as one `writeSync` of contiguous frames plus one `fdatasync`, and a frame only
counts once the chain reaches its commit frame — so a crash leaves either all of a transaction or
none of it. A writes pages at scattered offsets, so a crash between the first and last `pwrite`
leaves the database file **torn**: some pages at txid N, some at N-1.

The overwhelmingly likely shape of that crash is not a half-written page set at all — the
`pwrite` loop is microseconds — it is the gap between the `fdatasync` of the pages and the rename
of `meta.json`. There the file is fully at post(N) and the position says N-1.

- **Detection** is the existing checksum chain and it is loud. On restart `meta.json` says N-1, the
  primary re-sends N, and `foldTransaction` reads pre-images that are *already the new images* — so
  the fold produces `preChecksum` rather than `postChecksum`, `ChecksumMismatch` is thrown before
  anything is written, and today that means "send me a snapshot".
- **Resume** turns that case back into "continue", and **without writing anything**. When the
  first apply after opening an applier fails a checksum check, the applier asks a positive
  question: *is every page this record carries already in the database file, byte for byte, and is
  the file already `commitSizePages` long?* Only a completed apply of this very record looks like
  that. If it does, `computeFull(dbPath, { includeWal: false })` is run and must equal the
  record's `postChecksum`; then the record is adopted. Otherwise `ChecksumMismatch` is thrown
  exactly as before.
- **The oracle is the whole database, not the record.** A resume that succeeds has proved every
  page of the replica against the primary's rolling checksum, which is a stronger statement than a
  clean apply makes.
- **A genuinely torn file is not resumed.** Some pages match and some do not, the positive test
  fails, and the replica re-snapshots — which is the right answer and costs nothing in safety.

The guard is narrow by construction: mechanism A only, only before any record has applied cleanly
on this applier, once, and only for a record whose `prevTxid` and `epoch` already checked out. Cost
on the happy path: one boolean. Cost on the crash path: one page-compare of the record's own pages,
and at most one full scan of the database file.

Because resume writes nothing, **the applier's "verify before writing" invariant holds on every
path, crash included.** The honest summary is: **A trades a wider crash window, detected loudly and
usually resumed, for a 48 µs read leg.** `apply = "wal"` (§5) is how a deployment declines that
trade.

### 4.5 What the applier does when it loses the race

`xShmLock` returns `SQLITE_BUSY` when a reader is mid-transaction. The applier:

- **Retries with a bounded backoff** — 1 ms, doubling with jitter to 32 ms, until
  `[replication] applyBusyMs` (default 5000, the same figure as `busy_timeout`) is spent.
- **Then throws `ApplyBusy`**, a new `WalError` whose whole purpose is to be *distinguishable from
  divergence*. `ChecksumMismatch` means "send me a snapshot". `ApplyBusy` means "nothing was
  written, the position has not moved, offer me the same record again". `ReplicaClient` treats it
  as backpressure.
- It is raised **before the first `pwrite` of the record**, so the "nothing was written" claim is
  structural rather than a promise. The same error covers one other wait: a replica switching from
  `"wal"` to `"pages"` (§4.7) has to fold its leftover WAL into the database file with a TRUNCATE
  checkpoint first, and a reader can hold that off too.

A replica that cannot get the locks for five seconds has a reader holding a transaction for five
seconds, which is its own problem and one `streamTimeoutMs` already bounds for streamed results.
Refusing to apply is the right answer: the alternative is writing under a live reader.

### 4.6 Falling back

A needs `xShmLock`. If `sqlite3_file_control` refuses `SQLITE_FCNTL_FILE_POINTER`, or `pMethods`
reports `iVersion < 2`, or the VFS has no shm (a read-only mount, or unix's `bProcessLock` path
where the wal-index lives in process-private memory and a `pwrite` to `-shm` would be invisible),
the applier **falls back to B and says so once**, rather than failing the node. Design §4.5 already
asks for this — "keeps B as the fallback for filesystems where `xShmLock` misbehaves". `apply =
"pages"` therefore means *prefer* A; `applier.mechanism` reports which one is live, and
`GET /v1/db/{db}` carries it so an operator can see that a replica quietly took the slow path.

### 4.7 Switching between the two

A requires an empty `-wal`. An applier opening in mode `"pages"` on a database whose `-wal` is
non-empty — a replica that ran B until the config changed — **TRUNCATE-checkpoints it through its
own connection first**, which folds B's frames into the database file and leaves the WAL at zero
bytes. Going the other way needs nothing: B's `#ensureWal` already handles "no usable WAL" by
starting a fresh one with new salts.

The replica-side checkpoint policy in `tenant.ts` (`maintain`, `close`, `checkpoint`) is already
guarded by `walBytes > WAL_HEADER_SIZE`, which is never true under A, so those call sites become
no-ops without being touched. `applier.checkpoint()` under A answers
`{ busy: false, log: 0, checkpointed: 0 }` — a truthful report about an empty WAL, not a refusal.

## 5. Config

```toml
[replication]
apply = "pages"       # BUNQL_REPLICATION_APPLY. "pages" = mechanism A, "wal" = mechanism B.
applyBusyMs = 5000    # BUNQL_REPLICATION_APPLY_BUSY_MS. How long an apply waits for the WAL locks.
```

`"pages"` is the default. `docs/c6-packaging.md`'s rule — a setting that changes *meaning* does not
take a new default — does not apply: A and B produce the same database, proved by the same checksum
chain, and `test/wal/replication.test.ts` asserts it without knowing which one ran. What changes is
where the cost falls. `apply = "wal"` is the back-out, and `docs/plan-phase2.md` C5 asks for it by
name so that a bad apply in production is a config change rather than a rollback.

## 6. Files

New:

| file | holds |
|---|---|
| `src/wal/shm.ts` | the wal-index header format — offsets, the native-order checksum, `encodeWalIndexHeader`, `readWalIndexHeader`. Pure functions over `Uint8Array`, the same role `codec.ts` plays for the WAL itself |
| `src/wal/shmlock.ts` | `WalLocks` — resolve `sqlite3_file*` and `xShmLock` from a `Database`, `tryLock`/`unlock`, `available`. The only file in `src/wal/` that touches FFI |
| `test/wal/shm.test.ts` | the header round-trips, and a header this module built is one SQLite accepts without recovering |
| `test/wal/apply-pages.test.ts` | A's own properties: the WAL stays empty, a live reader sees the change, a reader mid-transaction makes the apply `ApplyBusy`, the repair path, the fallback |

Touched: `src/wal/applier.ts` (the strategy split), `src/wal/errors.ts` (`ApplyBusy`),
`src/wal/index.ts` (exports), `src/sqlite/constants.ts` (`SQLITE_FCNTL_FILE_POINTER`, the four
`SQLITE_SHM_*` flags), `src/server/config.ts` (`[replication] apply`, `applyBusyMs`),
`src/tenant/tenant.ts` (pass the mechanism through), `src/replication/replica.ts` (`ApplyBusy` is
backpressure, not divergence), `bench/wal.ts` (measure either mechanism), `docs/design.md` §4.5,
`docs/performance.md` §3.6 and §4F, `docs/api.md`, `docs/next.md`.

**`src/wal/codec.ts`, `src/wal/record.ts`, `src/wal/log.ts`, `src/wal/tailer.ts` and
`src/wal/primary.ts` are not touched at all.** The record format, the checksum chain and the
primary are the contract; A changes only what a replica does with a record it has already verified.

## 7. Tests and verification

The contract is `test/wal/replication.test.ts` and the two e2e replication scenarios. **They must
pass unchanged.** They construct a `WalApplier` with no mechanism named, so with `"pages"` as the
default they now exercise A against the same oracle — `computeFull` and the rolling checksum in
every `TxnRecord` — that proved B. If one of them needs editing, the contract has moved and that is
a thing to report rather than to edit.

New, beyond the two files above:

- Both mechanisms over the same record stream produce byte-identical databases, asserted with
  `computeFull` rather than with `dump`.
- A replica restarted mid-stream resumes and converges.
- A replica whose file was torn by hand mid-apply either repairs or raises `ChecksumMismatch`, and
  never continues quietly.

By hand: a real primary and a real replica over a socket, including a replica restarted mid-stream
and one forced to re-snapshot; `bun test`, `bun run typecheck`, `bun run bytes`,
`bun run routes:check`; and `bun run bench --only wal` on both mechanisms, reporting the replica
read leg.

## 8. As built

Built 2026-09-12. `bun test` → **1361 pass, 2 skip, 0 fail** across 109 files (1346 before);
`bun run typecheck`, `bun run bytes` and `bun run routes:check` clean.

**The result.** `bun run bench/wal.ts each pages` against `… each wal`, 500 transactions of five
rows, p50 µs, reproduced across runs:

| leg | B (`"wal"`) | A (`"pages"`) | |
|---|---|---|---|
| replica apply, incl. `fdatasync` | 196.1 | **161.8** | −34 µs |
| **replica read sees the row** | **47.2** | **6.4** | **7.4x** |
| end to end | 290.8 | **210.8** | −27% |

The apply leg fell as well as the read leg, which §1 predicted for a reason worth restating: A
computes no WAL frame checksums, and that is the same memory-bound 5 µs per page
`docs/performance.md` §3.6 measured on the primary's tailer.

**Four things came out differently from the plan, and three of them are smaller:**

- **The crash-resume path writes nothing.** §4.4 as first written had it re-write the record's
  pages and then check `computeFull`. Writing a *tampered* record's pages is exactly what
  `test/wal/replication.test.ts` forbids — "a record whose pages do not produce its postChecksum is
  refused before anything is written" — and it caught it on the first run. The fix is better than
  the plan: ask the positive question instead (*is every page of this record already in the file,
  byte for byte?*), which only a completed apply of that record can answer yes to, and then adopt
  after `computeFull`. "Verify before writing" now holds on every path, crash included. §4.4 was
  rewritten to match.
- **The wal-index header rewrite is two `pwrite`s, not three**, because the second `WalIndexHdr`
  copy (48..95) and `WalCkptInfo` (96..119) are contiguous: **1.125 µs p50** against the 1.666 the
  three-write version measured. Bytes 120..127 are never written.
- **`ApplyBusy` covers one more wait than §4.5 described**: a replica switching from `"wal"` to
  `"pages"` folds its leftover WAL away with a TRUNCATE checkpoint, and a reader can hold *that*
  off too. Same answer — nothing written, retry the record.
- **The fallback is announced.** `WalApplierOptions.warn` (default `console.warn`) prints one line
  naming the reason when `"pages"` degrades to `"wal"`, and `GET /v1/db/{db}` carries `"apply"` on
  a replica, so a node quietly on the slow path is visible rather than inferred.

**What had to change in an existing test, and why.**
`test/wal/replication.test.ts` was to pass unchanged. One assertion in it could not:
`"a replica checkpoint mid-stream does not break the stream"` asserted
`walBefore > 1000` — that the *replica's own WAL* had grown to something worth checkpointing.
That is mechanism B's shape, not the contract the test is named for. **The contract did not move;
the scaffolding was mechanism-specific.** It is now `test.each(["wal", "pages"])` over the same
body, asserting WAL growth under `"wal"` and zero under `"pages"`, so B's path keeps its coverage
and A gains it. Every other test in that file, and both e2e replication scenarios, pass untouched.

**Verified by hand**, a real primary and a real replica over a socket:

- 50 writes: replica at the primary's txid and checksum, `walBytes: 0`, `"apply": "pages"`.
- `kill -9` on the replica **mid-stream** while 150 writes were in flight: it came back, caught up
  to txid 201, identical checksum, 200 rows, nothing logged.
- One page of the replica's database file scribbled over by hand while it was down, then one write
  on the primary: `ChecksumMismatch` (phase `post`) raised loudly, the stream re-subscribed, the
  replica **re-snapshotted** and converged — `computeFull` on the two files identical,
  `pragma integrity_check` `ok`, `-wal` still 0 bytes.
- `BUNQL_REPLICATION_APPLY=wal` on the running replica: back-out works, reports `"apply": "wal"`,
  stays in step. Restarting it back on `"pages"` over the WAL B had left folded it away and carried
  on.

**What is still true after this milestone:**

- The primary's tailer is unchanged. The 7.25 µs WAL tail and the ~5 µs page checksum inside it are
  a separate lever — capturing pages from SQLite directly (`docs/performance.md` §3.6).
- `sqlite3_file_control(SQLITE_FCNTL_FILE_POINTER)` and a raw call through `pMethods->xShmLock` are
  the only FFI in `src/wal/`, and they live in one file (`src/wal/shmlock.ts`) behind `tryLock` /
  `unlock`. A platform where that resolution fails gets mechanism B and a warning, not an error.
- Windows is untested. The wal-index layout is the same (`winShmLock` takes the same eight slots)
  and the code reads `iVersion` before it trusts the method table, so the worst case is the
  fallback — but nothing here has run on it.
