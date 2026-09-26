# P3 — the WAL frame checksum, and the four things that did not fix it

`docs/performance.md` §3.6 and §4G. Written 2026-09-12, after C5, because the item C5 left behind —
"the primary still reads each page back out of its own WAL and pays SQLite's ~5 µs checksum on it"
— turns out to have a different cause from the one §3.6 published, and a much smaller fix than the
one it implied.

**The headline: `checkFrame` costs 4.79 µs of a 6.77 µs `WalTailer.poll()`, and no way of writing
that loop in JavaScript changes it. Computing the same checksum in C takes the whole poll from
6.81 µs to 2.29.**

## 1. What §3.6 said, and why it was wrong

> Inside the tailer, `checkFrame` is 5.16 µs — SQLite's WAL checksum over a 4 KiB page that has
> just been read. … The same loop over a hot buffer in isolation is 1.0 µs, so the extra four are
> **cache misses on a page fresh from the page cache**, not JavaScript. … the lever is to stop
> re-reading the page, not to make the loop tighter. That is what apply mechanism A and
> **capturing pages from SQLite directly** would change.

The cost is real and the number is right. The *diagnosis* is not, and it pointed at a much bigger
piece of work than the problem needs — a VFS shim that intercepts `xWrite` on the `-wal` so the
pages never have to be read back.

It is not cache misses. `Bun.hash.xxHash3` over **the same page, immediately after the same
`fs.readSync`**, costs **0.15 µs**. It reads every one of those 4096 bytes. If the page were cold,
xxHash3 would pay for it too. It does not.

What it is: **1024 scalar, bounds-checked 4-byte loads in JavaScript**, against xxHash3's few dozen
vector loads in C. Roughly 4.7 ns per word. That is the whole of it.

## 2. The measurements

M5 Pro, macOS 26.6.2, Bun 1.4.0, vendored SQLite 3.53.4. Every figure below comes from a harness
that drives the **real `WalTailer.poll()`** against a live WAL, 40 000 single-row transactions, with
a TRUNCATE checkpoint every 5 000 — so everything reaches its steady JIT tier, and the p50 is a
steady state rather than a warm-up.

**The ablation that settles it.** The real `poll()`, with `checkFrame` and with the checksum
removed (`parseFrameHeader` only, everything else identical), run alternately so neither gets an
unfair cache:

| | p50 |
|---|---|
| `poll()` as shipped | **6.77 µs** |
| `poll()` with the frame checksum removed | **1.98 µs** |
| **the frame checksum** | **4.79 µs** |

**Where the rest of the poll goes**, by ablation in the same harness:

| | µs |
|---|---|
| `fstatSync`, each (there are two) | 0.29 |
| the 32-byte header read + `parseWalHeader` | 0.46 |
| `readSync` of one frame | 0.38 |
| `slice` of the page + `Map.set` | 0.38 |
| **the frame checksum** | **4.79** |

Collapsing the two `fstat`s and the header read into one `pread` saves 0.75 µs. Worth having, but
it is not the item.

**Done, and it measured better than this predicted.** `#readHeader` had to `fstat` to find out
whether a TRUNCATE checkpoint had emptied the file, and `poll` then `fstat`ed the same fd again
microseconds later for the loop bound; it now returns the size it already had, and the 32-byte
header buffer is allocated once rather than per poll. **`poll()` p50 2.83 µs → 2.43**, three runs
each, ±0.04 — more than the 0.29 predicted for one `fstat`, because the allocation went with it.

The remaining `fstat` was left alone deliberately. It can be removed by bounding the loop on a
short read instead of on the size, but that costs one extra `readSync` per poll (the terminating
short read) against the 0.29 µs it saves, which is a wash at best. And **the size must not be
cached across polls**: `wal_checkpoint(RESTART)` rewrites the header and restarts frames at the
same offsets without changing the file's size, so an unchanged size is not evidence that nothing
changed.

### 2.1 Four ways of writing that loop, all identical

Every one of these was tried against the real tailer, alternating with the shipped version:

| | poll() p50 |
|---|---|
| shipped: `DataView.getUint32(i, littleEndian)` | 6.79 µs |
| a `Uint32Array` view over the frame, native-order words | 6.79 µs |
| the endianness as a compile-time literal rather than a parameter | 6.79 µs |
| the 8-byte prefix and the page split into separate functions, so neither call site sees two trip counts | 6.77 µs |

**None of them moved it, and the deltas are inside the noise.** This is the same shape of result as
the allocation-free rewrite `docs/performance.md` §3.6 already records, and for the same underlying
reason: the loop is not slow because of how it is written, it is slow because it is a loop.

A warning about measuring this, because it cost most of an afternoon: **in a short benchmark
`codec.checksum` is measured in a lower JIT tier and reads as 5 µs, and in a tight 300 000-call
loop it reads as 1.0 µs.** Both are artefacts. Only the ablation — same program, one thing removed
— gives the number that matters. Any future attempt at this loop should be measured the same way.

### 2.2 The same checksum in C

A 40-line C function computing SQLite's own `walChecksumBytes` chain, called through `bun:ffi`:

| | poll() p50 |
|---|---|
| JS `checkFrame` | 6.81 µs |
| the same checksum in C | **2.29 µs** |

**4.52 µs per poll**, which is **16% of a 28.4 µs single-row write** — and it computes the checksum
rather than skipping it. Verified bit-for-bit against `codec.checkFrame` over 490 real frames of a
live WAL, including multi-frame transactions: validity, page number, commit size and both halves of
the running chain, zero disagreements.

## 3. The decision

**Compile a small C helper into the vendored libsqlite3 and resolve it as an optional symbol,
exactly as `sqlite3_snapshot_*` is resolved. When it is absent, the JavaScript stays and nothing
else changes.**

`docs/next.md` already names this pattern as the remedy for `SQLITE_DBCONFIG_DEFENSIVE`: "a
non-variadic shim compiled by `scripts/sqlite.ts` into `vendor/sqlite/`, declared optional exactly
as `sqlite3_snapshot_*` is". This is the first use of it.

### 3.1 Why not the alternatives

- **A VFS shim that captures pages as SQLite writes them** — what §3.6's diagnosis implied. It is a
  `sqlite3_vfs` and a `sqlite3_io_methods` built out of `JSCallback`s, twenty-odd function pointers
  each delegating to the unix VFS, on the write path of every database. It would remove the
  `readSync` (0.38 µs) and the checksum (4.79). The C helper removes 4.52 of those 5.17 for two
  orders of magnitude less code and no new failure mode on the write path.
- **Skip the checksum on the primary's own live tail.** Tempting and nearly free: the wal-index
  header's `mxFrame` — which `src/wal/shm.ts` can now read, thanks to C5 — says exactly how many
  frames are committed, so frames below it could be trusted without verification. Rejected. The
  frame checksum is the only thing on the live path that would catch a bit that changed between
  SQLite writing the page and bql.sh reading it back, and the rolling database checksum cannot
  stand in for it: the replica recomputes that checksum *from the same bytes*, agrees, and the
  corruption replicates silently. Trading an integrity check for 4.8 µs is not a trade this
  codebase should make quietly, and it would be invisible until it was not.
- **WebAssembly instead of C**, to avoid the build step. Attractive — no toolchain, works on a node
  with a distro libsqlite3 — but the page has to reach the module's linear memory. Reading the
  frame directly into it avoids a copy, which makes this a real option; it is written down here
  rather than built because the C helper rides a build step that already exists and is already run
  by CI on both platforms.
- **Do nothing.** Defensible: 16% of a write, on a path the group-commit setting already folds away
  at scale (`docs/p2-group-commit.md`, 30x at 50 rows a transaction). It is worth doing because it
  costs one file and degrades to exactly today's behaviour.

### 3.2 The interface

Two functions, in `scripts/native/walsum.c`, compiled into the same artefact as the amalgamation so
there is one library, one `dlopen` and one capability check:

```c
/* out[0] = valid, out[1] = pgno, out[2] = commitSize, out[3] = s0, out[4] = s1 */
void bql_wal_check_frame(const uint8_t *frame, uint32_t pageSize,
                           uint32_t salt1, uint32_t salt2,
                           uint32_t s0, uint32_t s1, int native, uint32_t *out);

/* io[0], io[1] are the chain, in and out. */
void bql_wal_checksum(const uint8_t *a, uint32_t n, int native, uint32_t *io);
```

`native` is 1 when the WAL's checksum word order is the host's, which it always is for a WAL
SQLite wrote on this machine; the byte-swapping branch exists so the helper is a faithful
replacement rather than a fast path with a different domain.

### 3.3 Where it is used, and where it is not

`src/wal/codec.ts` **stays pure** — "Pure functions over Uint8Array — nothing here opens a file or
holds state" is its first invariant and it remains the reference implementation the differential
test checks against. The accelerated form lives in a new `src/wal/native.ts`, beside
`src/wal/shmlock.ts`, and is used by `src/wal/tailer.ts` — `poll`, `restore` and `scanWalPages`.

That is the whole hot path. `encodeFrame` (mechanism B's replica apply) and `computeFull`'s WAL
overlay keep the JavaScript: B is no longer the default after C5, and `computeFull` is an oracle
that runs on a crash path, where being obviously correct beats being fast.

## 4. Files

New:

| file | holds |
|---|---|
| `scripts/native/walsum.c` | the two functions above, and nothing else |
| `src/wal/native.ts` | the optional symbols, and `checkFrameFast` which falls back to `codec.checkFrame` |
| `test/wal/native.test.ts` | the differential: native against `codec` over random frames, both word orders, every alignment, and a real WAL |

Touched: `scripts/sqlite.ts` (compile `walsum.c` into the artefact), `src/sqlite/lib.ts` (the
optional symbol table and a `features.walsum` flag), `src/wal/tailer.ts` (three call sites),
`docs/performance.md` §3.6 and a new §4G, `docs/benchmarks.md`, `docs/next.md`.

## 5. Tests and verification

- The differential above, as a test: for random frames at every alignment and both word orders,
  `checkFrameFast` and `codec.checkFrame` agree on validity, page number, commit size and both
  halves of the chain.
- The suite passes unchanged with the helper present **and** absent — the second is what proves the
  fallback, and it is forced with an environment switch rather than by deleting the library.
- `bun run bench --only wal` and `bench/profile.ts` before and after, reported.

## 6. As built

Built 2026-09-12. `bun test` → **1367 pass, 2 skip, 0 fail** across 110 files (1361 before), and
**1365 pass, 4 skip, 0 fail** with `BQL_WAL_NATIVE=0`, which is the fallback proving itself.
`bun run typecheck`, `bun run bytes` and `bun run routes:check` clean.

**The result**, on the repo's own benchmarks, each run with the helper and again with
`BQL_WAL_NATIVE=0`:

| | JavaScript | C | |
|---|---|---|---|
| `bench/profile.ts` · `recorder.poll` | 7.67 µs | **3.17 µs** | −2.4x |
| `bench/profile.ts` · the whole write | 27.21 µs | **22.88 µs** | −16% |
| `bench/tenant.ts` · write, ack local | 28.9 µs | **24.0 µs** | −17% |
| `bench/wal.ts` · tail + checksum | 10.3 µs | **5.3 µs** | −2x |
| `bench/workers.ts` · writes/s, 1 worker | 29 136 | **33 854** | **+16%** |
| `bench/workers.ts` · writes/s, 4 workers | 78 393 | **86 006** | **+10%** |

The throughput figures are over real sockets with the load client in its own process, which is why
they are smaller than 16% of the write path: about 28 µs of every write is transport that this
does not touch.

**Three things came out differently from the plan:**

- **`bql_wal_checksum` is exported but nothing in `src/` calls it.** The plan had `codec.checksum`
  keeping the JavaScript everywhere except the tailer, and that is what shipped — so the raw-chain
  entry point exists only for `test/wal/native.test.ts`, which uses it to hold the two
  implementations to each other at every length and alignment. It earns its place as a test
  fixture; it would be dead weight if the test did not exist.
- **The fallback is announced by `bql serve`, not by a metric.** One line, printed only when the
  helper is absent, naming the cost and the remedy — the same shape as C5's mechanism-B fallback
  notice. A `/metrics` gauge was the first idea and is wrong: it is a process-local constant, and
  under `workers > 1` the router would sum it across threads and report a number that means
  nothing.
- **`scripts/sqlite.ts` hashes `walsum.c` into the artefact stamp**, so editing the C forces a
  rebuild exactly as changing a compile flag does, and `check()` refuses an artefact that does not
  export the helper. Without that, an edited helper would silently not be in the library.

**What is still true:**

- A node on a system libsqlite3 works exactly as before and says so at startup. The suite is green
  in both modes and CI runs the vendored build, so the JavaScript path is exercised by the
  `BQL_WAL_NATIVE=0` tests rather than only by machines that happen to lack the helper.
- `encodeFrame` and `computeFull` still checksum in JavaScript, deliberately (§3.3).
- ~~The rest of `poll()` is 1.98 µs, of which 0.75 is two `fstat`s and a header read that could be
  one `pread`.~~ **Done** — the duplicate `fstat` and the per-poll header allocation are gone and
  `poll()` p50 went **2.83 µs → 2.43**. §2 says why the last `fstat` stays.
