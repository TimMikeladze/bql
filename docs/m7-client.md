# M7 — client SDK, embedded API, CLI

Companion to `design.md` §9 and `plan-phase0.md` M7. What was built, the decisions the design left
open, and every deviation.

## Module map

| file | invariant |
|---|---|
| `src/client/values.ts` | the only place wire values become JS values and back; nothing here may touch a Bun or Node global |
| `src/client/errors.ts` | every failure a caller sees is a `BunQLClientError` carrying the server's `code`, `status` and `txid` |
| `src/client/sql.ts` | a tagged template produces parameters, never interpolated SQL |
| `src/client/http.ts` | one place builds a request, so the token, `BunQL-Min-Txid` and the txid bookkeeping cannot be forgotten by a caller |
| `src/client/socket.ts` | one socket per client, opened lazily; every subscription is an intent that survives a reconnect |
| `src/client/stream.ts` | an SSE reader that owns its reconnect and resumes from the last txid it saw |
| `src/client/feed.ts` | a subscription is an emitter and an async iterable at once, and one delivery point feeds both |
| `src/client/index.ts` | `Db` is the same interface whether it is backed by HTTP, a socket, or the engine in this process |
| `src/embedded.ts` | one `ServerRuntime` owns the registry; `serve()` mounts the HTTP surface over that same runtime rather than opening a second one |
| `src/cli.ts` | `serve` runs in-process, every other command is an HTTP client of a running server |

## The `Db` interface

One interface, three backings (HTTP + WS in `src/client`, in-process in `src/embedded.ts`).
Modelled on `Bun.SQL`, per design §9.1 and decision 7 of the phase-0 plan.

```ts
db.sql<T>`select * from t where id = ${id}`      // → Result<T>: T[] with .count, .command, …
db.sql`…`.values()                               // → rows as arrays
db.sql`…`.first()                                // → T | null
db.sql`…`.run()                                  // → the metadata, no rows
db.stmt`…`                                       // → {sql, args}, for batch
db.execute(sql, args?, options?)                 // → Result
db.unsafe(sql, args?)                            // → the same Query object, SQL from a string
db.batch([db.stmt`…`, {sql, args}], {atomic})    // → Result[]
db.transaction(async tx => { … }, {via})         // WS `tx.*`, or the HTTP baton
db.changes({tables, since, include})             // AsyncIterable + .on("change"|"reset"|"error")
db.live<T>`…`.key("id")                          // .on("rows"|"diff"|"error"), .close()
```

A result array carries `count`, `command`, `lastInsertRowid`, `affectedRows`, `txid`, `columns`,
`types`, `durationUs` and `vmSteps`. `command` is the statement's leading keyword, upper-cased,
looking through a leading `WITH …` so a CTE that inserts reports `INSERT`.

## Decisions

1. **The client authenticates a WebSocket with `hello`, not with `?token=`.** A token in a URL
   travels through every proxy log between here and the server, and only Bun's `WebSocket` accepts
   headers. The design's own escape hatch (§7: "or a first `hello` message") is portable, so it is
   the only path the SDK uses.

2. **A query object is lazy and runs once.** `db.sql\`…\`` builds `{sql, args}`; the request is not
   sent until `then`, `values`, `first` or `run` is called, which is what lets the same object
   choose `rows: "array"` or `rows: "object"` from the method that was called rather than from an
   option set earlier. The promise is memoised, so awaiting twice does not run the statement twice.

3. **`intMode` decides what an out-of-range integer becomes.** `"number"` (the default) throws
   rather than silently rounding: `{"$i": "9007199254740993"}` has no `number` that is equal to it,
   and returning a wrong one is worse than failing. `"bigint"` and `"string"` return that.
   `intMode` never affects integers that fit a double — those are always `number`, so the common
   row is unchanged.

4. **`consistency: "ryw"` sends the txid it has, on every request, as a header.** The client keeps
   one number per database and raises it from every response, every change event and every live
   result. `"primary"` and `"any"` travel as the body field; a single node accepts both and neither
   changes anything (docs/m5-server.md).

5. **The change feed is `fetch` + `ReadableStream`, never `EventSource`.** `EventSource` cannot set
   `Authorization`, so it would force the token into the query string (decision 1). Reconnect is
   the feed's own: it resumes from the highest txid it delivered, so an event is never delivered
   twice and a gap the ring cannot serve arrives as `reset`.

6. **A feed buffers for an iterator only once somebody asks for one.** `for await` and
   `.on("change")` see the same events, but a feed used only as an emitter would otherwise grow a
   queue nobody ever drains, for as long as it is open. The first `[Symbol.asyncIterator]()` turns
   buffering on; events before that reach the listeners and are not kept.

7. **A live query starts on the microtask after it is created.** That is what makes
   ``db.live`…`.key("id").on("rows", …)`` work as one expression: `key` and the first `on` are
   registered before the subscription goes out, and `key` after the start is an error rather than a
   silent no-op.

8. **Embedded mode is the server's own runtime, not a second one.** `BunQL.open` builds a
   `ServerRuntime`; `serve()` hands that runtime to `startServer`. Two runtimes over one registry
   would each install an `AuthorizerHub` on the same connection and fight for SQLite's single
   authorizer slot, which `src/server/runtime.ts` names as its first invariant.

9. **The embedded API runs as the admin principal.** It is in-process code with the data directory
   already open; a token would be a lock whose key is taped to it. Tokens are for the network
   surface, and `serve()` is where they start applying again.

10. **Embedded results are decoded through the same codec as the client's.** The execution path is
   `src/server/exec.ts`, which produces the wire shape; running it back through the client decoder
   costs a pass over the rows and buys the guarantee that `bq.db(x).sql\`…\`` and
   `client.db(x).sql\`…\`` return the identical value for every SQLite type.

11. **`db.sync` is the same code path without the promise.** Every read and write in this
    implementation is synchronous underneath (design §9.2: "resolves synchronously under the
    hood"); the async surface wraps the same call in `Promise.resolve`, so the two cannot drift.

12. **The CLI's remote commands are a thin HTTP client, and `serve` is the only one that opens the
    data directory.** A `bunql db create` against a running server that also holds the directory
    open would be a second writer for the catalog.

## Deviations from design §9

- **`sql.raw()` is an alias of `.values()`.** Design §9.1 lists both as "already familiar from
  `Bun.SQL`"; in `Bun.SQL` `raw()` is the un-decorated array form, which is what `values()` returns
  here. Two names for one thing rather than an invented second meaning.
- **`sql.begin()` is spelled `db.transaction()`.** Design §9.1 names both; the plan's own example
  (§9.1, line 6) uses `transaction`, and `begin` is the libsql spelling of the same thing.
- **`bunql promote` and `bunql cluster` are not implemented.** They are phase 1 and 2 (design §11),
  and the server route they would call does not exist either (docs/m5-server.md).
- **`--replica-of` is not a flag on `bunql serve`.** Replication is phase 1.
- **`bunql restore --at` accepts a timestamp as well as a txid.** Design §9.3 asks for
  `<txid|time>`, but `POST /v1/db/{db}/restore` in M5 took a txid only. The route now resolves an
  ISO-8601 or epoch-millisecond `at` against the tenant's transaction log, which carries a
  microsecond timestamp per record; the same resolution applies to `from.at` on `POST /v1/db`, so
  `bunql db fork x --from y@2026-09-11T10:00:00Z` works too.
- **`BunQL.open({ s3 })` is not accepted.** S3 shipping is phase 1; the option would be a promise
  the node cannot keep.
- **Kysely and Drizzle adapters are not shipped.** Design §9.2 puts them in phase 1.
- **`bunql exec <db> --sql …` is an addition**, not a design §9.3 command. `shell` needs a
  terminal, and a one-shot statement is what a script and a test actually want.

## Environment overrides

Every `[section] key` of design §9.4 has a `BUNQL_<SECTION>_<KEY>` override, and the short aliases
that predate this milestone keep working. The full table is in `src/server/config.ts` and in the
README.

`BUNQL_DATA_DIR` did not work before this milestone: `data.dir` was reachable only as `BUNQL_DIR`,
which is not the name the section-plus-key rule produces. Both names are accepted now, and so are
`BUNQL_SERVER_PORT` alongside `BUNQL_PORT`, `BUNQL_AUTH_ADMIN_KEY` alongside `BUNQL_ADMIN_KEY`, and
the same pairing for every other key.

## Testing

| file | covers |
|---|---|
| `test/client/client.test.ts` | every verb over a live server: tagged templates, `values`/`first`/`run`, exotic values under each `intMode`, named and positional arguments, batch atomic and not, errors as `BunQLClientError`, the `BunQL-Min-Txid` header, `client.txid` |
| `test/client/realtime.test.ts` | `changes` as an iterable and as an emitter, resume after a dropped stream, `live` rows and diff over WS and over the SSE fallback |
| `test/client/tx.test.ts` | `transaction` over the socket and over the baton, rollback on throw |
| `test/embedded/embedded.test.ts` | async and sync parity, create/fork/list/delete, `on("commit")`, in-process changes and live, `serve()` answered over HTTP |
| `test/cli/cli.test.ts` | `db create`, `list`, `stat`, `fork`, `delete`, `exec`, `snapshot`, `checkpoint` and `token` as spawned processes against a running server, plus the flag parsers |

`bun test` runs 486 tests across the repository in about 12 s; `bun run typecheck` is clean. The
three README examples were run as written — the curl block against `bun start`, and the client and
embedded snippets as scripts — before being committed.
