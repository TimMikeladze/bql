# E2 — Windows becomes a gate

`docs/e1-windows.md` asked the question and got 1346 of 1498. This milestone is the answer to the
150, and then deleting the `continue-on-error` lines that made the job exploratory.

**Result: the whole suite passes on `windows-latest`, and the job is a gate.** One fix accounted
for 144 of the 150; five of the remainder were tests asserting that the platform is POSIX; one was
a test that was merely too slow there; and the last was a real bug in `candidatePaths()` that a
Windows run was the only thing that could have found.

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

## 4. What the run said

**1479 pass, 2 skip, 6 fail**, against E1's 1346 / 150. One fix, 144 failures.

The six that remained were not one cause and not, with one exception, about BunQL at all. Five are
POSIX assumptions in *tests*:

| | |
|---|---|
| `keys.json` mode is `0o600` | Windows has no POSIX mode bits; `stat` reports `0o666` whatever `chmod` asked for. The file's protection there is the directory ACL. Asserted only where it means something. |
| `SQLITE_FCNTL_HAS_MOVED` returns `SQLITE_OK` | The unix VFS serves it; the Win32 one answers `SQLITE_NOTFOUND` — which is itself proof the opcode reached a VFS, so it is accepted rather than skipped. |
| the vendored path contains `vendor/sqlite/libsqlite3.` | Two wrong things in one needle: the separator is `\` and the file is `sqlite3.dll`. Matched with `path.sep` and the platform's extension now. |
| a library that is not SQLite is `libc.so.6` | Not a file on Windows, so the test proved the error message for "absent" rather than for "foreign". `kernel32.dll` is the Windows answer. |

The sixth is real and is about speed rather than correctness: `evicts idle tenants and reopens
them` created **2000** tenants against a `maxOpen` of 50 and took over two minutes, against 5
seconds on macOS. Creating a file and opening SQLite on it are both far dearer on Windows, and a
24x factor is what that buys. The test is about the LRU evicting nine tenants in ten and reopening
any of them intact, which 500 tenants prove exactly as well as 2000 — and in 0.75 s rather than
5.6.

## 5. One of the six was more than it looked

The run after those fixes came back **1484 pass, 2 skip, 1 fail**, and the one was not a test
assumption after all. `candidatePaths()` carried this, and had carried it since E1:

> **No system candidate on Windows**, deliberately. It ships no libsqlite3, and a bare
> `"sqlite3.dll"` is not a name — it is a request to the loader to search System32 and every
> directory on `PATH` …

The comment was true about intent and false about the code: the function omitted the bare
`"sqlite3.dll"` and then pushed `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`, `libsqlite3.so.0`,
`/usr/lib/libsqlite3.dylib` and the rest on every platform. Harmless in that none of them opens —
and visible, because the "no library" remedy on Windows then reports

```
Tried:
  libc.so.6: Failed to open library "libc.so.6": error code 126
```

which is a remedy naming a file the platform has never had. The rule is now enforced where it is
stated: on `win32`, `candidatePaths()` returns `BUNQL_SQLITE_LIB` and the vendored artefact, and
stops.

Worth noticing how this surfaced. The test that caught it was one I had just written *to encode
the comment's claim* — and the claim was wrong about its own module. A test written from a comment
checks the comment, which is exactly the value in writing it.

## 6. The gate

`.github/workflows/ci.yml` has lost `continue-on-error` from the `windows-latest` job and from its
four steps, and the job is named `windows-latest` rather than `windows-latest (exploratory)`. It
also gained the two checks the other platforms run and it did not — the raw-byte scan and the route
table — because a gate that proves less than its peers is a gate with a hole in it.

E1 §2 said it becomes a gate on the day it passes. This is that day: **macos-latest, ubuntu-latest
and windows-latest all green on the same commit, all three gating.**
