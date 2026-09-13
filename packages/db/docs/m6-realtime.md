# M6 — realtime engine (`src/realtime/`)

Companion to `design.md` §4.6 and `plan-phase0.md` M6. Transport-independent: nothing here knows
about HTTP, SSE or WebSocket. The route layer (M5b) owns sockets, policy and timeouts and drives
this engine through two calls — `afterCommit(txid)` and `subscribe*`.

## Modules

| file | invariant |
|---|---|
| `authorizer.ts` | the connection has at most one authorizer installed and it belongs to the hub; every party registers a layer instead of calling `db.authorizer()` |
| `capture.ts` | nothing is published from inside a hook; a hook only appends to a buffer, and the owner materialises it after the commit is durable |
| `readset.ts` | a read-set comes from SQLite's own authorizer at prepare time, never from parsing SQL |
| `live.ts` | a live query re-runs only when the commit's write-set intersects its read-set, and emits only when the result actually changed |
| `ring.ts` | the ring can serve a `since` only while every event after it is still retained; otherwise `reset` |
| `bus.ts` | in-process fan-out with the same topic names Bun's `server.publish` will use |
| `index.ts` | `TenantRealtime` wires the five together for one database |

## Decisions

1. **Capture materialises outside the hook.** The commit hook moves the pending buffer to a
   committed queue and calls `onCommit(capture)`; `takeCommitted()` does the work that needs the
   connection (`PRAGMA table_info`, `PRAGMA schema_version`), which is illegal from inside a
   commit or preupdate hook. The tenant owner calls it once the txn is durable and stamps `txid`.
2. **Levels.** `off` (hooks uninstalled, tenants without subscribers pay nothing) · `none`
   (tables, ops, rowids — all a live query needs) · `pk` · `row` · `row+old`. `setLevel` installs
   or removes the hooks and the authorizer layer.
3. **Lazy per-table metadata.** Column names, primary-key indexes and the `WITHOUT ROWID` flag
   come from `PRAGMA table_info` / `pragma_table_list`, resolved on first use and cached until
   `PRAGMA schema_version` moves. Before a table's metadata is known the hook records every
   column and the take step slices; afterwards `pk` mode reads only the key columns.
4. **`WITHOUT ROWID` tables report `rowid: null`.** The preupdate hook hands out `0` for both key
   arguments there (verified), so the pk object is the only identity and is always filled.
5. **Update-hook fallback** (`engine: "update"`, or a library without `SQLITE_ENABLE_PREUPDATE_HOOK`)
   sees no values: rows carry `table`, `op`, `rowid`, plus `pk` when the key is an
   `INTEGER PRIMARY KEY` alias. It also adds the `SQLITE_IGNORE`-on-`SQLITE_DELETE` layer so
   `DELETE FROM t` still reports every row, and it cannot see `WITHOUT ROWID` tables at all.
6. **DDL** is recorded by the authorizer layer at prepare time and confirmed at take time by a
   `PRAGMA schema_version` comparison, so a statement that was prepared but never run does not
   fabricate a schema event.
7. **Read-sets need a fresh prepare.** `Database.prepare` caches, and this driver does not call
   `sqlite3_set_authorizer` again when the callback is swapped, so a cached statement never
   re-authorises. `readSetOf` prepares its own non-persistent statement and finalises it.
8. **Column precision is best-effort on both sides.** A read-set column set intersects a
   write-set column set only when both are known; anything else (`count(*)`, an insert, a delete,
   capture without `trackColumns`) is `"*"` and invalidates the whole table. Over-invalidation is
   always safe; under-invalidation never happens.
9. **First keyed event is `rows`, later ones are `diff`.** A diff needs a previous result; the
   subscribe-time event has none (design §6.4 shows `rows` as "initial and on change").
10. **`maxRows` truncates rather than fails** for live queries (`truncated: true` on the event),
    unlike the one-shot query path where `maxRows` fails the request.

## Cost model

Per changed row: one preupdate callback plus `2 × columns` FFI value reads at `row+old`, none at
`none`. Per commit: one queue shift, one `schema_version` read, one bus publish per touched table
and one set-intersection per live query registered on a touched table (subscriptions are indexed
by table, so untouched tables cost nothing). Re-runs are coalesced per event-loop tick, so N
commits in one tick cost one run per affected subscription.

Budget (plan M6): 1k live subscriptions over 10 tables, one commit touching one table
< 2 ms in `afterCommit`. Measured on an M-series laptop by `test/realtime/facade.test.ts`:
**median 0.018 ms, worst 0.03 ms**; flushing the 100 affected re-runs afterwards takes 0.6 ms,
and only the subscriptions whose result actually moved emit an event.
