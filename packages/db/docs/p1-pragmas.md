# P1 — the SQLite settings bql.sh never exposed

Written 2026-09-12, out of the audit in `docs/performance.md` §7. That section found nine settings
set deliberately and thirteen inherited from whatever libsqlite3 happened to load. This milestone
exposes the ones worth choosing, changes exactly one default, and says plainly which one cannot be
reached at all.

## The rule this follows

From `docs/c6-packaging.md`: **a setting that adds a capability or changes only performance may
have a new default; a setting that changes what a SQL statement means may not.** Every semantic
knob below therefore defaults to what bql.sh does today, and only the writer's page cache moves.

## `[sqlite]`

```toml
[sqlite]
writerCacheBytes = 8388608   # PRAGMA cache_size on the writer. The one changed default.
readerCacheBytes = 2097152   # on each pooled reader; SQLite's own default, stated rather than inherited
readerMmapBytes = 0          # PRAGMA mmap_size on readers. Off, because of the SIGBUS trade below
foreignKeys = false          # PRAGMA foreign_keys on every connection
trustedSchema = true         # PRAGMA trusted_schema; false is SQLite's hardening recommendation
cellSizeCheck = false        # PRAGMA cell_size_check; true costs writes and catches corrupt pages
```

Every key gets `BQL_SQLITE_*` for free, since the env table is generated from the defaults.

### Why the writer's cache moves, and nothing else does

Measured (`docs/performance.md` §4E): at SQLite's default 2 MiB, a 20 000-row transaction spills
6.5 MB of dirty pages into the `-wal` and takes 41 ms; at 8 MiB it spills nothing and takes 23 ms.
Single-row writes — bql.sh's actual shape — do not move at all (4.67 µs against 4.54). The cache is
allocated lazily, so an idle tenant pays nothing: a connection costs ~0.1 MB at open whatever the
cap, and only grows to the cap if the workload touches that many pages.

It also **removes a dependency on which library loaded**. Apple's libsqlite3 defaults `cache_size`
to 2000 *pages* where upstream is -2000 *KiB* — four times the cache — which is why six WAL and
snapshot tests fail against it (`docs/c6-packaging.md` §1.1). Stating the value ends that class of
difference.

Readers get their existing 2 MiB written down rather than inherited, for the same reason.

### Why `mmap_size` is exposed but off

Measured: a cold random point read goes from 5.47 µs to 3.30 µs and a 100-row scan from 15.8 µs to
10.5 µs with `mmap_size = 256 MiB` on the reader. That is the largest read win available. It is off
by default because a read error on a mapped page arrives as **SIGBUS**, which kills the process,
rather than as `SQLITE_IOERR`, which a request can answer. A node on reliable storage should turn
it on; a node that cannot afford a crash on a failing disk should not. Readers only — the writer
measured no gain from it.

### Why `foreign_keys` is exposed and still off

`PRAGMA foreign_keys` is off in SQLite for backwards compatibility, so a foreign key declared in a
tenant's schema is enforced on nothing today — recorded as a gap in `docs/next.md` and found again
by H4 while generating the data API. Turning it on changes the meaning of existing schemas: a write
that succeeds today can start failing with `SQLITE_CONSTRAINT_FOREIGNKEY`. So it is exposed as a
node-level switch and defaults off.

It belongs per database rather than per node, which needs a catalog column and a lifecycle route;
that was deliberately not in this milestone.

**Both are built now.** `tenants.foreign_keys` is a **nullable** integer and `PATCH /v1/db/{db}`
sets it, with three states rather than two: `true`, `false`, and `null` to clear the override and
follow `[sqlite] foreignKeys` again. Nullable is the decision — "nobody has said" is not the same
fact as "off", and collapsing them would mean a node that later turns the node-level switch on
could not reach a database created before it did. `GET /v1/db/{db}` reports the live value.

The pragma is per *connection*, so setting it releases the tenant and the next open applies it —
the same thing `Promoter.#flip` does for a role change, and for the same reason: a value written to
the catalog under a live connection is not reached until that connection happens to be evicted.
`test/server/settings.test.ts` asks SQLite itself (`pragma foreign_keys`) rather than reading back
our own record, and checks that an orphan insert is actually refused once it is on.

## What could not be reached, and now can

**`SQLITE_DBCONFIG_DEFENSIVE` is built and is `[sqlite] defensive`**, off by default like every
other switch here that changes what a statement means. The remedy this section predicted is what
was built: `scripts/native/walsum.c` — which P3 had by then made a real file with the
optional-symbol machinery around it — gained a three-line non-variadic shim,
`int bql_db_config_int(sqlite3*, int op, int v, int *out)`, and `src/sqlite/lib.ts` declares it
optionally beside `bql_wal_*`. So it is a **capability of the vendored build**: present in the
artefact `bun run sqlite:build` produces, absent on a system libsqlite3, and a node configured
`defensive = true` on such a build **refuses to start** rather than quietly not hardening.

`Database.dbConfig(op, value)` serves the whole (int, int\*) family — `value` 1, 0, or -1 to read
without changing — and `DB_CONFIGS` in `src/sqlite/constants.ts` names the ops. Verified rather than
assumed, against each of the three ways the fixed-arity attempt failed: the value is honoured
(read-back follows what was set), the out-parameter is written (-1 reports the live setting), and a
hundred consecutive calls survive (the mis-declaration died on the *second*). And it does what it
is for: with it on, `pragma writable_schema` followed by an `update sqlite_schema` is refused with
*"table sqlite_master may not be modified"*, and with it off the same two statements succeed.
`test/sqlite/dbconfig.test.ts`.

The original analysis, kept because it is the reason the shim exists:

`SQLITE_DBCONFIG_DEFENSIVE` has **no pragma**. It is reachable only through `sqlite3_db_config`,
which is variadic (`int sqlite3_db_config(sqlite3*, int op, ...)`), and bun:ffi cannot express a
variadic signature. Declaring it fixed-arity was tested rather than assumed, and it fails in the
three ways an ABI mismatch fails:

- the value passed is ignored — asking for `DEFENSIVE = 0` on a fresh connection left defensive
  **on** (a write to `sqlite_schema` was still refused),
- the out-parameter is never written — every read-back returned 0, including for ops that must
  echo what they were given,
- and the process died with SIGKILL on the second call.

On arm64 a variadic argument is passed on the stack while a fixed parameter is passed in a
register, so SQLite reads whatever was on the stack. The one apparent success was that garbage.

**The remedy, when it is wanted:** `scripts/sqlite.ts` already compiles the amalgamation, so it can
compile a three-line non-variadic shim beside it —
`int bql_db_config_int(sqlite3*, int op, int v, int *out)` — and `src/sqlite/lib.ts` can declare
it optional exactly as it declares `sqlite3_snapshot_*`. That makes `defensive` a *capability* of
the vendored build, reported by `features` and absent on a system library, which is the pattern the
driver already uses. **This is what was built**, once P3 had made `walsum.c` exist; see the top of
this section.

## Token verification cache

Not a pragma, but the same shape of finding: `verifyToken` is an EdDSA signature check costing
**28.3 µs on every HTTP request**, and a point read over HTTP goes from 44.2 µs with the admin key
to 76.4 µs with a real token (`docs/performance.md` §2).

The cache is keyed by the exact token string, holds the verified claims and the token's own `exp`,
and is bounded (`[auth] verifyCacheSize`, default 1024, `0` disables it). Three rules make it safe:

1. **Expiry is re-checked on every hit** against the same clock the verifier uses, so a cached
   entry cannot outlive its token.
2. **Revocation is re-checked on every hit** by `jti` against the revocation list, which is the one
   input that can change between two requests with the same token. A revoked token is evicted.
3. **Each entry names the key-ring version that vouched for it**, so adding or rotating a key
   invalidates every signature that ring had accepted — a rotated-out key cannot keep answering
   through the cache.

A signature is deterministic for a given token and key ring: everything else about the decision is
re-evaluated per request. What the cache removes is only the arithmetic.

## Verification

- `test/tenant/pragmas.test.ts` — what a writer and a pooled reader actually carry, read off the
  connections themselves; that a byte count becomes the negative-KiB form; that `mmap_size` reaches
  readers and never the writer; and that a declared foreign key **is** enforced with the setting on
  and is not without it.
- `test/server/auth-cache.test.ts` — a hit is as authoritative as a miss: expiry, revocation, key
  rotation and a forged signature each defeat it, the bound evicts oldest-first, and the admin key
  never reaches the cache.
- Measured end to end on a running server: a point read over HTTP with a minted token was
  **76.4 µs before and 45.3 µs after** — the same as the admin-key path (45.2 µs), which is what
  "the verification is no longer per request" should look like.
- `bun test` — 1265 pass, 2 skip, 0 fail across 99 files with the new writer-cache default in
  place.
