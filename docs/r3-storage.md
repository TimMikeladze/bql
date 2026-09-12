# R3 — S3 shipper, bucket layout and point-in-time restore (as built)

Companion to `docs/plan-phase1.md` (milestone R3), `docs/design.md` §4.4 and §6.5, and
`docs/r1-replication.md` / `docs/r2-durability.md` (the log and snapshot machinery R3 ships to a
bucket). This file is the **bucket layout contract** a restore depends on, the deviations from the
brief, and the operational notes.

## What ships

| module | invariant |
|---|---|
| `src/storage/s3.ts` | one typed door to the bucket. Every failure names the bucket and the key and never the credentials. |
| `src/storage/layout.ts` | keys sort lexicographically in txid order, and the manifest is written last, so a reader never sees an object the manifest does not describe. |
| `src/storage/shipper.ts` | a commit is never blocked by the bucket. The local log is the source of truth; memory is a fast path that is allowed to be dropped. |
| `src/storage/restore.ts` | a restore either reproduces the target txid exactly, checksum by checksum, or fails. It never produces a database with a hole in it. |
| `src/wal/log.ts` | a segment index is a cache of the scan, never a second source of truth: a missing, stale or corrupt index costs a scan and nothing else. |

## 1. Bucket layout (the contract)

```
<prefix>db/<name>/manifest.json
<prefix>db/<name>/snapshots/<20-digit txid>.db.zst
<prefix>db/<name>/segments/<20-digit startTxid>-<20-digit endTxid>.seg.zst
```

`<prefix>` is `s3.prefix` with any leading `/` stripped and exactly one trailing `/` when it is
non-empty. `<name>` is the database name, which `assertValidName` has already restricted to
`[a-z0-9][a-z0-9_-]{0,63}`, so no key needs escaping.

Txids are zero-padded to 20 digits — the same padding `TxnLog` uses for its own segment files, and
wide enough for `2^64 - 1`. That is what makes a plain `ListObjectsV2` return snapshots and
segments in txid order without the client sorting anything.

Every object body is `Bun.zstdCompressSync(plain)`. A segment object's plain body is transaction
records back to back, exactly as `src/wal/record.ts` encodes them and exactly as a local segment
file holds them — a segment object can be concatenated from a local segment with no re-encoding.
A snapshot object's plain body is the SQLite file.

### `manifest.json`

```json
{
  "version": 1,
  "db": "acme",
  "generation": "8f1c2a6b5d4e3f20",
  "pageSize": 4096,
  "shippedTxid": "5120",
  "updatedAtMs": 1789200000000,
  "generations": [
    { "id": "8f1c2a6b5d4e3f20", "startedAtMs": 1789100000000, "firstTxid": "0", "lastTxid": "5120" }
  ],
  "snapshots": [
    {
      "key": "bunql/db/acme/snapshots/00000000000000005000.db.zst",
      "generation": "8f1c2a6b5d4e3f20",
      "txid": "5000", "epoch": 0, "pages": 412, "pageSize": 4096,
      "checksum": "10238471293847", "bytes": 190210, "plainBytes": 1687552,
      "hash": "9182736451209", "createdAtMs": 1789199000000
    }
  ],
  "segments": [
    {
      "key": "bunql/db/acme/segments/00000000000000005001-00000000000000005120.seg.zst",
      "generation": "8f1c2a6b5d4e3f20",
      "startTxid": "5001", "endTxid": "5120",
      "bytes": 20481, "plainBytes": 98304,
      "hash": "552341009887", "createdAtMs": 1789199900000
    }
  ]
}
```

Rules a reader may rely on:

- Every txid is a **decimal string**, never a JSON number: txids are `u64` and JSON numbers are
  doubles. `checksum` and `hash` are decimal strings for the same reason.
- `checksum` is the tenant's rolling database checksum at the snapshot's txid (design §4.3), the
  value an applier must be seeded with. `pages` is the tenant's page count at that txid, which is
  not always the file's own page count — see deviation 3.
- `hash` is `Bun.hash.xxHash3` of the **plain** (decompressed) body. It is verified on download.
- `snapshots` and `segments` are sorted ascending by txid and hold **no gaps and no overlaps**
  within a generation: `segments[i].startTxid === segments[i-1].endTxid + 1`.
- `shippedTxid` is the highest txid any listed segment or snapshot covers. Everything at or below
  it is in the bucket.
- The manifest is written **last**, after every object it names is durable. A reader that finds an
  object the manifest does not list ignores it; a reader that finds the manifest naming an object
  that is absent fails loudly (`S3_INCOMPLETE`).

### Generations

A generation is a continuous timeline. The shipper creates one when it first writes a manifest,
and a new one when the local database no longer continues the bucket's timeline — a restore
shipped back into the same prefix, or a fork. Objects keep the generation they were written under,
so old ones stay restorable until retention removes them. `listGenerations(db)` reads them out of
the manifest; a restore resolves its target inside the newest generation that covers it.

## 2. `src/storage/s3.ts`

`S3Store` is a thin typed wrapper over `Bun.S3Client` — no dependency, Bun's own SigV4. It takes
`{bucket, region, endpoint, accessKeyId, secretAccessKey, sessionToken, virtualHostedStyle}` and
passes through only the fields that are set, so anything left out falls back to Bun's own
environment resolution (`S3_*` / `AWS_*`). That is what makes AWS S3, Cloudflare R2, Tigris and
MinIO all work from the same config: R2 and MinIO need `endpoint`, Tigris needs `endpoint` plus
`region`, AWS needs neither.

Operations: `put`, `putStream`, `get`, `getStream`, `head`, `exists`, `list` (prefix +
pagination), `delete`, `deleteMany`, `presign`.

- **Retries.** 5xx, `SlowDown`, `RequestTimeout` and network-level failures are retried up to
  `retries` (default 4) with exponential backoff and full jitter from `retryBaseMs` (default
  50 ms). A 4xx other than 408/429 is not retried — it is a request bug and retrying it is a
  denial of service against your own bucket.
- **Concurrency.** A counting semaphore bounds in-flight requests to `concurrency` (default 4).
  It is per store, so a node shipping a thousand tenants does not open a thousand sockets.
- **Errors.** `S3StoreError` carries `{bucket, key, op, attempts}` and a message naming the bucket
  and the key. Nothing in this module reads, logs or formats `accessKeyId`, `secretAccessKey` or
  `sessionToken`; `S3Store` does not keep them as public fields.

## 3. `src/storage/shipper.ts`

One `Shipper` per tenant, driven by `tenant.onCommit`.

**The write path is never blocked.** `onCommit` does two things: push the encoded record bytes
onto a bounded queue and, if this is the first pending record, arm a timer. Nothing else. The
upload runs in a single in-flight async drain loop, so a bucket that is slow, unreachable or
returning 500s cannot make a commit wait.

**Flush triggers**, whichever comes first:

- the tenant's local log rolled a segment (the shipper watches `log.segmentCount`);
- `s3.shipIntervalMs` (default 1000) since the first record of the current batch;
- the pending batch passed `maxBatchBytes` (default `durability.segmentBytes`, 16 MB).

**Backpressure.** The queue is bounded by `s3.maxPendingBytes` (default 64 MB). Past that the
shipper **drops the buffer**, sets `behind = true` and keeps only `shippedTxid`. Nothing is lost:
the next drain reads from `tenant.log.iterateEncoded(shippedTxid + 1n)` instead of from memory — the
records still encoded, so a segment object is a concatenation and never a re-encoding — so the
local log is the source of truth and memory is only the fast path. `behind` clears on the first
drain that catches up to the tenant's txid.

**Snapshots.** The shipper reconciles `listSnapshots(tenant.dir)` against the manifest on every
drain, so a snapshot the tenant took for any reason (`POST /v1/db/:db/snapshot`, a dump, a fork)
gets shipped. It also asks the tenant for one when `s3.snapshotIntervalMs` has elapsed or
`s3.snapshotEveryBytes` of records have been shipped since the last snapshot.

**A generation needs no base snapshot while its segments reach back to txid 1.** The records
replay onto an empty database, which is what the local PITR path already does for a young tenant,
so the usual database never pays for one. The shipper takes a base snapshot only when the log's
first record has aged out from under it — and that is the one thing here that makes the tenant
exclusive, for the length of a checkpoint and a reflink copy, exactly as `POST /v1/db/:db/snapshot`
does.

**Order.** Within a drain: snapshots first, then segments, then the manifest. A crash between any
two leaves objects the manifest does not name, which the next drain re-lists and adopts, and which
a reader ignores.

**State**, exposed on `GET /v1/db/:db/backup`, `GET /v1/db/:db/replication` and `/metrics`:
`{shippedTxid, pendingRecords, pendingBytes, lastError, lastShipMs, lastShipAtMs, behind,
bytesShipped, errors, snapshots, segments}`.

**Retention in the bucket** runs after a successful drain, at most once per `retentionSweepMs`
(default 60 s). It deletes snapshots older than `s3.retention` (default 30 d) and the segments
below the oldest snapshot that survives — so the newest snapshot and everything after it is always
kept, and no object a retained snapshot needs to replay from is ever removed, however old it is.

## 4. `src/storage/restore.ts`

`restoreFromBucket({store, db, at, into, dataDir, catalog})`:

1. read the manifest (`S3_NO_MANIFEST` when absent);
2. resolve the target — `{txid}` directly, `{timestamp}` by the newest snapshot with
   `createdAtMs <= timestamp` plus a scan of the following records' `timestampUs`;
3. pick the newest snapshot at or before the target in the newest generation that covers it, or —
   when that generation's segments start at txid 1 — an empty database at txid 0 as the base;
4. download, verify its `hash`, decompress into `<into>/main.db`;
5. seed a `WalApplier` at `(txid, epoch, checksum, pages, pageSize)` — at txid 0 that is
   `(0, 0, 0)`, see deviation 3;
6. download the segments covering `(snapshotTxid, target]` in order, verify each `hash`, decode
   record by record and `applier.apply()` each one, which verifies `preChecksum` against the
   restored database's own pre-images and `postChecksum` against the fold. A missing object, a
   gap in the inventory or a checksum disagreement fails the whole restore;
7. fold the applier's WAL into the file, write the catalog row at the reached position, and leave
   a directory the registry opens as a normal primary.

`verifyBucket(store, db, {at})` runs 1–3 and 6's *inventory* checks plus a `head` of every object
it would need, without downloading or writing anything. `listGenerations(store, db)` reads the
manifest's generation list.

## 5. `src/wal/log.ts` — the segment index

`docs/next.md` measured cold open at 3.6 ms for a 6k-record log, 3.1 ms of it walking record
headers at ~0.5 µs each. Each segment now has a sidecar index, `<startTxid>.idx`:

```
0   magic "BQLI"  u32       24  segBytes  u64
4   version       u8        32  newestUs  u64
5   (padding)     3         40  offsets   u64[count + 1]
8   startTxid     u64       40 + 8(count+1)  hash u64  (xxh3 of everything before it)
16  count         u32
20  (padding)     4
```

- **The index is a cache, never a source of truth.** On open the log checks the magic, the
  version, the `startTxid` the file name already implies, the trailing hash, that `segBytes` is no
  larger than the segment file, and then — the one check a hash cannot make — that the last record
  it indexes really decodes at the offset it gives, with the txid and timestamp its position
  implies. Any failure means a full scan, named in `log.rescanned`. A pass means the scan
  **resumes at `segBytes`**, so the usual crash — an index one flush behind the file — costs a
  scan of the tail and nothing more.
- It is written on `close()`, on segment rotation, and from `flush()` at most once per
  `indexIntervalMs` (default 1000 ms), through a temp file and a rename so a torn index is never
  read.
- `retain()` removes a dropped segment's index with the segment.

Measured by `test/wal/index.test.ts`, 6000 records in one segment: cold open **2.69 ms** scanning,
**0.36 ms** from the index — a 7.5x improvement on the step phase 0 measured at 3.1 ms of a 3.6 ms
open. That file also covers the absent, stale, truncated, over-long and corrupt cases, and that
retention removes a dropped segment's index with it.

## 6. Configuration

```toml
[s3]
enabled = true               # implied when `bucket` is set
bucket = "backups"
region = "auto"
endpoint = "https://<account>.r2.cloudflarestorage.com"
prefix = "bunql/"
accessKeyId = "${AWS_ACCESS_KEY_ID}"
secretAccessKey = "${AWS_SECRET_ACCESS_KEY}"
sessionToken = ""
virtualHostedStyle = false
shipIntervalMs = 1000
snapshotIntervalMs = 3600000 # 0 disables the timer
snapshotEveryBytes = 67108864
retention = "30d"
concurrency = 4
maxPendingBytes = 67108864
retries = 4
```

Every key takes a `BUNQL_S3_*` override from the section-and-key rule already in
`src/server/config.ts`: `BUNQL_S3_BUCKET`, `BUNQL_S3_SHIP_INTERVAL_MS`, `BUNQL_S3_ACCESS_KEY_ID`
and so on. A `bucket` that is set turns `enabled` on; `enabled = false` turns the shipper off with
the bucket still configured, which is how you keep a restore target without shipping to it.

## 7. HTTP and CLI

| method & path | purpose |
|---|---|
| `GET /v1/db/:db/backup` | shipper state, manifest summary, generations |
| `POST /v1/db/:db/backup/verify` `{at?, bucket?, prefix?}` | is the bucket restorable to `at`? writes nothing |
| `POST /v1/db/:db/restore` `{from:"s3", at, into?, bucket?, prefix?}` | restore from the bucket into a new database |

`GET /v1/db/:db/replication` gains an `s3` block with the same shipper state.
`/metrics` gains `bunql_s3_shipped_txid`, `bunql_s3_pending_records`, `bunql_s3_errors_total`,
`bunql_s3_bytes_total`.

```
bunql backup status <db>
bunql backup verify <db> --at <txid|timestamp>
bunql restore <db> --from s3://bucket/prefix --at <txid|timestamp> [--into name]
```

## 8. Deviations from the brief

1. **`listGenerations` reads the manifest, it does not list a `generations/` prefix.** The brief
   fixes the bucket layout at three paths and asks for `listGenerations`. Putting a generation in
   the key would break the stated layout, so generations live in the manifest and every inventory
   entry is tagged with the one it belongs to.

2. **The shipper polls `listSnapshots` rather than taking a snapshot hook.** `src/tenant/tenant.ts`
   belongs to another milestone and has no `onSnapshot`. Reading the snapshot index (one small
   JSON file) once per drain gets the same result without a cross-module change.

3. **A snapshot at txid 0 is seeded as `(0 pages, checksum 0)`.** R2 fixed this at the source in
   `src/wal/snapshot.ts`; `restore.ts` repeats it because a manifest written by an older node can
   still carry the file's own page count there. See `plan-phase1.md`, "a latent checksum trap".

4. **Segment objects are the shipper's batches, not copies of local segment files.** The brief
   names the key `<startTxid>-<endTxid>.seg.zst`, which does not require the two to line up, and a
   1:1 mapping would either delay the first upload until 16 MB had accumulated or upload the same
   segment repeatedly as it grew. A local segment rotation still forces a flush, so the two agree
   whenever the log is the thing setting the pace.

5. **Retention keeps whole segment objects.** The brief says "keep snapshots and the segments after
   the newest snapshot older than `s3.retention`". Deleting a segment that straddles the oldest
   surviving snapshot's txid would leave that snapshot unable to replay forward, so the sweep keeps
   any segment whose `endTxid >=` the oldest surviving snapshot's txid.

6. **A shipper follows its tenant's lifetime, with a catch-up sweep.** The LRU can evict a tenant
   with unshipped records. The pool remembers those names and reopens them on its sweep rather than
   pinning every shipped database open, which would defeat `data.maxOpen`.

7. **The index offsets are `u64`.** `u32` would cap a segment at 4 GB. `segmentBytes` is
   configurable, and 48 KB of index per 16 MB segment is not worth the cap.

8. **A generation can have no snapshot at all.** The brief's restore starts from "the newest
   snapshot at or before the target". Requiring one would mean taking a snapshot — and therefore
   making the tenant exclusive — on the very first commit of every database, which is a worse
   trade than replaying from txid 1 onto an empty file. `RestorePlan.snapshot` is `SnapshotEntry |
   null` and `planRestore` prefers the empty base when both are available.

9. **`ERR_S3_MISSING_CREDENTIALS` and friends are never retried.** Found by running the suite
   against a real MinIO: a store built without credentials failed five times over. `S3Store` now
   holds a list of codes that are configuration rather than weather — missing credentials, a bad
   signature, a bucket that does not exist — and gives up on the first attempt. A missing *bucket*
   is also not `S3NotFound`, because callers treat that as "nothing to do".

## 9. Operational notes

- **Nothing logs credentials.** `S3Store` keeps its credentials in a private field, never
  interpolates them into a message, and `GET /v1/db/:db/backup` reports `bucket`, `prefix` and
  `endpoint` only. `bunql serve` has no credential flag at all, so nothing reaches a shell history
  or a process listing; `test/storage/s3.test.ts` asserts the message, the stack and
  `JSON.stringify(store)` are all clean.
- **A shipped snapshot makes the tenant exclusive for the length of the copy**, like any other
  snapshot. Set `s3.snapshotIntervalMs` and `s3.snapshotEveryBytes` for how often you want to pay
  that; `0` on both leaves the base snapshot as the only one, and the local log then has to reach
  back as far as you want to restore to.
- **`Shipper.sweepStrays()`** removes objects the manifest does not name whose txids the manifest
  already covers — what a crash between an upload and the manifest write leaves behind. It is not
  called automatically, because an object above `shippedTxid` may be another node mid-upload.
- **A bucket that is down is not an outage.** Commits keep being answered; `behind` goes true and
  `bunql_s3_errors_total` climbs. Alert on `behind`, on `bunql_s3_shipped_txid` not advancing, and
  on `bunql_s3_pending_records`.
- **Local log retention has to outlive the shipper's lag.** A shipper that falls further behind
  than `durability.retention` cannot read the records it is missing and reports `S3_LOG_GAP`; it
  recovers by shipping a fresh snapshot, which is what the `snapshotEveryBytes` policy is for.
- **Restore always goes into a new database**, as `POST /v1/db/:db/restore` already did for local
  PITR: the bucket describes the timeline the database actually had, and rewinding one in place
  would leave a log that no longer applies to it.
- **A bucket is not a replica.** The shipper is asynchronous by design; `ack: "replica"` is what
  holds a response for durability somewhere else.

## 10. What phase 2 needs from these seams

- `S3Store` is the only module that talks to a bucket and takes its options as plain data, so a
  cluster's placement layer can hand each node a different prefix without any other change.
- `ShipperPool` is keyed by database name and attaches through the registry's `onOpen`, so moving
  a database between nodes is "detach here, attach there" — no shipper state lives outside the
  manifest.
- The manifest is the whole handoff. A node that takes over a database reads it, finds
  `shippedTxid`, and continues; nothing in the bucket depends on which node wrote it.
- `restoreFromBucket` writes a catalog row and a plain primary directory, which is exactly what a
  phase-2 "rebuild this replica from the bucket instead of from the primary" path wants.
