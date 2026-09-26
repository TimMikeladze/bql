# P2 — group commit

Written 2026-09-12, from `docs/performance.md` §4B. That section measured the headroom: a
transaction's fixed costs — the commit, the WAL tail, the page checksums, the record encode, the
segment append — are paid **per transaction**, so a transaction per statement pays all of them
every time. 29.04 µs a row alone; 0.96 µs at fifty rows in one transaction.

`[limits] groupCommit` turns concurrency into batch size. **Off by default**, for a reason that is
not performance — see "What a client sees".

## What it does

`Tenant.writeQueued` enqueues a write instead of running it, and one drain per turn takes
everything waiting and runs it as a single `BEGIN IMMEDIATE` … `COMMIT`. `src/server/exec.ts`
routes `POST /v1/db/:db/query` and the WebSocket `query` op through it; the synchronous
`executeStatement` stays for `db.sync` in the embedded API, which promises no promise, and for a
forwarded write, which is already inside the primary's own turn.

## Measured

64 sockets against one database, 20 writes each, best of three rounds:

| concurrent clients | groupCommit off | groupCommit on | mean fold | speedup |
|---|---|---|---|---|
| 1 | 26 941 writes/s | 22 827 | 1.0 | **0.85x** |
| 4 | 26 827 | 60 192 | 3.8 | 2.24x |
| 16 | 29 159 | 96 046 | 15.2 | 3.29x |
| 64 | 30 130 | 141 507 | 40.0 | **4.70x** |
| 256 | 29 971 | 129 674 | 47.4 | 4.33x |

Without it, write throughput is flat at ~30k however many clients there are — that is the single
writer, and it is the ceiling `docs/performance.md` §3 named. With it, the fold grows with the
arrival rate and the ceiling moves to 140k.

The single-client row is the cost: with nobody to fold with, a write pays one extra event-loop
iteration and the client loses 15%.

## Why the drain is a `setImmediate`

This was measured three ways, because the obvious choice is wrong:

- **`queueMicrotask`** runs the moment the stack empties, which is when the *first* request handler
  awaits — before any other message has been delivered. The fold is always exactly 1. Measured:
  26 700 writes/s, against 26 180 with the queue off. All cost, no benefit.
- **`setTimeout(fn, 0)`** is **1.26 ms** in Bun. Unusable.
- **`setImmediate`** runs after the I/O callbacks already pending in this loop iteration, so the
  batch is everything the sockets had waiting. 0.42 µs in isolation.

An adaptive version — drain inline when the last drain folded nothing, defer when it folded
something — was tried and **does not work**: the inline path never folds anything, so it never
leaves inline mode. There is no way to fold without deferring past the I/O callback boundary.

## What a caller does not see

- **Its own result.** Each entry's function runs in order inside the shared transaction and its
  return value resolves its own promise, so a statement still gets its own `lastInsertRowid` and
  row count.
- **Its own failure.** A throw rolls back the whole transaction, neighbours included — so the drain
  re-runs the batch one statement at a time and only the entry that threw is rejected. Nothing
  persisted from the rolled-back attempt, so the re-run is a first attempt, not a retry.
- **Its own durability.** A fold is answered at the strictest level anyone in it asked for:
  `local` + `fsync` is answered as `fsync`. Nobody is answered weaker than they asked.
- **A wait behind a baton transaction.** An interactive transaction holds the writer for as long as
  its client likes, so a queued write is refused `409 TX_BUSY` exactly as it is today, rather than
  parked for up to `txIdleTimeoutMs`. The existing test for that contract is what caught it.

## What a client does see, which is why it is off by default

- **Folded writes share a txid**, because one transaction is one txid. It stays monotonic and it is
  the txid the write really landed in, so read-your-writes is unaffected — but "one write, one
  txid" stops holding. Two e2e tests assert exactly that (`test/e2e/scenario.test.ts` and
  `test/e2e/phase1.test.ts`), and they fail with it on, which is the honest signal that this is a
  contract change rather than an optimisation.
- **The change feed emits one event per fold**, carrying every folded statement's changes, rather
  than one per write.

Per the rule in `docs/c6-packaging.md` — a setting that changes what a statement *means* does not
take a new default — it ships off. A deployment with many concurrent writers on one database, and
no client logic that counts commits or assumes a txid per write, should turn it on.

```toml
[limits]
groupCommit = true      # BQL_LIMITS_GROUP_COMMIT
groupCommitMax = 64     # most statements in one fold
```

## Verification

- `test/tenant/group-commit.test.ts` — one transaction for a burst, per-statement results, a
  failing statement rejecting only itself while its neighbours commit, the strictest-ack rule, the
  cap, the baton refusal, close rejecting what is queued, and one commit event per fold.
- `bun test` — 1277 pass, 2 skip, 0 fail across 101 files with the default off.
- The table above: `sockets × 20` writes over real WebSockets against two nodes, one with the
  setting on and one with it off.

## Still open

The drain holds the writer for the whole fold, so a 64-statement fold is one transaction a reader
cannot see partway through — which is correct, but it does mean `groupCommitMax` trades tail
latency against throughput. The measurements above stop improving past a fold of ~40, so 64 is a
cap rather than a target.
