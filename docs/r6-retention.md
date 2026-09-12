# R6 — log and snapshot retention

*Spec, then as-built. `[durability] retention` finally governs the thing its name says it governs.*

## What was broken

`SegmentLog.retain()` in `src/wal/log.ts` and `removeSnapshot()` in `src/wal/snapshot.ts` were both
written, both tested, and both **dead**: nothing in `src/` called either one. The only `retain` a
`grep` found in the server was `ServerRuntime.retain(name)`, which is the LRU pin and has nothing to
do with the log.

So on a long-lived node:

- every committed transaction appended a record to that database's segment log and no segment was
  ever removed;
- every snapshot taken stayed on disk for ever.

`[durability] retention` (default `"7d"`) is documented as governing exactly this. Until the trash
sweep landed it had no consumer at all, and even then it only reached `<dataDir>/trash/`. A busy
node filled its disk and the config key that is supposed to prevent that did nothing.

## The safety floor

`TxnLog.retain()` drops a whole segment only when it is past the policy **and** its newest txid is
below `keepAfterTxid`. Computing that floor is the entire risk in this milestone: too high and the
disk still fills, too low and data a consumer was relying on is gone silently and unrecoverably.

The floor is **the minimum over every consumer that could still read the log**, and nothing else.
`logRetentionFloor` in `src/wal/log.ts` is that computation, pure, with the consumer positions as
its arguments:

```ts
export function logRetentionFloor(consumers: LogConsumers): bigint | undefined
```

```ts
interface LogConsumers {
  oldestSnapshotTxid?: bigint | null
  slowestReplicaTxid?: bigint | null
  shippedTxid?: bigint | null
}
```

`undefined` — nobody present — is handed to `retain` as no `keepAfterTxid`, leaving only the age and
size bounds.

### 1. Point-in-time restore — `oldestSnapshotTxid`

`restore()` copies the newest snapshot at or before the target txid and replays the log records
after it. The records above the oldest snapshot are the only thing that makes that snapshot
restorable to anything but its own txid, so the floor can never rise above it.

Without it: the snapshot survives the prune and every record after it is dropped, so a restore to
any point but the snapshot's own txid fails — the base is there and the tail is not.

### 2. Replicas — `slowestReplicaTxid`

A replica resumes from the record after the one it acked. The floor is the minimum acked txid
across the replicas **currently connected**, read from the primary's own ack tracking.

A replica that has gone imposes nothing. `docs/r1-replication.md` deviation 4: a replica whose
position the log no longer holds is sent an advisory `RETENTION` frame and then a snapshot, so
coming back from beyond the window already works. That is what stops one dead follower pinning the
log for ever.

A replica that is connected but not acking *does* pin the log. The mechanism that unpins it is
`[replication] slowReplicaMs`, which closes a socket that has been backpressured that long; once
the socket is gone so is the floor. This is deliberate: capping a *connected* replica's floor at
the retention would mean deleting records a live follower is about to ask for, which is exactly the
silent, unrecoverable failure this floor exists to prevent.

Without it: a replica that is a few minutes behind on a node with a one-hour retention gets a
`LogGap` mid-stream and re-bootstraps from a full snapshot — a database copy over the wire instead
of a few segments.

### 3. The S3 shipper — `shippedTxid`

`ShipperState.shippedTxid` is the highest txid in the bucket. A node whose bucket is behind — an
outage, throttling, a wrong credential — has to keep the records the bucket does not hold.

Without it: the backup has a hole nothing can ever fill. The shipper reads the records it uploads
out of this same log.

### Absent consumers

A consumer that is not present imposes no floor: no snapshot ever taken, no replica attached, no
bucket configured. That is the point of the shape — a single-node database with no backup is held
only by its own age bound, which is what `retention` promises.

## Snapshot retention

`pruneSnapshots` (`src/wal/snapshot.ts`) removes snapshots older than the retention, with two
exceptions that keep PITR whole:

- **the most recent snapshot at or before the cutoff is kept**, so a restore to exactly `retention`
  ago still has a base to replay from. Keeping only the snapshots *newer* than the cutoff would
  leave the oldest restorable point sitting an arbitrary distance inside the window.
- **the newest snapshot overall is kept whatever its age**, so a database that has not been written
  to in a month is still restorable.

The order matters: prune snapshots, then compute the floor from the oldest snapshot that survived,
then retain the log. Doing it the other way round would hold the log to a snapshot that is about to
be deleted.

## Config

| key | default | what it does |
|---|---|---|
| `[durability] retention` | `"7d"` | age bound for trashed databases, log segments and snapshots. `"0"` keeps everything |
| `[durability] sweepIntervalMs` | `300000` | how often the sweep runs. `0` sweeps only at start |
| `[durability] maxLogBytes` | `0` (unlimited) | size bound on one database's log, on top of the age bound and still under the floor |

`[durability] trashSweepIntervalMs` is **gone**, replaced by `sweepIntervalMs`. It was one commit
old and unreleased. Logs grow far faster than trash does, so the interval came down from an hour to
five minutes and the two sweeps now share one timer.

`maxLogBytes` maps to `RetentionPolicy.maxBytes` and is subject to the same floor: a size cap can
never drop a segment a consumer still needs. It bounds the log where it can and stops where the
floor says stop — a full disk is recoverable, a deleted record a replica was about to read is not.

## Wiring

`ServerRuntime` runs one sweep: `<dataDir>/trash/` first, then every **currently open** tenant. A
closed tenant's log is not growing, and opening every database on the node to look at one would
evict the ones actually serving traffic — so a tenant also gets one pass when it is opened, which is
what stops a database that was written to and then evicted from the LRU keeping its log for ever.

The timer is `unref`'d and cleared in `close`, so maintenance is never why a process is still alive.
One tenant's failure goes to the runtime's `onError` and the sweep carries on to the next.

## Measured

A node with 16 KB segments and a two-second retention, an early snapshot at txid 1 and a base
snapshot at txid 601, then 1400 one-row transactions:

```
early snapshot at txid 1
base snapshot at txid 601
mark 2026-09-12T10:04:04.971Z: the database holds 600 rows
snapshots before: ["00000000000000000001.db","00000000000000000601.db"]
before the sweep: 73 segments, 1232872 bytes, txids 1..1401
after the sweep:  43 segments, 726836 bytes, txids 569..1401
snapshots left: ["00000000000000000601.db"]
freed 506036 bytes (41.0% of the log)
restored acme-pitr to txid 601 (from the timestamp 2026-09-12T10:04:04.971Z)
acme-pitr holds 600 rows; newest row: [600,"row-599"]
expected 600 rows at the mark — match
```

The floor is 601, so the surviving log starts at 569 — the first txid of the segment that *holds*
601, not 601 itself, because `retain` drops whole segments. The early snapshot went; the base
stayed; and the restore to a timestamp inside the window came back with exactly the rows that
timestamp had.

Before the base snapshot existed, the same script freed nothing at all: with the only snapshot at
txid 1, every record in the log was still needed to restore to anything, and the floor said so.

## What is still not retained

Said plainly, because the point of this document is that a key with no consumer is worse than no
key:

- **A database that has never been snapshotted loses its history when its log ages out.** With no
  snapshot there is no floor, so segments past the retention go. `Tenant.fork`'s "replay from
  nothing" fallback needs the log to still start at txid 1, and after a sweep it does not. Only the
  S3 shipper (hourly, or every 64 MB) and a replica bootstrap take snapshots on their own today; a
  node with neither has to call `POST /v1/db/{db}/snapshot` if it wants PITR. **The obvious
  follow-up is a snapshot interval that does not need a bucket to exist.**
- **The bucket's own retention is separate.** `[s3] retention` (default `30d`) governs what the
  shipper deletes from S3; this milestone does not touch it.
- **The newest segment is never dropped**, whatever the age or size bound says — it is the one being
  appended to. A log below one segment is therefore not reachable by any setting.
- **Nothing prunes a closed tenant.** A database nobody opens keeps whatever it had; its first sweep
  is the next time it is opened.
- **The realtime change ring is still in memory** and unrelated to any of this.
