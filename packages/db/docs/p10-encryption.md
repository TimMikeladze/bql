# P10 — per-tenant encryption at rest: the design, the price, and why phase 3 does not ship it

`docs/plan-phase3.md` P10, the fourth of design §11's frontier extras. Written 2026-09-16 from a
read of the tree at `a7e7f41`. **The conclusion first: a design exists that covers the whole path
and keeps zero runtime dependencies, and it is a track rather than a milestone. Phase 3 does not
build it, design §11 loses the bullet, and this file is what replaces it.**

`docs/prompt-phase3.md` set the bar: *"a `[security] encrypt = true` that encrypts the main
database and leaks the WAL, the log and the bucket is not"* an acceptable outcome. That bar is the
whole reason this is a track. Meeting it honestly is most of the work; the AES is the easy part.

## 1. What exists today: nothing, and the primitive was never the problem

`grep -rn "encrypt\|cipher\|Cipher\|Encrypt\|AES" src/` returns nothing. There is no key, no
keyring, no setting, and no written statement of where BunQL's plaintext boundary is.

The cryptography is free: Bun ships WebCrypto and `node:crypto`, so AES-256-GCM costs no
dependency and no vendoring. **The problem is that BunQL does not own the writes.** SQLite writes
`main.db` and `-wal` through its own VFS, and BunQL has never registered one — it reaches
`sqlite3_file*` through `file_control` for the WAL lock set (`src/wal/shmlock.ts`) and for nothing
else.

SQLite's own answers are both closed to this repo. SQLCipher is a fork of the amalgamation and a
runtime dependency; SEE is commercially licensed. Neither survives the house rules.

## 2. Every plaintext path, and what a full answer owes each one

This table is the deliverable. Any design that cannot fill in the right-hand column for every row
is the half-build the prompt forbids.

| path | who writes it | what it holds | what encryption owes it |
| --- | --- | --- | --- |
| `main.db` | SQLite's VFS | every row | pages encrypted beneath SQLite |
| `-wal` | SQLite's VFS | every row, recently | frames encrypted — and `src/wal/tailer.ts` reads this file **directly**, so it must decrypt |
| `-shm` | SQLite, and BunQL through its own mapping (E2) | page numbers, frame checksums, read marks — **no row data** | **excluded, deliberately.** It is derived, it is recreated on first open, and it is the one file mechanism A rewrites under lock. Encrypting it buys nothing and breaks E2 |
| replica apply | `WalApplier` `pwrite`s pages into the file (`src/wal/applier.ts:613`), bypassing the VFS entirely | every row | encrypt with the same key, in BunQL's own code |
| log segments | `src/wal/log.ts`, via `encode()` (`src/wal/record.ts:131`) | `TxnRecord` bodies **are page images** | ciphertext pages end to end |
| snapshots | `src/wal/snapshot.ts:137`, a `copyFileSync`/reflink of `main.db` | the whole database | nothing — ciphertext copies fine. But the **key must outlive the copy**, which is the restore story |
| bucket | `src/storage/shipper.ts:547,586` | the same segments and snapshots | nothing extra, *if* the records were already ciphertext |
| replication wire | `src/replication/` | page images to a peer | the peer needs the key — so the key is per **database**, not per node |
| process memory | — | decrypted pages, in SQLite's page cache | **nothing, and say so.** Encryption at rest does not defend a live node |

Two rows decide the shape of everything else. `-wal` is read directly by the tailer, and the
applier writes pages directly to `main.db`: **three of BunQL's own components bypass the VFS**, so
a VFS alone is not a complete answer either. Whatever encrypts must be reachable from both sides.

## 3. The design that works

**A page-encrypting VFS shim written in C, compiled into the vendored artefact.**

This is not a new kind of thing in this repo. `scripts/sqlite.ts:146` already compiles
`[sqlite3.c, scripts/native/walsum.c]` into **one** library, and `src/sqlite/lib.ts` resolves
BunQL's own symbols out of it as an optional family (`docs/p3-wal-checksum.md`). A VFS shim goes in
beside `walsum.c` — 134 lines today — and is registered by a `bunql_vfs_register` the driver calls
at open.

Why C and not `bun:ffi`:

- A VFS written with `JSCallback` re-enters JavaScript from inside a SQLite call, **once per page
  read and once per page write**. That is the exact surface `src/sqlite/database.ts`'s file header
  exists to keep small ("a JSCallback that SQLite still holds a pointer to but JS has collected is
  a segfault"), and it would be on the hottest path in the system rather than on a hook.
- It is also the performance answer. A point read is 0.79 µs in the driver
  (`docs/performance.md` §1). A JS round trip per page would be visible; AES-NI at 4 KiB is not.

What the shim does: `xRead` decrypts, `xWrite` encrypts, keyed per database file, with the IV
derived from `(page number, a per-database nonce)` and the tag stored in reserved bytes at the end
of each page — `SQLITE_FCNTL_RESERVE_BYTES` is how SQLCipher makes room and it is the same trick
here. The page header stays plaintext only in so far as the page *number* is implied by offset,
which is unavoidable in any page-level scheme and must be stated: **an attacker with the file
learns the database's size and shape, not its rows.**

The three bypass paths are BunQL's own and share the key:

- **the tailer** decrypts frames as it reads them — it already parses frame headers
  (`src/wal/codec.ts`), so this is one call at a boundary it owns;
- **the applier** encrypts the pages it writes in mechanism A;
- **the log, the snapshots and the bucket** carry ciphertext pages end to end and need no change
  at all, which is the design's best property.

**The rolling checksum folds ciphertext.** `RollingChecksum` (`src/wal/record.ts:277`) XORs
`xxh3_64(pgno ‖ page)`. Folding ciphertext lets a replica — or a restore, or a `verify` — prove it
holds exactly what the primary holds **without the key**. Folding plaintext would make integrity
require decryption, which is strictly worse. This is a real decision and it must be written down
before any code, because it is invisible afterwards.

### What it still costs

- **A key lifecycle.** Per database, derived from a node key held where? A file, an environment
  variable and a KMS are three different products. This is the part that is a design argument
  rather than an implementation.
- **A rotation story, and it is a fork.** Changing a database's key rewrites every page of it.
  BunQL already has the primitive — `fork` is a snapshot reflink plus a new tenant
  (`src/tenant/tenant.ts:1603`) — so rotation is "fork under the new key, cut over, drop the old",
  which is honest and operable and is *not* free at size.
- **The feature is absent on a distribution libsqlite3.** This would be the first BunQL feature
  where the vendored build is a *requirement* rather than a preference — every other capability
  degrades (`docs/c6-packaging.md`). A node configured for encryption on a system library must
  refuse to start, the way `[sqlite] defensive` already does (`docs/p1-pragmas.md`).
- **`POST /v1/db/{db}/import` accepts a plaintext file** and must encrypt it on the way in, and
  `dump` must decide whether it emits plaintext. Both are policy questions with a wrong default.
- **Windows.** E2 cost a session over one VFS-adjacent assumption. A shim in the read/write path
  on three platforms needs the same gate the wal-index fix got.

## 4. Why phase 3 does not build it

Size, and who the decision belongs to. P7 is an afternoon and P8 is a surface over a mechanism that
already exists. This is a C VFS, a keyring, a rotation path, changes to the tailer, the applier,
the importer and the startup gate, a threat model, and a Windows gate. That is the shape of phase 0
or phase 1, not of an item in a table beside a query-plan cache.

**It should be Tim's call made against a written cost, not a coordinator's call made mid-phase.**
That is what this file is for. If he wants it, it is a track with its own plan and its own
milestones, and section 3 is its first page.

## 5. What to tell a deployment that needs encryption today

Design §11 currently promises this and `docs/api.md` says nothing, so a deployment reading the
roadmap learns that encryption is coming and nothing about the meantime. The answer that is
already true:

**Full-disk encryption plus bucket-side encryption covers every row of §2's table except one.**
LUKS, FileVault or an encrypted EBS volume covers `main.db`, `-wal`, `-shm`, the log segments and
the local snapshots; S3 SSE (SSE-S3 or SSE-KMS, set on the bucket) covers the shipped copies; TLS
covers the replication wire. What it does **not** cover is the threat model where the operator of
the machine is the adversary — and that is the only threat model a per-tenant key actually improves
on, because a live node holds decrypted pages in SQLite's page cache either way.

That sentence belongs in `docs/api.md`, and saying it plainly is worth more to a real deployment
than the bullet it replaces.

## 6. Done when — against `docs/plan-phase3.md`'s criteria

| criterion | result |
| --- | --- |
| describes a design that covers the database, the WAL, the log, snapshots and the bucket | **yes**, §2 as the table of obligations and §3 as the design that fills it, including the three components that bypass the VFS and the deliberate `-shm` exclusion |
| with a key lifecycle and a rotation story | **stated, not settled.** Per-database keys, derived from a node key whose custody is the open question; rotation is a fork under the new key. The custody decision is the part that needs Tim |
| **or** states why phase 3 does not ship it | **also yes, and this is the operative half.** §4. The design survives the house rules; the cost does not fit the phase |
| design §11 loses the bullet | **yes**, replaced by a pointer here |

## 7. What it touched

`docs/design.md` §11 (the bullet, and the pointer that replaces it), `docs/api.md` (§2's plaintext
boundary stated, and §5's interim answer), `docs/plan-phase3.md` (P10), `docs/next.md`. **No
source file.** That is the milestone.
