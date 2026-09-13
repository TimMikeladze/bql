# R1 — replication transport (as built)

Companion to `docs/plan-phase1.md`, which is the spec. This file records what R1 actually built,
every place the code deviates from the plan and why, and the seams R2 will need.

## What ships

| module | invariant |
|---|---|
| `src/replication/protocol.ts` | the frame codec, pure and I/O-free. A frame is complete or it is not yielded. |
| `src/replication/primary.ts` | `ReplicationServer`: send order per stream is strictly ascending txid with no holes. |
| `src/replication/replica.ts` | `ReplicaClient`: a record is acked only after it is applied and the position is persisted. |
| `src/tenant/tenant.ts` | a replica tenant never authors a transaction; every txid it holds came from a record it verified. |
| `src/server/` | `[replication]` config, `/v1/replication` endpoint, `BunQL-Role`, `503 NOT_PRIMARY` on writes. |

## Wire protocol

Exactly the table in `plan-phase1.md` §"Wire protocol": `type u8 | len u32 BE | body[len]`, max
body 16 MiB, JSON control bodies, binary `TXN` / `ACK` / `SNAPSHOT_CHUNK`.

## Deviations from the plan

1. **`HELLO` is three messages, not two.** The plan asks the primary's `HELLO` to carry
   `databases: string[]` "when the replica's proof is valid", but the primary's `HELLO` is the
   first frame on the wire and the proof has not arrived yet. The handshake is therefore:

   ```
   P→R  HELLO {proto, node, nonce}
   R→P  HELLO {proto, node, proof}
   P→R  HELLO {proto, node, ok: true, databases: [...]}
   ```

   The third frame is what resolves `follow: ["*"]`, and the replica re-reads it on every
   reconnect, so a database created on the primary after the replica connected starts replicating
   at the next reconnect or at the next `databases` refresh (see 2).

2. **`HEARTBEAT` from the primary carries `databases`.** So a `follow: ["*"]` replica picks up a
   newly created database within one heartbeat instead of waiting for a reconnect. This is an
   addition to the plan's `{ts, streams}` body, not a change: the field is optional and a reader
   that ignores it behaves as the plan describes.

3. **A snapshot is read into memory to hash it.** `SNAPSHOT_END` carries "xxHash3 of the plain
   file", and `Bun.hash.xxHash3` has no streaming form, so `sendSnapshot` reads the file once and
   slices the 1 MiB chunks out of that buffer. Peak memory is one database file per bootstrapping
   replica. A streaming digest (or a Merkle fold over chunk hashes) is the fix when database sizes
   make this matter; it is a format change, so it is not done here.

4. **`RETENTION` and `DIVERGED` are advisory, not fatal.** The plan says the replica "may be told
   `RETENTION` first for the metric, then given a snapshot". Both codes are sent as a
   stream-scoped `ERROR` frame and the primary then proceeds straight to `SNAPSHOT_BEGIN` on the
   same stream. The replica logs them and waits for the snapshot. Only `AUTH_FAILED`, `PROTO` and
   `BUSY` close the socket.

5. **Replica realtime is not wired.** The plan's replica-mode section says a replica serves `live`
   queries by re-running them on the applied txid and the `changes` feed as txid-only events.
   Neither is built in R1. `TenantRealtime` drives live queries and the change feed from the
   preupdate hooks on the *writer* connection, and a replica has no writer, so
   `realtime.afterCommit(txid)` on a replica finds an empty capture and returns without
   re-running anything. Making it work means a second invalidation path in `src/realtime/live.ts`
   ("assume every read-set is dirty at this txid"), which is outside R1's owned paths. What *does*
   work on a replica: `read({minTxid})`, `waitFor(txid)`, the commit listeners (so R2's ack path
   and any future CDC see every applied record), and `stats()`.

6. **`checkpoint("PASSIVE")` on a replica is allowed.** The plan only forbids `TRUNCATE`. A
   replica's WAL grows on every apply under mechanism B, so the tenant's idle maintenance runs
   `WalApplier.checkpoint("TRUNCATE")` internally — the public `checkpoint("TRUNCATE")` route is
   what throws `NOT_PRIMARY`, because an operator-driven TRUNCATE would race the applier.

7. **The replica's local log is restarted at every snapshot.** Installing a snapshot at txid T
   deletes `log/` before the file is swapped in. `TxnLog.append` refuses anything but
   `lastTxid + 1`, and the records before T are no longer reachable from the new file, so keeping
   them would leave a log that cannot be replayed onto its own database.

8. **`replicasOf` reports `ackedAtMs`, the route reports `ackedAt`.** The plan names the route
   field `ackedAt`; the in-process API says `ackedAtMs` to match the rest of the codebase, where
   every wall-clock number carries its unit.

9. **A pristine database's snapshot checksum is not its tenant position, and the primary sends the
   position.** `SnapshotRef.checksum` and `.pages` come from `computeFull` over the file, which for
   a database nothing has ever written to counts the header page SQLite creates when the file is
   first opened in WAL mode — while the tenant stands at "0 pages, checksum 0", because that page
   belongs to no transaction. Seeding a replica from the file there makes it XOR that page out of
   its first apply and fail `ChecksumMismatch` on record 1. `SNAPSHOT_BEGIN` therefore carries the
   tenant's own `checksum`/`pages` whenever the snapshot is at the tenant's current txid, and the
   ref's otherwise (an older snapshot is always at txid ≥ 1, where the two agree because record 1
   rewrites page 1). **The same trap is still live in `restore()`**: `src/wal/snapshot.ts` seeds
   its applier from `BigInt(chosen.checksum)`, so a PITR restore from a txid-0 snapshot of a
   pristine database would diverge the same way. Nothing creates such a snapshot today — `Tenant.
   snapshot()` is only called at txid 0 by the replication bootstrap — but R3 should fix it at the
   source by recording the tenant's position in the `SnapshotRef`.

10. **`[durability] segmentBytes` is new.** Log retention was untestable without it: segments only
    roll at the hard-coded 16 MB, so `TxnLog.retain` had nothing but one segment to look at and
    could never produce the gap a replica has to recover from. The key is plumbed through
    `TenantRegistry` and defaults to design §4.4's 16 MB.

11. **Pins are owner-scoped.** `TenantRegistry.pin` already documented that "pins nest" while
    being a bare `Set`, so replication releasing its pin would have unpinned a tenant somebody was
    subscribed to. `pin(name, owner)` / `unpin(name, owner)` keeps a tenant pinned while any holder
    still wants it; the default owner keeps the existing callers behaving exactly as they did.

## Configuration

```toml
[replication]
role = "primary"          # or "replica"
primary = ""              # wss://host/v1/replication, required when role = "replica"
secret = ""               # cluster secret; empty disables /v1/replication entirely
follow = ["*"]
ackTimeoutMs = 2000       # R2
heartbeatMs = 5000
slowReplicaMs = 30000
reconnectMs = 250
forwardWrites = true      # R2
```

Every key has a `BUNQL_REPLICATION_*` override (`BUNQL_REPLICATION_PRIMARY`,
`BUNQL_REPLICATION_SECRET`, `BUNQL_REPLICATION_FOLLOW` as a comma-separated list, …) plus the
short aliases `BUNQL_REPLICA_OF`, `BUNQL_CLUSTER_SECRET` and `BUNQL_FOLLOW`.

CLI: `bunql serve --replica-of wss://… --cluster-secret <s> --follow a,b`. `--replica-of` alone
sets `role = "replica"`.

## Seams R2 needs

- **Ack levels.** `ReplicationServer.replicasOf(db)` already reports every stream's acked txid and
  whether the replica fsynced it (`ReplicaAck.fsynced`). `ReplicationServer.onAck(listener)` fires
  for every `ACK` frame with `{db, node, stream, txid, fsynced}` — that is the whole input to
  `ack: "replica" | "quorum"`, which needs a waiter keyed by `(db, txid)` counting distinct nodes.
- **Write forwarding.** Frame types `FORWARD` (`0x0A`) and `RESULT` (`0x0B`) are defined in
  `protocol.ts` with their body interfaces and are *not* handled: the primary answers an
  unexpected `FORWARD` with `ERROR {code:"PROTO"}`. The replica's write path throws
  `TenantError("NOT_PRIMARY")`, which `src/server/runtime.ts` maps to `503 NOT_PRIMARY` with a
  `BunQL-Primary` header carrying `replication.primary`. R2 replaces that throw with a `FORWARD`
  round-trip; the header and the error code stay as they are so a client that already handles
  them keeps working.
- **Read-your-writes across nodes.** A replica tenant's `waitFor(txid)` resolves from
  `applyRecord`, so `BunQL-Min-Txid` already blocks until the stream delivers that txid and then
  serves the read. Nothing more is needed on the tenant side.
- **Epoch.** `SUBSCRIBE.epoch` is compared against the tenant's epoch and a higher one is refused
  `EPOCH_AHEAD`. Promotion (`bunql promote`) is not built; when it is, it increments the tenant
  epoch through `Catalog.setEpoch` and the old primary is fenced on its next `SUBSCRIBE`.

## Observability

`GET /v1/db/:db/replication` on a primary:

```json
{ "db": "acme", "role": "primary", "txid": 12, "epoch": 0, "checksum": "…",
  "lastSnapshot": {…},
  "replicas": [{ "node": "n2", "stream": 1, "txid": 12, "lag": 0, "ackedAt": 1757… }] }
```

On a replica:

```json
{ "db": "acme", "role": "replica", "primary": "wss://…/v1/replication",
  "connected": true, "applied": 12, "lagTxid": 0, "txid": 12, "epoch": 0, "checksum": "…",
  "lastError": null }
```

`/metrics` gains `bunql_replication_lag_txid`, `bunql_replication_connected`,
`bunql_replication_bytes_total` and `bunql_replication_records_total`.
