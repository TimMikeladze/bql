# E1 — Windows, observed rather than predicted

`docs/c5-apply-pages.md` §8 has carried this since the apply mechanism landed:

> **Windows is untested.** `winShmLock` takes the same eight slots and the code checks
> `pMethods->iVersion` before it trusts the table, so the worst case is the mechanism-B fallback
> with a warning. Nothing here has run on it.

Nothing had. This milestone is about replacing that paragraph with a measurement, and the only
instrument that can take it is a real Windows machine — `windows-latest` on GitHub Actions.

## 1. What was changed to make the question askable

Three things stood between the repo and a Windows runner, all of them in the build rather than in
the server:

**The vendored library has a third name.** `sqlite3.dll`, and `vendoredName()` in
`src/sqlite/lib.ts` is now the one definition of it that both the driver and `scripts/sqlite.ts`
read — they had the same two-branch conditional written out twice, which is how a third platform
gets added to one of them and not the other.

**`URL.pathname` is not a path on Windows.** It is `/C:/Users/…`, which no file API accepts. The
vendored path goes through `fileURLToPath`, which is a no-op everywhere else.

**A DLL exports nothing unless it is told to.** A shared object on macOS and Linux exports every
non-static symbol; a DLL exports only what is marked. SQLite routes every public function through
`SQLITE_API`, so `-DSQLITE_API=__declspec(dllexport)` is the whole of it for the amalgamation, and
`scripts/native/walsum.c` now marks its three functions `BUNQL_API`, defined the same way on
Windows and to nothing everywhere else. Without this the library loads and every symbol is missing,
which reads as "too old" rather than as "not exported" — the confusing failure, so it is worth
naming.

The compiler search also puts `clang` first on Windows: `cc` does not exist there, and the `gcc` on
the runner image is a MinGW one whose C runtime is not the one Bun's `dlopen` loads the DLL into.

## 2. The job

`.github/workflows/ci.yml` gains a `windows-latest` job, `continue-on-error` at both the job level
and on each step. That is deliberate and it is not a way of ignoring the result:

- **The job's output is the deliverable.** The question is *how far* Windows gets, and a job that
  stopped at the first failure would answer it one step per push.
- **Main stays green.** Nothing claims Windows support yet, and a permanently red tick on a
  platform that was never promised trains people to ignore red ticks.

It becomes a gate by deleting those lines, on the day it passes.

## 3. What was observed

*Filled in from the run — see the commit that follows this document.*

## 4. What is known to be untested even when it is green

Two classes of thing the suite exercises heavily and Windows treats differently, so a green run is
the beginning of the evidence rather than the end of it:

- **Deleting and renaming open files.** POSIX allows both; Windows refuses while a handle is open.
  The trash sweep (`docs/r6-retention.md`), log segment rotation and the snapshot reflink all move
  or remove files a tenant may still hold.
- **The WAL's shared-memory locks**, which is the original question. `xShmLock` through the Win32
  VFS is `LockFileEx` rather than `fcntl`, and the mechanism-A applier takes all eight slots in one
  call (`docs/c5-apply-pages.md` §4.3). The fallback to mechanism B is what protects a replica if
  that is not reachable, and the job's log is where that warning would appear.
