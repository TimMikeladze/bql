# M4 — tenants (`src/tenant/`)

Implementation notes for milestone M4 of `docs/plan-phase0.md`. Design authority is
`docs/design.md` §4.2, §4.3, §4.4, §4.7, §5.4, §6.5; this file records what the design left open
and every place the implementation deviates from it.

## Module map

| file | invariant |
|---|---|
| `catalog.ts` | `_system.db` is written after the log, never before, so it can lag but never lead |
| `tenant.ts` | one writer owns commits; a transaction is acknowledged only once its record is in the log |
| `registry.ts` | a tenant with work in flight is never evicted, and a name that fails validation never reaches the filesystem |

## Layout

```
<dataDir>/_system.db                       catalog: tenants, tokens, snapshots
<dataDir>/dbs/<2 hex>/<name>/main.db       tenant database, WAL, shm
                            /log/*.seg     transaction log (M3 TxnLog)
                            /snapshots/    snapshot files + index.json (M3)
                            /meta.json     replica position, written only by a WalApplier
<dataDir>/trash/<name>-<ms>/               a deleted tenant's directory, moved rather than removed
```

The 2-character prefix is the first byte of `Bun.hash.xxHash3(name)` in hex.

## Write path (design §4.3, steps 1–6 minus replicas)

`write(fn, {ack})`:

1. `BEGIN IMMEDIATE` … `fn(writer)` … `COMMIT`, through `db.transaction(fn, "immediate")`.
2. `recorder.poll()` — the M3 `TxnRecorder` tails the `-wal` from the last commit frame and
   assigns `txid = last + 1`.
3. `log.append(record)`.
4. `catalog.savePosition(name, position)`, throttled (below).
5. `ack: "fsync"` → `fdatasync` of the `-wal` descriptor plus `log.flush()`.
6. Commit hooks fire with `{txid, record, bytes}` — the hook point M6 uses. Nothing here imports
   `src/realtime`; M6 wires `tenant.onCommit(e => realtime.afterCommit(Number(e.txid)))` and takes
   `tenant.writer` as the connection its capture hooks attach to.
7. The checkpoint policy runs, then `{result, txid}` is returned.

A transaction that writes no WAL pages produces no record and returns the tenant's current txid,
rather than throwing. That covers the read-only transaction and, less obviously, a transaction
whose statements are writes that match no rows: no pages change, so the recorder sees nothing and
the txid does not advance. Both are tested.

**`ack: "fsync"` is an explicit `fdatasync` of the WAL descriptor**, not `PRAGMA synchronous=FULL`
for that commit and not `SQLITE_FCNTL_SYNC`. The unix VFS does not answer `SQLITE_FCNTL_SYNC` from
`sqlite3_file_control` (it is a pager-internal opcode), and flipping the pragma per commit costs
two extra statements. The guarantee is the same one `FULL` gives for a crash after `write` returns,
which is the whole window the `ack` promise covers. Measured cost: 27 µs → 63 µs a transaction.

**The catalog position is saved at most every 200 ms** (`positionIntervalMs`), not on every
commit, and always on close, checkpoint and snapshot. A row update on `_system.db` is a WAL commit
of its own and cost 60 µs of the 87 µs a write originally took. Nothing depends on it being
current: the position is a fast-start hint, and the reconcile below takes the position from the
log's last record, which carries the WAL position it was tailed at and is always at least as new.

## Read path

`read(fn, {minTxid, waitMs})` is async, because waiting for a txid can only be done by yielding;
`readSync(fn, {minTxid})` is the zero-overhead path and throws `TXID_NOT_AVAILABLE` at once when
the tenant is behind. Both borrow from the reader pool (default 2, opened lazily). A borrow beyond
the pool's size opens a connection that is closed on release rather than failing the read.

Borrows are leased because a TRUNCATE checkpoint and a snapshot both need the exclusive WAL locks
and must not run under an open read transaction (design §4.5, "reader coordination").

## Checkpoint policy (design §4.3)

- `PASSIVE` once the WAL passes `checkpointWalBytes` (4 MB). The size comes from the WAL hook's
  frame count rather than a `stat` on every write — installing that hook is also what turns
  SQLite's own autocheckpoint off (design §4.1).
- `TRUNCATE` once the tenant has been idle for `idleCheckpointMs` (1 s) with no reader lease. The
  registry drives this from one unref'd 250 ms interval over every open tenant, rather than a
  timer per tenant, because a timer that outlives its tenant is a shutdown hazard.
- Both drain the recorder into the log first. "The log has shipped past `mxFrame`" is not a
  comparison to make against a WAL file whose size is a high-water mark: after a restart the file
  keeps its length while `mxFrame` goes back to 1. Draining *makes* the precondition true instead
  of testing for it, and after the write path it is a poll that finds nothing.
- `checkpoint(mode)` is the manual escape hatch of design §6.5.
- One read (`select 1 from sqlite_schema limit 1`) precedes the first checkpoint on a connection
  that has not committed yet. A checkpoint on a connection whose pager has never opened the WAL
  does nothing, and says so in counters that cannot be told apart from an empty WAL — on this
  build `wal_checkpoint_v2` returned `log = 0, checkpointed = 0` from both a real fold and a
  no-op, so the only trustworthy proof is the size of the file afterwards. The read is skipped
  once the WAL hook has fired, since a WAL commit proves the pager has it open; doing it at open
  instead measured 1.8 ms a tenant.
- `close()` runs a TRUNCATE checkpoint as well. Resuming a tailer costs two verification passes
  over the WAL, so leaving an empty one behind is what keeps a cold open cheap, and the backfill
  is work SQLite would have done later anyway.

## Crash reconcile (design §4.3)

Three sources disagree after a crash: the catalog position (written last, so it can only lag), the
log (self-verifying, each record carrying the WAL position it was tailed at), and the database with
its WAL (authoritative for data). On open:

1. `base` is the log's last record whenever it disagrees with the catalog — it leads when the
   crash fell between `append` and `savePosition`, and trails when a torn tail was repaired away.
2. The recorder resumes at `base.wal`. A position is **proven** when the tailer re-validated the
   chain up to it (`"resumed"`), or when it is the zeroed marker a TRUNCATE checkpoint writes,
   which says "the database file alone is this txid".
3. An unproven position means the WAL is a generation that cannot be shown to continue it, so the
   database is asked where it stands, with one `computeFull` over the file:
   - equal to `base.checksum` → the database is exactly at the position and whatever the WAL holds
     is already counted in it; the tailer restarts at the WAL's current end. Outcome `"clean"`.
   - equal to the last record's `preChecksum` → the database is missing that record, so it is
     applied to the tenant by the M3 `WalApplier` pointed at itself — design §4.3's "crash
     recovery on the primary is the replica applier pointed at itself". Outcome `"applied"`.
4. Otherwise the recorder polls. Transactions that committed but never reached the log are turned
   back into records (design §4.3's "DB ahead of log", outcome `"tailed"`) — but only after
   `computeFull` confirms that the state they fold to is the database as it now stands. They were
   folded against pre-images from the WAL overlay and the database file, and shipping a record
   whose checksum is wrong would diverge every replica that applied it. A mismatch is
   `TenantError("LOG_DIVERGED")`, raised with nothing written; the recovery is `restore`.

`abandon()` is the seam this is tested through: it drops the tenant's descriptors without
flushing, saving or checkpointing, which is what a process going down hard leaves behind. The
tests pair it with a second connection held open across the abandon, because SQLite checkpoints
and deletes the WAL when the *last* connection to a database closes — and a backfilled WAL is not
what a crash leaves.

## Deviations and judgement calls

- **`clean` column.** The tenants table carries one column beyond the brief, `clean`: true from
  the position `close()` saves, false from the next one a write saves. It is diagnostic, and the
  reconcile deliberately does not branch on it, because a file swapped underneath a cleanly closed
  tenant has to be detected too.
- **`txid` and `checksum` are TEXT.** Both are u64, SQLite integers are signed, and the rolling
  checksum genuinely uses its top bit. `wal/snapshot.ts` made the same choice for its index.
- **`PERSIST_WAL` is set on the writer.** The WAL survives the last close, so the file a crash
  reconcile needs is still there and a reopen does not pay to recreate it.
- **A fork empties the new database's WAL.** `restore()` leaves the applier's frames in the new
  `-wal`; they are already counted in the restored checksum, so a fresh recorder tailing them
  would count them twice. `fork` TRUNCATE-checkpoints the new file before the tenant opens and
  refuses to file the fork if any WAL survived that, then takes the checksum from the file. The
  old shape of this — checkpoint, then close the connection — happened to work only because
  SQLite folds the WAL when the last connection closes, which is luck, not a contract.
- **Forking a young tenant needs no snapshot.** With no snapshot at or before `at`, the log
  rebuilds the database from nothing as long as it still reaches txid 1. The seed is a database
  with one header page in WAL mode, not a zero-length file: with no header SQLite cannot know the
  file is in WAL mode and ignores everything an applier writes. That page is not part of any
  record — a fresh tenant's database has one too, which is why records start from a checksum of
  zero over zero pages.
- **Writes during a snapshot throw `BUSY`.** `snapshot()` and `fork()` await `Bun.write`, and a
  commit landing inside that window would make the snapshot newer than the txid it is filed under,
  which is the contract `wal/snapshot.ts` asks the caller to hold.
- **`delete()` moves, never removes.** The directory goes to `<dataDir>/trash/<name>-<ms>` and the
  catalog row is tombstoned. Nothing sweeps the trash in phase 0; design §4.4 keeps the log and
  snapshots after a delete, and retention is an operator decision.
- **The tenant takes one hook slot, the writer's WAL hook, and no others.** `src/realtime` owns
  the commit, rollback and authorizer slots (docs/m6-realtime.md), so `onCommit` here is a list of
  listeners the write path calls after `log.append` rather than SQLite's own commit hook — `write`
  is synchronous, so it can. `onConnection(db, role)` is the seam the route layer installs its
  authorizer trampoline through, called for every writer and every lazily opened reader;
  `acquireReader` hands back a `ReaderLease` holding the `Database` itself, and a pooled
  connection keeps its prepared-statement cache across leases.
- **Eviction can exceed `maxOpen`.** The LRU skips tenants with a write, a snapshot or a reader
  lease in flight. The cap is a target, not a promise a correct write may be broken for.
- **Driver additions.** `sqlite3_stmt_status` with `stmt.status(op, reset)` and `stmt.vmSteps()`
  touch three driver files: `lib.ts` (symbol), `statement.ts` (methods) and `constants.ts` (the
  opcode table, where every other transcribed constant lives). `vmSteps` is the cost unit design
  §6.1 bills on.

## Measured

`bun run bench/tenant.ts`, 2000 rounds, one-row transactions, APFS, M-series, Homebrew SQLite
3.53.4. µs per operation:

| leg | p50 | p90 | p99 |
|---|---|---|---|
| `write`, `ack: "local"` | 27.3 | 34.1 | 55.9 |
| `write`, `ack: "fsync"` | 63.5 | 77.5 | 105.5 |
| the `BEGIN IMMEDIATE`…`COMMIT` alone | 6.5 | 7.7 | 11.5 |
| `readSync`, point read by primary key | 0.9 | 1.1 | 3.3 |
| `read`, the same through a promise | 1.0 | 1.3 | 2.8 |

Taken on an idle machine; the same run with three other agents building alongside it reads 28 µs
and 70 µs for the two write legs, which is the honest spread.

Design §10 budgets 40 µs p50 for a single-row write including the tail and the log; the write path
comes in at 27 µs, of which 6.5 µs is SQLite's own commit and the rest is the M3 legs (tail 9 µs,
zstd encode 11 µs, append 3 µs). An awaited read costs 0.1 µs more than the synchronous one, so
the server layer can use either.

Cold open (an LRU miss), p50, by what the tenant is carrying:

| tenant | open | of which |
|---|---|---|
| no log to speak of (21 records) | 246 µs | 145 µs SQLite, 34 µs log, 17 µs recorder |
| 6 000 records in the log | 2 540 µs | 3 100 µs of a 3 600 µs open is the log index |

Two costs dominate and neither is M4's. The first statement on a fresh connection loads the
schema, which opens the database, the WAL and the shm and rebuilds the wal-index: 145 µs, paid by
whichever pragma runs first (design §2.4's 17 µs is a connection that never touches its schema).
The second is `TxnLog.open` walking every record header to rebuild its offset index, about 0.5 µs
a record; a persisted index, or eagerly scanning only the newest segment, would remove it, and
that belongs to `src/wal/log.ts` in phase 1. `close()` costs 126 µs with the TRUNCATE checkpoint
included, 40 µs without one to do.

## Testing

`test/tenant/` — 20 tests: catalog round trips, the u64 checksum column and the revocation list
the server's authenticator takes; write/read with txids monotonic across close and reopen; commit
hooks; `ack: "fsync"`; `QUOTA_EXCEEDED` from `max_page_count`; `minTxid` waiting, delivery and its
425; the checkpoint policy under 5 MB of writes, replayed into a fresh replica with the M3 applier
and compared by dump; both crash-reconcile directions; snapshot, fork at a txid, fork of a young
tenant from the log alone; registry LRU over 2 000 tenants at `maxOpen` 50 in 2.4 s, including a
tenant that is not evicted while it holds a lease. `test/sqlite/status.test.ts` covers the new
statement counters.
