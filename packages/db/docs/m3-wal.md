# M3 — WAL shipping core (`src/wal/`)

Implementation notes for milestone M3 of `docs/plan-phase0.md`. Design authority is
`docs/design.md` §2.1, §4.3, §4.4, §4.5; this file records the byte layouts, the invariants each
module carries, and the decisions the design left open.

## Module map

| file | invariant |
|---|---|
| `codec.ts` | pure functions over bytes; a frame is valid iff salts match the header, `pgno != 0` and the cumulative checksum matches |
| `errors.ts` | every divergence surfaces as a named `WalError` subclass, never a bare `Error` |
| `tailer.ts` | the confirmed position moves only at commit frames, and every poll re-verifies the chain from the last confirmed commit frame |
| `primary.ts` | pre-images are read before the transaction's pages overwrite them, so `preChecksum` is the database as it was |
| `record.ts` | a `TxnRecord` is self-describing and self-verifying: header hash, body hash, and the rolling database checksum before and after |
| `log.ts` | segments are append-only; `txid` is dense and ascending, so a segment's index is an offset array, not a map |
| `applier.ts` | verify before writing: a record that would not produce `postChecksum` is rejected with the replica untouched |
| `snapshot.ts` | a snapshot file is the database at exactly one txid, which the caller names because only the caller knows it |

## WAL format (from `wal.c`, not from documentation)

Header, 32 bytes, every field big-endian:

```
0  magic     u32   0x377f0682 (checksum words read little-endian)
                   0x377f0683 (checksum words read big-endian)
4  version   u32   3007000
8  pageSize  u32   power of two, 512..65536
12 ckptSeq   u32   checkpoint sequence, incremented on every WAL reset
16 salt1     u32   incremented on every WAL reset
20 salt2     u32   re-randomised on every WAL reset
24 cksum1    u32   chain over bytes 0..23, seeded (0,0)
28 cksum2    u32
```

Frame: a 24-byte header followed by one page.

```
0  pgno      u32   1-based page number, never 0
4  dbSize    u32   database size in pages when this is a commit frame, else 0
8  salt1     u32   copied verbatim from the WAL header
12 salt2     u32
16 cksum1    u32   chain(previous, frame bytes 0..7) then chain(page)
20 cksum2    u32
24 page      pageSize bytes
```

Checksum chain over 32-bit words, endianness chosen by the magic's low bit:

```
s0 += x[i]   + s1
s1 += x[i+1] + s0
```

Frames are 1-based: frame `i` starts at `32 + (i - 1) * (24 + pageSize)`.

### The rule that makes tailing safe

Inside an uncommitted transaction SQLite writes frames with valid checksums and then *rewrites
those same slots* if a statement or savepoint rolls back, recomputing the chain from the rewind
point. A frame that verified a millisecond ago can therefore hold different bytes now. The only
position that is stable is a commit frame (`dbSize != 0`), because `mxFrame` never rewinds below
the last commit. So the tailer keeps a confirmed `{offset, runningChecksum, frame}` taken at the
last commit frame and re-scans forward from it on every poll, discarding anything it read past
the last commit. `experiments/walproto.ts` advanced its offset per frame and is wrong here; this
is the one behavioural change made while porting it.

Residual assumption, identical to SQLite's own `walIndexRecover`: a stale frame from an aborted
transaction that happens to sit at a slot beyond the newest commit, whose content chains
correctly from the confirmed checksum, is indistinguishable from a real frame. Reaching that
state requires every preceding frame in the new generation to be byte-identical to the aborted
one, at which point the two are the same write.

### WAL reset

`RESTART` and `TRUNCATE` checkpoints do not change the WAL bytes themselves; the next writer
calls `walRestartHdr`, which increments `salt1`, randomises `salt2`, bumps `ckptSeq` and rewrites
the header. The tailer reads the header on every poll, and a salt change means: restart at frame
1, reseed the running checksum from the new header, drop pending frames. `(salt1, salt2)` can
never repeat because `salt1` only increments.

## `TxnRecord` layout

Little-endian, unlike the WAL: this is our format and LE is the native order. 104-byte fixed
header, then the compressed body.

```
0   magic             4    "BQL1"
4   version           u8   1
5   flags             u8   bit0 zstd, bit1 snapshot boundary
6   pageSize          u16
8   txid              u64
16  prevTxid          u64
24  epoch             u32
28  frameCount        u32
32  timestampUs       u64
40  commitSizePages   u32
44  walSalt1          u32
48  walSalt2          u32
52  walEndFrame       u32
56  preChecksum       u64
64  postChecksum      u64
72  bodyLength        u32   compressed byte length
76  bodyPlainLength   u32   uncompressed byte length
80  bodyHash          16    xxh3-128 of the uncompressed body
96  headerHash        u64   xxh3-64 of bytes 0..95
104 body                    zstd(level 3) of [pgno u32 | page]* ascending by pgno
```

Two deviations from the listing in design §4.3, both forced:

- `bodyLength` / `bodyPlainLength` are new. A segment file is records back to back, so a record
  must state its own length; without it neither the log index rebuild nor the wire framing works.
- the two hashes sit at the end of the header rather than after the body, so `decodeHeader` is a
  single fixed-size read that already validates itself. That is what the log's index rebuild
  needs, and it costs nothing.

`Bun.hash.xxHash3` only exposes the 64-bit digest, so the 128-bit body hash is two 64-bit XXH3
digests over the same bytes with seeds `0` and `0x9E3779B1`. This is **not** canonical XXH3-128
and is not interoperable with other implementations; it is an internal integrity check and
nothing reads it but us.

## Rolling database checksum

`chk = XOR over pages 1..dbSize of xxh3_64(pgno ‖ page)`, exactly as design §4.3 and LiteFS.
Updated incrementally: `chk ^= H(pgno, old) ^ H(pgno, new)`, with `H(pgno, null) = 0` for a page
that did not exist. Truncation (`commitSizePages` below the previous size) XORs out every page
above the new size that the transaction did not itself rewrite — otherwise a `VACUUM` would leave
phantom pages in the checksum forever.

The pre-image comes from a `PageSource`: the `pgno → hash` map of pages written since the last
WAL reset, else a `pread` of the database file, else `null` when the page is past the end. The map
survives a `PASSIVE` checkpoint (backfilling does not change content) and is cleared on a WAL
reset, when the database file becomes authoritative for everything.

## Replica apply — mechanism B

Design §4.5 B, as validated in `experiments/walproto.ts`: append the frames to the replica's own
`-wal` with local salts and a recomputed chain, `fdatasync`, zero the first 136 bytes of `-shm`
so the next reader rebuilds the wal-index. `WalApplier` is the interface mechanism A will
implement later; `apply(record)` and `position` are all the caller sees.

Order of operations differs from the design sentence "a replica verifies `postChecksum` after
every apply": we verify *before* writing anything. The prospective post-checksum is computed from
the pre-images, and a mismatch throws `ChecksumMismatch` with the replica's WAL untouched, which
is strictly better than discovering divergence after persisting it.

The applier re-derives its WAL state whenever the file shrank or its salts changed, so a
replica-side `TRUNCATE` checkpoint (ours or anyone's) is handled without reconstructing the
object, which is what the prototype had to do.

`checkpoint()` needs the exclusive WAL locks, so it must not run while a local reader holds an
open read transaction. That is the caller's problem in phase 0 (design §4.5, "reader
coordination"); the applier documents it and does not police it.

## Modules beyond the eight the plan lists

Two files are additions to the `src/wal/` listing in `plan-phase0.md`, both reported rather than
smuggled in:

- `errors.ts` — `WalError` and its five subclasses. The plan names `PositionMismatch` and
  `ChecksumMismatch` without saying where they live, and scattering error classes across the
  modules that throw them would make `catch (e) { e instanceof WalError }` impossible.
- `primary.ts` — `TxnRecorder`, which ties the tailer, the rolling checksum and the page source
  into "poll and get records". Without it every caller re-derives the same fold-then-commit
  ordering, and getting that ordering wrong is silent corruption rather than an error. This is
  the object M4's tenant owner drives; the milestone's own tests and benchmark use it too.

## Position, persistence, restart

- Tailer position is `{salt1, salt2, frame}`. Restoring it re-validates the chain from frame 1 to
  that frame, because the running checksum is not derivable from the position alone. Salts that
  no longer match mean the WAL was reset while we were away: the caller learns this from the
  `"reset"` outcome and reconciles through the log, not through the WAL.
- Replica position is `{txid, epoch, postChecksum, dbSizePages, pageSize}` in `<dir>/meta.json`,
  written to a temp file, fsynced, renamed. `(txid, postChecksum)` is the position pair from
  design §4.3. `fsync: "rename"` drops the fsync of the temp file and the directory, which is
  worth about 20 µs a transaction: the rename alone is atomic, so a position can only end up
  *behind*, and re-applying a record the replica already holds raises `PositionMismatch` rather
  than corrupting anything.
- Recorder resume is `TxnRecorder.open({ walPosition, txid, checksum, dbSizePages })`. It reports
  `"resumed"` or `"reset"`, which is design §4.3's crash reconcile: "resumed" means the WAL still
  holds frames past the last record and they are tailed into new records (DB ahead of log);
  "reset" means a checkpoint moved everything into the database file while the process was down.

## Log

`<dir>/log/<startTxid padded to 20>.seg`, rotated at 16 MB. txids are dense and ascending, so a
segment's index is `offsets[txid - startTxid]`, not a map: one number per record rather than a
`Map` entry. Rebuilt on open by walking each segment's record headers, which stops at the first
torn tail and truncates it, so a crash mid-append costs the partial record and nothing else.

`fsync: "never" | "each" | "interval"`. The interval policy fsyncs lazily on the next append past
the interval plus on `flush()` and `close()`; no background timer, because a timer that outlives
the log is a shutdown hazard for no benefit at this scale.

## Snapshots

`snapshot(primary, txid)` runs a `TRUNCATE` checkpoint (so the database file alone is the whole
state), then `Bun.write(dst, Bun.file(src))`, which reflinks on APFS/XFS/btrfs *only when the
destination does not exist* — hence a fresh path per snapshot and no overwrite path. Falls back to
a streamed copy. The index is `<dir>/snapshots/index.json`.

The txid is the caller's to supply: it is the txid of the last record whose frames the checkpoint
moved into the database file, and only the owner of the write path knows that. The contract is
that no commit happens between the checkpoint and the copy, which the tenant owner (M4)
guarantees by holding the writer. `snapshot()` refuses a checkpoint that came back busy or left
frames in the WAL, which catches the common way of getting this wrong.

`restore({dir, at, into})` picks the newest snapshot ≤ `at`, copies it, seeds an applier at the
snapshot's txid and checksum, and applies log records in `(snapshotTxid, at]`.

## Testing

`test/wal/` — codec against WAL bytes SQLite actually wrote, a randomised primary→replica
property test (multi-page transactions, pages rewritten inside one transaction, DDL, deletes,
mid-stream checkpoints in all three modes, replica-side checkpoints), crash-reconcile from a
persisted position, log rotation and retention, snapshot/restore to a middle txid compared against
a copy taken at that txid, and the two failure paths (`PositionMismatch`, `ChecksumMismatch`).
`bun:sqlite` appears in tests only, never in `src/`. 62 tests, 0.2 s.

## Measured

`bun run bench:wal`, 500 transactions of 5 rows, primary and replica in one process on APFS
(M-series, Homebrew SQLite 3.53.4). p50 / p90 µs:

| leg | p50 | p90 |
|---|---|---|
| primary commit | 11.0 | 17.3 |
| tail + checksum chain | 9.2 | 15.7 |
| encode, zstd level 3 | 11.2 | 14.9 |
| log append | 2.7 | 5.5 |
| decode | 5.2 | 7.7 |
| replica apply incl. `fdatasync` | 191 | 235 |
| replica read sees the row | 47 | 74 |
| end to end | 285 | 337 |

Records compress 4.8x. Everything we control costs about 40 µs a transaction; the rest is one
`fdatasync` and the wal-index rebuild that mechanism B forces on the next reader — the two costs
design §4.5 gives as the reason mechanism A replaces this in phase 1. Design §2.1 measured 184 µs
p50 for the same loop in the prototype, which did no checksum, no record and no position file.
