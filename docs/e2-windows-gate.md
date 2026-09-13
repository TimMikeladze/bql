# E2 — Windows becomes a gate

`docs/e1-windows.md` asked the question and got 1346 of 1498. This milestone is the answer to the
150, and then deleting the `continue-on-error` lines that made the job exploratory.

## 1. E1 named the wrong root cause

E1 concluded:

> **Windows refuses to write a file another handle has open.** … `tenant.snapshot()` copies the
> database file while the tenant still holds it.

That reads plausibly and it is not what the log says. Grouping every `EBUSY` stack in the job's
output by frame rather than by message:

```
750  #writeWalIndexHeader   src/wal/applier.ts:638
750  #writeUnderLocks       src/wal/applier.ts:566
750  apply                  src/wal/applier.ts:289
  2  #invalidateShm         src/wal/applier.ts:831
```

Every one of the callers E1 listed — `restoreFromBucket`, `snapshot.restore`, `tenant.fork`,
`#restoreInto`, `registry.create` — is a caller of `apply`. There is **one** site, and it is not a
file copy. Not one `EBUSY` frame is in `snapshot()`, and the copy E1 blamed never raised anything.

**The real cause is `ERROR_USER_MAPPED_FILE`.** Mechanism A publishes a wal-index header by
writing to the `-shm` file through a file descriptor, and the applier's own SQLite connection has
that file *mapped* — `WalLocks.open` proves the mapping before it will hand back the lock set.
POSIX lets a `pwrite` and a `MAP_SHARED` mapping of the same file coexist and stay coherent.
Windows refuses the write outright while a section object exists over the file; libuv reports it
as `EBUSY`, which is what made it look like a sharing violation on a copy.

So the failure is not portability-of-file-copying. It is that BunQL writes shared memory through
the file API, which happens to work on two of the three platforms.

## 2. The fix: write the wal-index through the mapping, everywhere

`walIndexWriteHdr` in `wal.c` does not write the `-shm` file. It stores into the mapped wal-index
and calls `xShmBarrier` between the two header copies. We have the same VFS and the same
`sqlite3_file` that `shmlock.ts` already reaches through `SQLITE_FCNTL_FILE_POINTER`, so the same
two entry points are one struct offset away from code that already exists:

```
  8 + 12 * 8 = 104   xShmMap
  8 + 13 * 8 = 112   xShmLock      (already resolved, WalLocks)
  8 + 14 * 8 = 120   xShmBarrier
```

`src/wal/shmlock.ts` gains `WalIndex`, a sibling of `WalLocks`: it resolves `xShmMap` and
`xShmBarrier`, asks the VFS for region 0 with `bExtend = 0` — the 32 KiB that begins with the two
header copies and the `WalCkptInfo` — and hands back a `Uint8Array` over it. The applier then
stores into that array instead of calling `fs.writeSync`, and calls the barrier between copy 1 and
copy 0, which is the ordering `shm.ts`'s header comment already says it is imitating.

**This is not a Windows branch.** The mapped write is taken on every platform whenever `xShmMap`
resolves, which is every platform where mechanism A runs at all. A branch would leave the new path
exercised only by the one CI job that cannot be run locally; this way macOS and Linux prove it on
every push, and Windows is then the same code rather than the exception. The descriptor write
survives as the fallback for the case it was always the right answer to — no mapping, because
nobody has the database open.

`#invalidateShm` (mechanism B) is the same store through a mapping when one can be had, and keeps
its descriptor write otherwise: B exists for a VFS with no shm methods at all, where there is
nothing to map.

## 3. The rest of the 150

- **`loadConfig` expects `/tmp/bunql-canonical`.** A POSIX path literal in a test. Windows resolves
  it to `D:\tmp\bunql-canonical`, which is correct behaviour being asserted against wrongly. The
  test asserts on what the config layer *did* with the path — that the canonical key won, that a
  TOML file set it — so the fixture becomes a path the assertion can build the same way the code
  does.
- **`cleanupTempDirs` raises `EBUSY: rm`.** Windows will not remove a directory holding an open
  file, and a test that leaves a handle open dies in teardown rather than where it leaked.
  Teardown retries briefly and then gives up quietly: a temp directory under `os.tmpdir()` that
  outlives the run is litter, not a failure, and reporting it as one hides the test that failed
  first.

## 4. The gate

`.github/workflows/ci.yml` loses `continue-on-error` from the `windows-latest` job and from its
steps. E1 §2 said it becomes a gate on the day it passes; this is that day, or it is not and the
job says so in the same breath.
