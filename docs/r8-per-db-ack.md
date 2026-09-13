# R8 — per-database `ackWithoutReplicas`

Written 2026-09-12. Closes the gap `docs/next.md` has carried since R2: **`ackWithoutReplicas` is a
per-node switch, not a per-database one.** A node with ten databases and a replica following one of
them refuses `ack: "replica"` on the other nine — correct, and blunt.

## The decision

Same shape as per-database `foreignKeys` (`docs/p1-pragmas.md`), because it is the same kind of
fact: a database-scoped override of a node-level default, with **three** states rather than two.

```
null     follow [replication] ackWithoutReplicas   ← what every database has until something says
"error"  refuse ack: replica|quorum with 503 NO_REPLICAS when no replica is attached
"allow"  answer locally instead
```

Nullable matters for the same reason it does for `foreignKeys`: "nobody has said" is not "off". A
node that later flips its own switch has to be able to reach a database created before it did, and
that only works if the absence of an override is recorded as its own thing rather than collapsed
into one of the two values.

## What it is *not*

**Not a connection property.** `foreignKeys` is a `PRAGMA` applied per connection, so
`TenantRegistry.setForeignKeys` releases the tenant and the next open applies it. This setting is
read at ack time, on the thread that answers the write, so nothing is released and nothing is
reopened. Changing it takes effect on the next write, not on the next open — which is the better
behaviour and is why it does not reuse `setForeignKeys`'s release.

**Not a per-database ack *level*.** `[durability] defaultAck` stays node-level. What a database can
override is only what happens when the level it was asked for is unsatisfiable.

## Where it is enforced

`AckTracker` owns the rule and keeps owning it. It gains one optional resolver:

```ts
withoutReplicasOf?: (db: string) => "error" | "allow" | null
```

`assertAvailable` and `wait` call `#ruleFor(db)` = `withoutReplicasOf?.(db) ?? this.withoutReplicas`
instead of reading the field directly. The tracker still decides; the resolver only tells it which
default applies to this database. A tracker built without a resolver — every test that constructs
one directly, and the embedded API — behaves exactly as before.

`ServerRuntime` supplies the resolver as `(db) => this.registry.ackWithoutReplicasOf(db)`.

### The cache, and why there is one

`assertAvailable` is on the write path. It returns early for `local` and `fsync`, so the resolver is
only reached for `replica` and `quorum` — but on a node that defaults to one of those it is reached
on **every write**, and `Catalog.getTenant` prepares a statement each call. So `TenantRegistry`
holds a `Map<string, "error" | "allow" | null>` filled on demand and invalidated wherever the
catalog row can change: `setAckWithoutReplicas`, `delete`, `createTenant` and `close`. The registry
is the only writer of that column, so there is no third party to miss.

## Surface

`PATCH /v1/db/{db}` gains a second key beside `foreignKeys`:

```http
PATCH /v1/db/acme
{ "ackWithoutReplicas": "allow" }     → this database answers locally with no replica attached
{ "ackWithoutReplicas": null }        → follow the node again
```

Anything but `"error"`, `"allow"` or `null` is `400 BAD_REQUEST`. `GET /v1/db/{db}` reports it in
`DbStats` beside `foreignKeys`, null when the database follows the node.

Both keys in one body apply together. Only `foreignKeys` releases the tenant, so a body carrying
only `ackWithoutReplicas` does not disturb an open connection or an interactive transaction.

## Workers

Nothing new. Every `/v1/db/:db` route hops to the worker that owns the database, so the PATCH, the
catalog write, the cache and the `AckTracker` that reads it are all on the same thread — which is
also the thread that answers that database's writes. The router holds no tenants and reads no
override.

## The test that would fail if this were only recorded

Recording a setting and enforcing it are different claims, and a test that only reads the value back
out of `GET /v1/db/{db}` proves the first. `test/replication/ack.test.ts` therefore asserts the
**behaviour** on a node with no replicas attached:

- default (`null`) → `503 NO_REPLICAS`, and the write did not happen;
- `"allow"` on that database → `200`, and the row is there;
- a *second* database on the same node, untouched → still `503`, which is the whole point of the
  milestone;
- back to `null` → `503` again, proving the third state is reachable and not a one-way door;
- node configured `ackWithoutReplicas = "allow"`, one database overridden to `"error"` → that
  database refuses while the node allows, proving the override runs in both directions rather than
  only loosening.

Deliberately broken to check the test bites (`docs/c4d-cluster-workers.md` §9): making
`#ruleFor` ignore the resolver and return `this.withoutReplicas` fails the `"allow"` case; making it
return the override for *every* database fails the "leaves the others alone" case.
