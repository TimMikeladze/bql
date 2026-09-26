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
`scripts/native/walsum.c` now marks its three functions `BQL_API`, defined the same way on
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

Three runs, each one answering a question the last one could not reach.

**Run 1 — the build never happened, and the driver segfaulted.** `scripts/sqlite.ts` located
`walsum.c` through `URL.pathname`, which is `/D:/a/bql/…` on Windows and which no file API
accepts, so there was no DLL. The driver then fell through to the candidate `"sqlite3.dll"` — and
that is not a filename on Windows, it is a request to the loader to search System32 and every
directory on `PATH`. It found something, resolved symbols from it, and Bun died at address 0 on the
first call. Both fixed: `fileURLToPath` is now the only way this repo turns a module URL into a
path, and Windows has **no** system candidate at all.

**Run 2 — `clang: error: unsupported option '-fPIC' for target 'x86_64-pc-windows-msvc'`.** PE code
is position-independent by construction and clang refuses the flag rather than ignoring it. Worth
recording for the shape of the failure it replaced: with no library and no bad candidate, the error
is now the one the driver is written to give — "no library", the remedy, and the path the artefact
will appear at.

**Run 3 — it builds, it loads, and the suite runs.**

```
D:\a\bql\bql\vendor\sqlite\sqlite3.dll 3.53.4
{"preupdate":true,"session":true,"snapshot":true,"walsum":true,"fts5":true,
 "rtree":true,"dbstat":true,"json":true,"math":true,"threadsafe":1}
```

Every capability, including `snapshot` — which no distribution build on any platform ships
(`docs/c6-packaging.md` §1) — and `walsum`, so the `__declspec(dllexport)` work is proven by the
symbols resolving rather than by the DLL merely opening.

**`bun test`: 1346 pass, 150 fail, across 1498 tests.** Roughly 90% of the suite passes on a
platform nothing had ever run.

### The prediction was wrong, and in the cheerful direction

C5 expected the mechanism-B fallback with a warning. That is **not** what happened: `xShmLock` is
reachable, the page applier runs, and the fourteen mechanism-A failures are not locking failures.

### What the 150 actually are: one root cause, and a typo

Grouped by message rather than by test, the failures collapse almost entirely into one:

| | |
|---|---|
| `EBUSY: resource busy or locked, write` | 15 distinct sites |
| `BUSY: <db> is taking a snapshot` | the same thing, seen by a client |
| `timed out waiting for <replica> to reach <db>@N` | ~15 sites, all downstream of the above |

**Windows refuses to write a file another handle has open.** POSIX allows it, and bql.sh leans on
that: `tenant.snapshot()` copies the database file while the tenant still holds it, which is what
makes a snapshot nearly free (`src/wal/snapshot.ts`). On Windows that copy raises `EBUSY`, the
snapshot fails, the tenant stays marked exclusive, clients get `503 BUSY`, and every replica that
was waiting for a bootstrap snapshot times out. One cause, three layers of symptom, and it accounts
for the replication, restore, bootstrap, segment-index and crash-reconcile clusters together.

The one unrelated failure is `loadConfig` expecting `"/tmp/bql-canonical"` — a POSIX path
literal in a test, not a portability problem in the code.

### So where Windows stands

**Observed, characterised, and not supported.** The build is portable, the driver loads a fully
capable library, and the single-node paths that do not snapshot largely work. Making it supported
means opening files with Windows share modes that permit a concurrent read, or copying through a
handle opened for sharing, and then re-running this job — which is now the instrument for saying
whether that worked.

## 4. The two things this job was built to ask about

- **Deleting and renaming open files.** POSIX allows both; Windows refuses while a handle is open.
  The trash sweep (`docs/r6-retention.md`), log segment rotation and the snapshot reflink all move
  or remove files a tenant may still hold. **This is §3's root cause**, found first through the
  snapshot copy rather than through any of those.
- ~~**The WAL's shared-memory locks**, which is the original question.~~ **Answered in §3**:
  `xShmLock` resolves through the Win32 VFS, mechanism A runs, and no fallback warning appears.
  The question that replaced it is the one above.
