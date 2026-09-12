# R7 — unfollow, and telling one `beta` from the next

A replica that has bootstrapped a database never let go of it, and the name could be reused
underneath it. This file is the bug, the fix, and exactly what the fix does not cover.

## The bug

Reproduced by hand on two nodes, before this milestone:

1. Create `beta` on the primary, write `OLD-GENERATION` into it. A `follow: ["*"]` replica
   bootstraps it and serves the row.
2. `DELETE /v1/db/beta` on the primary. It answers 200 and `beta` leaves `GET /v1/db` there.
3. The replica still lists `beta` and still serves its rows.
4. Re-create `beta` on the primary and write `NEW-GENERATION`.
5. The primary serves `NEW-GENERATION`. The replica serves `OLD-GENERATION`, **at the same
   txid**, with no error and nothing in either log.

Step 5 is the severity. Both nodes stand at txid 2, so a `BunQL-Min-Txid: 2` read — the
read-your-writes check — is *satisfied* by the replica. The consistency mechanism certifies the
wrong answer. Nothing logs, nothing 503s, no metric moves.

### Why it was silent

Two independent causes, both in `src/replication/`.

- **`ReplicaClient.#resolveFollow` only ever added streams.** It computed the set of databases it
  wanted from the primary's announcement and subscribed to the ones it lacked. A database that
  *left* the announcement was never considered, so the stream stayed, the tenant stayed, and
  `#subscribe`'s `registry.pin(db, "replication")` meant the stale tenant could not even be
  evicted by the idle sweep.
- **Database identity on the wire was the bare name.** `HELLO` and `HEARTBEAT` announce
  `databases?: string[]`; `SUBSCRIBE` names a `db`. Nothing distinguishes one `beta` from the
  next `beta`, so even a replica that *did* re-read the announcement had no way to see that the
  name now meant a different database.

The primary was silent for a matching reason: deleting a tenant closes it, but the replica's
`Stream` on the primary kept pointing at the closed tenant with its commit listener attached to
nothing. No records flowed and no error was raised — the stream simply went quiet.

## What unfollow does

When an announcement (the primary's third `HELLO`, or any `HEARTBEAT` carrying `databases`) no
longer names a database this client holds, the client lets it go:

1. aborts a bootstrap in flight and removes its temp file,
2. sends `UNSUBSCRIBE` and forgets the stream from `#streams` and `#byDb`,
3. releases the `"replication"` pin so nothing is held open,
4. forgets the recorded generation, and
5. **disposes of the local copy through `TenantRegistry.delete`** — the same path a primary-side
   delete takes, so the directory moves to `<dataDir>/trash/<name>-<ms>` and the catalog row is
   tombstoned. Never a bare `rm`: a replica's copy is as recoverable as a primary's.

The drop is recorded in `ReplicaClient.status().unfollowed` (the last 16, newest last, each with
`db`, `atMs` and a reason) and reported once through the client's `onError` channel as a
`ReplicaUnfollowed` notice.

The set it considers is not just "databases with a stream". It is every database this client has
a **recorded generation** for — `<bootstrapDir>/generations.json`, see below — which survives a
restart. Without that, a replica restarted after the primary deleted `beta` would come up with no
stream for `beta`, find nothing to drop, and serve the stale copy forever: the same bug through a
different door.

### The three cases where it deliberately does nothing

- **An empty announcement this client will not take at face value.** A primary that is the wrong
  node, or has restarted against an empty data directory, announces nothing *from its very first
  frame* — so an empty announcement is acted on only when this connection has already carried a
  non-empty one, and only when it would drop a single database. Losing the last database one at a
  time is ordinary and is allowed; losing several at once is indistinguishable from a primary that
  has lost its catalog, and is refused, reported once, and reported again after the next non-empty
  announcement. Both flags reset on every reconnect, so a primary that comes back empty has to
  prove it holds databases again before this client will act on an empty list from it.

  This is narrower than "refuse any empty announcement while the client follows anything", which
  was the first cut: it cannot drop the *only* database on a primary, which is exactly the shape
  of the reproduction above. The two clauses together catch every case that motivated the guard
  while leaving the ordinary one working.
- **A name followed explicitly that has never been announced.** `follow: ["acme"]` against a
  primary that does not have `acme` yet is a database waiting to be created, not one that was
  deleted. Only a database this client has a stream for *or* a recorded generation for can be
  dropped, and neither exists for a name that never arrived.
- **A database with no local copy.** The drop calls `registry.has(db)` first and only deletes a
  row whose `role` is `"replica"`. A locally authored database that happens to share a name with
  something the primary dropped is never touched.

Ordering is handled by doing the abort first: `#unfollow` calls `#abortBootstrap` before anything
else, so an announcement that arrives mid-bootstrap closes the temp fd, removes the temp file, and
only then deletes the tenant. No half-written snapshot is left in `<dataDir>/bootstrap`.

## The generation id

Unfollow alone cannot catch a delete and a re-create that land between two announcements: the name
is present before and present after, and only its meaning changed. So a database now carries an
identity on the wire.

### What it is derived from

```ts
// src/replication/protocol.ts
generationId({ name, createdAtMs, pageSize })
  = sha256(`${name}\0${createdAtMs}\0${pageSize}`).hex.slice(0, 16)
```

64 bits as hex — deliberately the same shape `newGenerationId()` in `src/storage/layout.ts` mints
for a bucket generation, so the two concepts read as the same thing.

It is **derived, not minted**, because the catalog has no generation column and `src/tenant/*` was
not this milestone's to change. The three inputs are everything the primary can see about a
database through `TenantRegistry.list()` that is stable for its life: `created_at` and `page_size`
come straight off the catalog row, and the name is the thing being disambiguated. Nothing else on
the row qualifies — `epoch` changes on promotion, `txid` and `checksum` change on every commit,
and `wal_salt1/2` change on every checkpoint.

### Where it travels

| frame | field | meaning |
|---|---|---|
| `HELLO` (primary's third) | `generations?: Record<string, string>` | name → id, for every name in `databases` |
| `HEARTBEAT` (primary) | `generations?: Record<string, string>` | the same, refreshed |
| `SUBSCRIBE` (replica) | `generation?: string` | the id the local copy was bootstrapped under |
| `SUBSCRIBED` (primary) | `generation?: string` | this node's id for that database |

Every field is optional and additive, so `PROTO_VERSION` stays at `1` — the same call
`docs/r1-replication.md` deviation 2 made when `HEARTBEAT` gained `databases`. A peer that sends
none of them is not broken by any of this: the replica records no generation, never sees a
mismatch, and falls back to unfollow-by-name exactly as if R7 had only built part 1.

The replica persists what it holds in `<bootstrapDir>/generations.json` (`{ "<db>": "<id>" }`,
written to a temp file and renamed). That file is this milestone's stand-in for the catalog column
and is the single place a column would replace: `#loadGenerations` / `#saveGenerations` /
`#forgetGeneration` in `src/replication/replica.ts` are the only readers and writers.

### What a mismatch does

- **In an announcement.** The database has been re-created since this client bootstrapped it. The
  client runs the full unfollow — including deleting the local copy to trash — and then subscribes
  to the name again from nothing, which always draws a snapshot. Deleting first is what closes the
  window in which a read would still be served the old generation's rows.
- **In `SUBSCRIBED`.** The primary already forces `mode: "snapshot"` when the `SUBSCRIBE` carries
  a generation it does not recognise, so this only fires against a peer that does not check. It
  takes the existing re-snapshot path, `#resubscribe` — the same one a `RETENTION` or `DIVERGED`
  apply failure takes (`docs/r1-replication.md` deviations 4 and 7): `UNSUBSCRIBE`, then
  `SUBSCRIBE {fromTxid: "0", reset: true}`, which the primary can only answer with a snapshot.

The primary also sweeps its own side now. Before each announcement it ends any stream whose
database has left the catalog, whose tenant has been closed underneath it, or whose generation has
changed — so `replicasOf()` stops reporting a replica of a database that no longer exists, and
`#tick` stops reading `txid` off a closed tenant. The sweep is silent for a delete or a re-create,
which are somebody's deliberate act and not this node's news to report (the same call
`fix(server,replication): stop logging deliberate refusals` made); it logs only a tenant closed
under a stream whose database is otherwise unchanged, which is not deliberate.

On two real nodes the two mechanisms divide like this. `ServerRuntime` announces on every catalog
change, so a delete and a re-create arrive as two announcements and **unfollow** handles them: the
copy is dropped on the first and bootstrapped fresh on the second, and no read is ever served the
old rows. The **generation id** covers what unfollow cannot see — a delete and a re-create the
replica only ever sees as one announcement (a heartbeat that coalesces them, a replica that was
disconnected across both), and a `SUBSCRIBE` whose txid *and* checksum match the primary's exactly
while naming a database that is not the one the primary holds. That last case is the one the old
code could not catch by any route: `#decide` would have answered `mode: "stream"`.

### What it does not protect against

- **A delete and a re-create inside the same millisecond, at the same page size.** `created_at` is
  `Date.now()`, so the two rows collide and the derived id is identical. A real 64-bit id minted
  at creation would not collide. In practice a delete moves a directory and a create opens a
  database, so the window is small — but it is not zero, and this is the honest limit of a derived
  identity.
- **Anything that rewrites `created_at` in place.** A restore or an import that reuses the row
  keeps the id, which is usually what you want (it is the same database) but would hide a
  genuine replacement performed that way.
- **A replica pointed at the wrong non-empty primary.** The empty-announcement guard catches a
  primary with nothing; it cannot catch a primary with a *different* set. Such a replica will
  unfollow and trash its copies, because from inside the protocol that is indistinguishable from
  the databases having been deleted. The copies are in `trash/`, and the fix is the control plane
  knowing which cluster a node belongs to (phase-2 milestone 1), not more heuristics here.
- **A generation the replica never learned.** A copy bootstrapped by a pre-R7 build has no entry
  in `generations.json`; it is protected by unfollow-by-name and by the existing checksum
  divergence check, not by identity, until its next bootstrap records one.

### What a catalog column would add

A `generation text not null` on `tenants`, minted with `newGenerationId()` in
`Catalog.putTenant`, would replace `generationId()` with a read of the row and close the
same-millisecond collision outright. It would also survive a `created_at` rewrite, let a
`SnapshotRef` and a shipped segment name the generation they belong to, and give promotion
(phase-2 milestone 2) something to fence on besides the epoch. `generationId()` is a pure function
of a `TenantRow` for exactly that reason: when the column lands, it becomes `row.generation` and
nothing else in `src/replication/` moves.

## Follow-up left open

`src/server/runtime.ts` narrows its quiet-log check on `instanceof ReplicaOffline`. Both notices
now share a `ReplicaNotice` base, so widening that check to `ReplicaNotice` would print an
unfollow the way an offline primary is printed — message, no stack. `src/server/` was not this
milestone's to change.
