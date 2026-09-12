# C6 — Linux packaging and CI

BunQL's driver is `bun:ffi` over an external libsqlite3. This milestone makes that library
something the repo produces from a pinned source rather than something it hopes to find, and puts
both platforms under CI.

## 1. What is actually true on Linux

The milestone was written on the premise that Debian and Ubuntu ship a libsqlite3 without the
preupdate hook or the session extension, and that BunQL therefore does not run on Linux at all.
**That premise is wrong, and it is worth saying so plainly before anything else.** Measured, not
assumed:

`docker run --rm oven/bun:1.4` — Debian 13 (trixie), Bun 1.4.2, `libsqlite3-0 3.46.1-7+deb13u1`:

```
=== find libsqlite3 ===
/usr/lib/aarch64-linux-gnu/libsqlite3.so.0.8.6
/usr/lib/aarch64-linux-gnu/libsqlite3.so.0
=== ldconfig ===
	libsqlite3.so.0 (libc6,AArch64) => /lib/aarch64-linux-gnu/libsqlite3.so.0
```

```
===== libsqlite3.so.0 =====
  version: 3.46.1
  PREUPDATE: symbols RESOLVE
  SESSION: symbols RESOLVE
  SNAPSHOT: FAILED — Symbol "sqlite3_snapshot_get" not found in "libsqlite3.so.0"
  LOADEXT: symbols RESOLVE
  want ENABLE_PREUPDATE_HOOK: YES
  want ENABLE_SESSION: YES
  want ENABLE_SNAPSHOT: no
  want ENABLE_FTS5: YES
  want ENABLE_RTREE: YES
  want ENABLE_DBSTAT_VTAB: YES
  want ENABLE_MATH_FUNCTIONS: YES
  want ENABLE_COLUMN_METADATA: YES
  want OMIT_LOAD_EXTENSION: no
  want ENABLE_STMT_SCANSTATUS: no
```

The same probe against the libsqlite3 from `ubuntu:24.04` (`3.45.1-1ubuntu2.7`) and
`ubuntu:22.04` (`3.37.2-2ubuntu0.7`) gives the identical verdict: **preupdate and session are
present in every distribution build measured; `sqlite3_snapshot_*` is present in none of them.**
Debian has shipped `ENABLE_PREUPDATE_HOOK` and `ENABLE_SESSION` since bookworm.

So the whole suite already passed on Linux against the stock library, before any of this landed —
`934 pass, 2 skip, 0 fail`, the same counts as macOS. Nothing in phase 2 was blocked. What was
missing was CI to notice, and a library whose flags we actually choose.

Three further measurements that do change decisions:

- **`apt-get install -y libsqlite3-dev` changes no capability.** It adds `/usr/include/sqlite3.h`,
  `sqlite3ext.h`, `pkgconfig/sqlite3.pc` and an unversioned `libsqlite3.so` symlink pointing at
  the same `libsqlite3.so.0.8.6` the runtime package installed. It is a build-time convenience,
  not a different library, and it is not a fix for anything here.
- **The base `ubuntu:24.04`, `ubuntu:22.04` and `debian:12` images have no libsqlite3 at all.**
  `oven/bun:1.4` has one only because something else in it pulled the package in. "The distro
  ships it" is therefore not even reliably true of the distro — it is true of a particular image.
- **The real floor is SQLite 3.37.0**, set by `sqlite3_changes64` and `sqlite3_total_changes64` in
  the driver's `CORE` table. Below that the whole `dlopen` fails and every symbol goes with it,
  which is why an old library used to read as *no* library. Ubuntu 22.04's 3.37.2 clears it by two
  patch releases; Ubuntu 20.04's 3.31 does not.

The honest summary: relying on the system library mostly works and silently varies. It varies by
distribution, by image, and by release; no distribution build has `SQLITE_ENABLE_SNAPSHOT`, which
`src/sqlite/lib.ts` declares a symbol table for; and it gives the project no say in any of the
other flags. Vendoring is still the right answer — it was just never the emergency the brief
described.

### 1.1 macOS, measured the same way (added 2026-09-12)

The same premise was wrong about Apple's library, in the same direction, and §7 below overstated
it too ("snapshot: true, which no system library on either platform can report"). On macOS 26.6.2,
`/usr/lib/libsqlite3.dylib` is **SQLite 3.51.0 with `ENABLE_PREUPDATE_HOOK`, `ENABLE_SESSION` and
`ENABLE_SNAPSHOT`**, plus `OMIT_AUTORESET`, `OMIT_LOAD_EXTENSION` and `THREADSAFE=2`. The driver
loads it and `features` reports preupdate, session and snapshot all present, so the capability
story that rules out a distro build does not rule this one out.

It is still not a library to run on, for a reason capability probing cannot see: **Apple compiles
a different default page cache.** `PRAGMA cache_size` is `2000` — positive, so 2000 *pages*, 8 MiB
at the 4 KiB page size — against upstream's `-2000`, which is 2 MiB. Four times the cache means
dirty pages spill into the `-wal` at different moments, and six tests fail on it:

```
BUNQL_SQLITE_LIB=/usr/lib/libsqlite3.dylib bun test   → 1243 pass, 2 skip, 6 fail
  polling > a page written twice in one transaction appears once, at its last version
  polling > a rolled-back transaction never reaches the stream
  snapshots > records the database at the txid the caller names
  snapshot and fork > a fork at a txid is the database as it was at that txid
  restore > restoring to the snapshot itself replays nothing
  bunql end to end > a fork at a txid dumps identically to the primary taken at that txid
```

The first one is the tell: a page written twice in one transaction yields two WAL frames upstream
and one on Apple's build, because the second write finds the page still in cache. Nothing is
broken and nothing reports a problem — the WAL simply has a different shape, which is exactly the
"silently varies" above, on the platform where it was least expected. The skip count is unchanged
at 2, because both capability blocks that could flip are satisfied here as well.

## 2. `scripts/sqlite.ts`

`bun run sqlite:build` fetches the official SQLite amalgamation, verifies it, compiles it with a
fixed flag list, and writes `vendor/sqlite/libsqlite3.dylib` (macOS) or `libsqlite3.so` (Linux).
`vendor/` is gitignored.

- **Pinned to SQLite 3.53.4**, the same version Homebrew installs, so a macOS developer who has
  not run the script is on the same SQLite as one who has.
- **Verified against two digests.** `sha3-256` is the hash sqlite.org publishes on its download
  page — upstream's own word for these bytes. `sha256` is the same bytes under the digest the rest
  of the repo speaks. A mismatch on either deletes the download and aborts; there is no flag to
  skip it. Verified by corrupting the cached archive: it refuses, names both digests, removes the
  poisoned file, and the next run re-fetches and succeeds.
- **Idempotent.** A stamp beside the artefact records a hash of the pinned version, the flag list,
  the platform and the architecture. A matching stamp skips the build; changing the version or any
  flag invalidates it. `--force` rebuilds regardless.
- **Self-verifying.** After compiling it loads the artefact through `loadFrom` and refuses to
  leave one behind that does not report preupdate, session and snapshot. A library that compiled
  but did not gain its capabilities is worse than none: the driver would load it and quietly fall
  back to a degraded realtime path.
- **No external tools.** `oven/bun:1.4` has no `unzip`, no `curl` and no `tar` that helps, so the
  download uses `fetch` and the archive is unpacked by a central-directory reader in the script
  itself. Shelling out to a tool that may not exist is how a build script becomes
  machine-dependent, which is the thing this script exists to stop. A C compiler is the one
  external requirement, and its absence prints the package to install per platform.
- Prints the artefact path and a copy-pasteable `BUNQL_SQLITE_LIB=…`.

### The flags, and why each one

`bun run scripts/sqlite.ts --explain` prints this list with its reasons; the script is the single
source of truth for both. The organising rule:

> A flag that **adds a capability** is safe, because `features` reports it and the driver checks
> before using it. A flag that **changes what a SQL statement means** is not, because the driver
> can still end up on a system library, and a query must not succeed or fail depending on which
> library happened to be found.

**Required** — the driver resolves these families and the server is built on them:

| Flag | Why |
| --- | --- |
| `SQLITE_ENABLE_PREUPDATE_HOOK` | `sqlite3_preupdate_*`, the row-level change capture in `src/realtime/capture.ts` |
| `SQLITE_ENABLE_SESSION` | `sqlite3session_*`; also requires the preupdate hook above |

**Wanted by design §4.1 and shipped by no distribution build measured:**

| Flag | Why |
| --- | --- |
| `SQLITE_ENABLE_SNAPSHOT` | `sqlite3_snapshot_*` — the one family `lib.ts` declares that Debian and Ubuntu both omit. This is the single largest capability the vendored build adds. |
| `SQLITE_ENABLE_STAT4` | Better query plans after `ANALYZE`. No API to bind; the planner just uses it. |

**Parity** — the vendored library sits ahead of the system one in the search path, so anything the
distribution build offers that this one did not would be a capability *lost* by installing it:
`SQLITE_ENABLE_COLUMN_METADATA`, `FTS5`, `FTS4` (which implies FTS3, so an imported legacy
database still opens), `RTREE`, `DBSTAT_VTAB`, `DBPAGE_VTAB`, `STMTVTAB`, `MATH_FUNCTIONS`,
`UNLOCK_NOTIFY`, `UPDATE_DELETE_LIMIT`, `THREADSAFE=1`.

Two of those are not bound by anything today and are here on purpose: `UNLOCK_NOTIFY` because
design §4.1 lists it, and `DBPAGE_VTAB` because raw page access is the obvious mechanism for
§4.5 mechanism A, which is phase-2 milestone 5.

**One default**, `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`: design §4.1 asks for it, and
`src/tenant/tenant.ts` already runs `pragma synchronous = normal` on every connection. Setting the
compile default to match means a bare `Database.open()` through `bunql/sqlite` has the same
durability as one the server opened, instead of silently differing.

**Dropped from the flag list in the brief**, each for a reason:

- `SQLITE_ENABLE_JSON1` — a no-op since SQLite 3.38. JSON is in core and cannot be enabled; it can
  only be *omitted*, which is why `features.json` reads `!OMIT_JSON`.
- `SQLITE_ENABLE_STMT_SCANSTATUS` — nothing binds `sqlite3_stmt_scanstatus*`. (`sqlite3_stmt_status`
  in `CORE` is a different, always-present function; it is easy to confuse the two.) The flag adds
  per-statement bookkeeping for an API the driver does not offer.
- `SQLITE_USE_URI` — redundant. `src/sqlite/database.ts:182` passes `SQLITE_OPEN_URI` on every
  open, which is per-connection and overrides the compile default either way.
- `SQLITE_DQS=0` — the one real disagreement. Rejecting double-quoted string literals is good
  hygiene, but it changes what a statement *means*, and BunQL runs SQL sent by arbitrary clients.
  With the search path still falling back to Homebrew and to the system library, `DQS=0` in one
  build would make the same query succeed on one machine and fail on another. If the project wants
  DQS off it should be uniform across every library, which SQLite supports at runtime:
  `sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DML, 0)` and `…_DQS_DDL`. That is a driver change and
  a design decision, so it is noted here rather than smuggled in through a compile flag.

Also deliberately **not** set: `SQLITE_ENABLE_FTS3_TOKENIZER`, which Debian does enable. It lets
`fts3_tokenizer()` take a function pointer from SQL, and this is a server that executes SQL from
clients. `SECURE_DELETE` is left off too (Debian sets it) — it is a per-connection `PRAGMA` and a
write cost, not something to fix at build time.

`load_extension` works in the vendored build. That is safe by default: `sqlite3_enable_load_extension`
is off until called, and the SQL `load_extension()` function is unavailable until it is.

## 3. Finding the library, and failing usefully

`src/sqlite/lib.ts` changed in two ways. Neither touches the FFI signatures or the
capability-detection strategy.

**Search order** is now `BUNQL_SQLITE_LIB` → `vendor/sqlite/libsqlite3.{dylib,so}` → Homebrew →
the system candidates. The vendored build goes ahead of the system one because it is the only one
whose flags we know; a distribution build is a guess that happens to be right most of the time. A
developer who has run the build script gets the right library with nothing to configure.

**Diagnostics.** A failure to load used to produce one message that only mentioned macOS and
Homebrew, no matter the platform or the cause. It now distinguishes three cases:

- nothing opened — the file is not there;
- something opened but has no `sqlite3_libversion` — it is not a libsqlite3 at all;
- something opened and is a libsqlite3 but lacks a `CORE` symbol — it is **older than 3.37.0**,
  which is the case that used to read as "no library found" and send people looking in the wrong
  place entirely.

All three end with the same remedy, defined once in `remedy()` so the wording cannot drift:
`bun run sqlite:build`, where the artefact will be, and what a library of your own must be built
with. For example, against a shared library that is not SQLite:

```
BunQL found a libsqlite3 but it is too old: … loaded, but has no sqlite3_changes64.
The driver's core API needs SQLite 3.37.0 or newer.

Build the library BunQL needs:
  bun run sqlite:build
and it will be found at /…/vendor/sqlite/libsqlite3.dylib.
Or point BUNQL_SQLITE_LIB at a libsqlite3 of your own — it must be built with
SQLITE_ENABLE_PREUPDATE_HOOK and SQLITE_ENABLE_SESSION. …
```

### The one piece not wired up

The brief asked that a **capability** failure — a library that loads but was built without, say,
`SQLITE_ENABLE_SESSION` — also name the fix. Those three messages are built in
`src/sqlite/database.ts` (lines 503, 675 and 729), which C6 does not own. The message builder is
written and tested here as `capabilityDetail(lib, flag)` in `src/sqlite/lib.ts`; wiring it in is
three one-line edits, replacing each

```ts
`${this.lib.path} was built without SQLITE_ENABLE_SESSION`
```

with

```ts
capabilityDetail(this.lib, "SQLITE_ENABLE_SESSION")
```

Until someone who owns `database.ts` makes that change, those errors still name the capability and
the loaded file but not what to do next.

## 4. Setting up

**macOS.** `bun run sqlite:build` and you are done; it is found automatically. Needs the Xcode
command line tools (`xcode-select --install`). Homebrew's SQLite still works as a fallback and is
still what the house rules describe — the vendored build simply wins the search when present.

**Linux.** Install a compiler (`apt-get install -y build-essential`, `apk add build-base`), then
`bun run sqlite:build`. A distribution libsqlite3 also works if it is 3.37.0 or newer — everything
will run, with `features.snapshot` false.

**Anywhere.** `BUNQL_SQLITE_LIB=/path/to/libsqlite3.so` overrides all of it.

## 5. CI

`.github/workflows/ci.yml`, on push and pull request to `main`. `macos-latest` (arm64) and
`ubuntu-latest` (x64), so the matrix covers both architectures as well as both platforms.
`fail-fast: false`, a 20-minute timeout, `permissions: contents: read`, and a concurrency group
keyed on the ref that cancels superseded runs.

Steps: checkout, `setup-bun` pinned to 1.4.2 (`engines` asks for `>=1.4.0`; CI pins an exact one so
a Bun release cannot turn a green branch red on its own), restore `vendor/sqlite` from cache,
`bun install --frozen-lockfile`, `bun run sqlite:build`, print the library actually loaded and its
features, `bun run typecheck`, `bun test`, `bun run scripts/routes.ts --check`.

The cache key is `sqlite-<os>-<arch>-<hash of scripts/sqlite.ts>`. That file holds both the pinned
version and the flag list, so its hash *is* the identity of the artefact: change either and the
cache misses, as it should. The amalgamation compiles once per (OS, arch, pin), not once per run.

**No secrets, and none needed.** The storage tests use the in-process `FakeS3` unless
`BUNQL_TEST_S3_ENDPOINT` names a real bucket (`test/storage/harness.ts:69`); this workflow never
sets it, and the test output says which backend ran, so a green run that had quietly reached a
real bucket would be visible. Actions are pinned to commit SHAs with the tag in a trailing comment.

No test needed fixing or skipping for Linux. The suite is clean on both platforms with the same
counts.

## 6. What is still missing

- **This vendors a build; it does not publish packages.** Design §4.1 and `docs/next.md` call for
  `@bunql/sqlite-{darwin-arm64,linux-x64,linux-arm64}` on npm, so an installed copy of BunQL gets a
  library without a compiler. What that would take: a release workflow building the artefact on
  each of the three targets (macOS arm64 natively, the two Linux targets against an old glibc — a
  `manylinux`-style container — so the `.so` is not tied to the builder's libc), one npm package
  per target with `os`/`cpu` fields, listed as `optionalDependencies` so npm installs only the
  matching one, a `candidatePaths()` entry resolving
  `@bunql/sqlite-<platform>-<arch>/libsqlite3.<ext>`, and an npm org plus publish credentials the
  project does not have yet. The build script here is the input to that work, not a substitute for it.
- **The three `database.ts` capability messages** are not wired to `capabilityDetail` — §3 above.
  This is the one piece of the milestone left undone, and it is three one-line edits.
- **Only glibc was measured.** Alpine/musl is untested; the script emits a `.so` there but nothing
  has run it.
- `engine: "builtin"` over `node:sqlite` (design §4.1) is still not built, and this milestone does
  not change that.

## 7. How this was verified

Locally on macOS (arm64, Bun 1.4.0): `bun run sqlite:build` builds SQLite 3.53.4 and self-checks
preupdate, session and snapshot; `bun run typecheck` clean; `bun test` → **934 pass, 2 skip, 0
fail** across 72 files; `bun run scripts/routes.ts --check` clean. The two skips are the
`describe.if(!features.…)` blocks that only run on a library *lacking* the capability. The loaded
library is confirmed to be the vendored one, with `snapshot: true` — which no *distribution*
library reports (§1.1 corrects this line: Apple's macOS 26 build does report it, and is still the
wrong library to run on, for a different reason).

On Linux, the whole CI leg was run end to end in `docker run --rm oven/bun:1.4` (Debian 13,
aarch64) — installing a compiler, building the library from the pinned amalgamation, and running
the full suite. Tail of that run:

```
=== bun run sqlite:build ===
  fetching https://sqlite.org/2026/sqlite-amalgamation-3530400.zip
  cc … -o /app/vendor/sqlite/libsqlite3.so
  SQLite 3.53.4 · preupdate ✓ session ✓ snapshot ✓ fts5 ✓ rtree ✓ math ✓ dbstat ✓ threadsafe=1

=== library under test ===
/app/vendor/sqlite/libsqlite3.so 3.53.4 {"preupdate":true,"session":true,"snapshot":true,…}

 934 pass
 2 skip
 0 fail
 6795 expect() calls
Ran 936 tests across 72 files. [26.65s]

=== routes check ===
docs/api.md covers all 38 routes.
```

The same run was repeated under `--platform linux/amd64` (`uname -m` → `x86_64`, emulated on an
Apple Silicon host), since `ubuntu-latest` is x64: build and suite both clean, `934 pass, 2 skip,
0 fail` in 44.65 s. So all three of macOS arm64, Linux arm64 and Linux x64 are green.

The supply-chain refusal was verified by corrupting the cached archive and rebuilding: it names
both digests, deletes the poisoned file, and the next run re-fetches and succeeds.

**And the workflow has run on GitHub's runners.** Run `34687020222`, the push that landed this
milestone: both jobs `success`, about 80 seconds each.

```
ubuntu-latest  Cache not found for input keys: sqlite-Linux-X64-9f5693067ef9…
ubuntu-latest  SQLite 3.53.4 · preupdate ✓ session ✓ snapshot ✓ fts5 ✓ rtree ✓ math ✓ dbstat ✓ threadsafe=1
ubuntu-latest  /home/runner/work/bunql/bunql/vendor/sqlite/libsqlite3.so 3.53.4 {"preupdate":true,"session":true,"snapshot":true,…}
ubuntu-latest  934 pass / 2 skip / 0 fail
ubuntu-latest  docs/api.md covers all 38 routes.
ubuntu-latest  Cache saved with key: sqlite-Linux-X64-9f5693067ef9…

macos-latest   Cache not found for input keys: sqlite-macOS-ARM64-9f5693067ef9…
macos-latest   SQLite 3.53.4 · preupdate ✓ session ✓ snapshot ✓ fts5 ✓ rtree ✓ math ✓ dbstat ✓ threadsafe=1
macos-latest   /Users/runner/work/bunql/bunql/vendor/sqlite/libsqlite3.dylib 3.53.4 {"preupdate":true,"session":true,"snapshot":true,…}
macos-latest   934 pass / 2 skip / 0 fail
macos-latest   docs/api.md covers all 38 routes.
macos-latest   Cache saved with key: sqlite-macOS-ARM64-9f5693067ef9…
```

Both runners built the library from the pinned amalgamation without a compiler-install step, which
confirms `ubuntu-latest` and `macos-latest` both ship one — the `build-essential` step the Docker
legs need is a property of `oven/bun:1.4`, not of CI.

The caches were cold on that run and saved at the end. A later push hit them, which is the half
that matters for run time:

```
Cache restored from key: sqlite-macOS-ARM64-9f5693067ef9…
build libsqlite3 › already built (SQLite 3.53.4)
```

No download, no compile — the stamp matched and the step was a no-op. A third run was
`cancelled` mid-flight when a newer push landed on `main`, which is the concurrency group doing
its job.

Nothing in this milestone is now unverified except the npm packages it deliberately does not
publish (§6).
