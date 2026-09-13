# R9 — the manifest stops being rewritten whole

Written 2026-09-12, to close the item `docs/next.md` has carried since R3: *"the S3 shipper
re-uploads an open segment as it grows… a workload with large transactions pays for the same bytes
more than once."*

**That claim is false, and this milestone starts by retiring it.** The claim that replaces it is
worse.

## 1. What was measured

`test/storage/fake-s3.ts` now records the body length of every `PUT`, so "what did this workload
upload" is a question the harness can answer (`FakeS3.uploadedBytes`, `FakeS3.uploadCounts`).
Three workloads against the fake bucket, timers off and the drain driven by hand:

| workload | record bytes | segment PUTs | segment bytes | manifest PUTs | manifest bytes | total / records |
|---|---|---|---|---|---|---|
| 200 tx x 1 row, drain every 10 | 137 009 | 20 | 111 406 | 21 | 87 668 | 1.45x |
| 50 tx x 500 rows, drain every 5 | 283 542 | 10 | 283 918 | 11 | 26 484 | 1.09x |
| 40 tx x 500 rows, drain every commit | 216 622 | 40 | 216 962 | 41 | **312 989** | 2.45x |

**Segment keys uploaded more than once: 0, in every workload.** `Shipper.#shipSegments` ships
`(shippedTxid, tenant.txid]` and advances `#shippedTxid`, so each object covers a fresh range and no
record byte is ever sent twice. Large transactions do not pay twice; they pay once, as they should.
The old note was describing a shipper that does not exist.

What the third row shows instead: **the manifest was uploaded more than the data was.** 313 KB of
`manifest.json` against 217 KB of records, because the manifest is written whole on every drain and
it carries one `SegmentEntry` — about 250 bytes — for every segment object ever shipped.

## 2. Why that is the real bug

The manifest write is O(segments) and it happens once per drain, so the bytes a database uploads
over its life are O(n²) in the number of drains. The defaults make that concrete: `shipIntervalMs`
is 1 s and `retentionMs` is 30 days, and retention only drops segments below the oldest surviving
snapshot — so a database committing once a second accumulates **86 400 segment entries a day** and
holds 30 days of them.

| segments in the manifest | manifest body | uploaded per day at one drain/s |
|---|---|---|
| 3 600 (an hour) | ~0.9 MB | 78 GB |
| 86 400 (a day) | ~21 MB | 1.8 TB |
| 2 592 000 (the 30-day retention) | ~650 MB | 56 TB |

That is not a tuning problem. A continuously-written database makes its own backup unaffordable,
and nothing reports it — `bunql_s3_bytes` counts it, and it looks like traffic.

## 3. The decision

**Keep the whole inventory in memory; stop persisting it in one object.**

Everything that reads the inventory — `planRestore`, `latestTxid`, `normalizeManifest`,
`resolveTarget`, `verifyBucket`, retention — takes `manifest.segments` as a plain ordered array.
That stays exactly as it is. What changes is only how that array is stored:

```
<prefix>db/<name>/manifest.json                                  ← the tail, and nothing that grows
<prefix>db/<name>/index/<20-digit start>-<20-digit end>-<8 hex>.json   ← frozen, written once
```

- The manifest carries the **tail** of the inventory: the newest entries, still moving.
- As soon as the tail holds `INDEX_CHUNK` (32) entries, those entries are frozen into **one index
  object**, written once and never rewritten, and the manifest is rewritten without them. A chunk
  is only ever written full, which is what makes the number of objects a restore enumerates
  `segments / INDEX_CHUNK` rather than one per drain.
- A reader reconstructs the inventory by listing `<prefix>db/<name>/index/` and fetching the
  chunks, then merging the manifest's tail onto them.

The manifest therefore holds between 0 and 31 segment entries — 16 on average — whatever the age of
the database, so the per-drain upload is O(1) rather than O(segments).

`INDEX_CHUNK` is the design's one trade-off and it is a straight swap: halving it halves the
per-drain manifest body and doubles the chunk objects a restore lists.

The **tag** in the key is because a segment key carries no generation, so two timelines under one
prefix can produce the same txid range; a chunk that overwrote another generation's chunk would
take its entries with it. Duplicate entries across chunks are what the merge below is for — a lost
chunk has no remedy.

### Why the chunks are found by listing rather than named in the manifest

Naming them would put the growth straight back: 40 000 chunk pointers is still a list that is
rewritten every drain. The chunk **key** carries its txid range, zero-padded to the same 20 digits
as everything else in the layout, so a `ListObjectsV2` on the index prefix returns the chunks in
txid order with their coverage readable from the keys and no bodies fetched. That is the same trick
the segment keys already play, and it is why the third layout invariant still holds.

The index prefix is a **sibling** of `segments/`, not a child of it. `Shipper.#sweepOrphans` lists
`segments/` and deletes what the manifest does not name; a chunk living under that prefix would be
swept away the moment it was frozen.

### Crash windows, and why the reader is a merge rather than a concatenation

A chunk is written **before** the manifest that drops its entries from the tail, so the two crash
windows are:

- **after the chunk, before the manifest** — the entries exist in both the chunk and the tail. The
  reader merges by segment key, chunk entries first and tail entries last, so a duplicate resolves
  to one entry and the inventory is identical either way.
- **after the manifest, before the next chunk** — cannot happen; there is nothing between them.

A torn chunk body fails `JSON.parse` and is reported as `S3_INDEX_UNREADABLE` rather than skipped.
Skipping it would produce an inventory with a hole in the middle, and `planRestore` would then
refuse a restore that the bucket can actually serve — or worse, pick an older generation. The third
layout invariant is unchanged: **a reader that meets an object the manifest does not describe
ignores it; a reader that meets a described object that is not there fails loudly.**

### Retention

Retention prunes from the front, so pruning chunks is bounded rather than a rewrite of the index:

- a chunk **wholly** below the floor is deleted;
- the one chunk that **straddles** the floor is deleted and rewritten under a new key covering only
  its survivors;
- everything above is untouched.

### Version

`MANIFEST_VERSION` goes to **2**. A version-1 manifest is still read — its `segments` array is the
whole inventory and there are no chunks — so a bucket written by an older node keeps restoring, and
the first drain by a new node migrates it by freezing the backlog. A version-1 *reader* meeting a
version-2 manifest reads only the tail, which would be a silent hole; `decodeManifest` already
refuses a version it does not know, so it fails loudly instead.

## 4. What this does not change

- No record byte is uploaded twice, before or after. That was never the problem.
- Segment objects, their keys, their bodies and their boundaries are untouched. A bucket's segments
  written by the old shipper are read by the new one with no migration.
- `shippedTxid`, `generations` and `snapshots` stay in the manifest. Snapshots are bounded by
  retention in a way segments are not — one per 64 MB of records rather than one per second — and
  a reader that only wants "how far has this got" must not need a listing.

## 5. What it measured

The same harness, on a fourth workload built to show it: 400 transactions, one drain each, which is
what `shipIntervalMs` does to a steadily written database.

| | manifest PUTs | manifest bytes | index chunks | segment bytes | total / records |
|---|---|---|---|---|---|
| before | 401 | **28 175 313** | — | 298 477 | 96.31x |
| after | 401 | **2 262 847** | 12 (134 471 B) | 298 481 | **9.12x** |

12.5x less manifest, 10.6x less uploaded overall — but the number that matters is not the ratio,
it is that the manifest body is now **bounded**. It holds fewer than `INDEX_CHUNK` segment entries
whatever the age of the database, so a database's backup costs O(n) in its drains rather than
O(n²). The first three workloads are unchanged to within a rounding error, as they should be:
none of them ships enough segments to freeze a chunk.

### The constant that is left, and where it would go next

A drain still uploads the whole (bounded) manifest: 16 segment entries on average at ~250 bytes
each, plus the snapshot and generation lists. That is ~5 KB a drain whatever the workload, which
for a database committing one small transaction a second is most of what it uploads.

`INDEX_CHUNK` is the only knob, and it is a straight swap — halving it halves the per-drain body
and doubles the chunk objects a restore lists. Getting below that needs the entry itself to shrink
(the `key` field is 90 of those 250 bytes and is derivable from the two txids) or a tiered index,
where small chunks are merged into larger ones in the background. Neither is worth it until
someone is paying for it: the quadratic term is gone, which was the bug.

## 6. The tests that would fail if this were only recorded

`test/storage/shipper.test.ts`, four cases:

- **the manifest stops growing while the inventory keeps growing** — 200 drains, the manifest's
  object size at drain 40 against drain 200, with the inventory asserted to have grown past three
  chunks in between, then a byte-for-byte restore;
- **a frozen chunk is only ever written full, and never rewritten** — every `index/` key uploaded
  exactly once, every chunk holding exactly `INDEX_CHUNK` entries. Immutability is what the whole
  design leans on: a chunk rewritten per drain is the quadratic rewrite back again under a new
  name;
- **retention prunes the chunks with the segments** — chunk count falls, no surviving entry names a
  deleted object, and what is left verifies and restores;
- **a torn chunk fails loudly** — half a chunk body, and the restore raises `S3_INDEX_UNREADABLE`
  rather than planning around the hole.

Deliberately broken to check they bite (`docs/c4d-cluster-workers.md` §9): making `#tailOf` return
the whole inventory fails the first; making `loadIndex` ignore the chunks fails the first and the
torn-chunk case; freezing `INDEX_CHUNK - 1` entries at a time fails the second.
