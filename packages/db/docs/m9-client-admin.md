# M9 — the admin surface on the client SDK

Plan of record for `client.admin`. Written 2026-09-13, implemented in the same session.

## Why

`bql.sh/client` covered the data plane and nothing else: statements, batches, transactions,
change feeds, live queries. Every control-plane route of design §6.5 — create, fork, snapshot,
restore, checkpoint, promote, backup, tokens — existed only as HTTP a caller hand-rolled, or as
`bql` on a terminal. Two consequences, both visible in the tree before this milestone:

1. **`src/cli.ts` carried a second HTTP client.** Its own `api()` helper, its own error mapping,
   its own body types (`DbStats`, `BackupStatusBody`, `VerifyBody`, `PromoteBody`, `ClusterBody`)
   written out again beside the ones the routes already publish. Two implementations of the same
   twenty routes, and only one of them tested against the server's own schemas.
2. **A dashboard, a provisioning script or a test fixture had to leave the SDK** to create the
   database it was about to query, and then hand-decode the error shape of §6.6 that the SDK
   already decodes.

## The decision

One namespace, `client.admin`, built lazily, backed by the same `HttpClient` every statement goes
through — so the bearer token, the `BQL-*` headers and the `BqlClientError` mapping of §6.6
happen in exactly one place, which is `http.ts`'s stated invariant.

```ts
const client = createClient({ url, token })   // the admin key, for admin routes
await client.admin.create("acme", { pageSize: 4096 })
await client.admin.fork("acme-copy", "acme", 4812)
await client.admin.snapshot("acme")
await client.admin.restore("acme", { at: 4800, into: "acme-recovered" })
```

Four choices worth writing down:

- **A namespace, not nineteen methods on `Client`.** The client is a browser object whose surface
  is `db()`, `txid()` and `close()`; an app that never provisions anything should not have to read
  past `revokeToken` to find `db`. `client.admin` is one getter and one lazily built object.
- **Admin calls never replay against another node.** `http.ts`'s C2 invariant allows a single
  replay on `NOT_PRIMARY`, and only where the caller opts in. Admin does not opt in: `promote`
  addresses the node that should be promoted, `snapshot` and `checkpoint` are node-local by
  definition, and an operator who typed a URL means that URL. `NOT_PRIMARY` surfaces as a throw
  whose `.primary` names where to go instead.
- **Methods return the server's own body**, not a `Db`. `create` answers `DatabaseStats`, which is
  what the route answers; `client.db(name)` is how you then query it. The embedded API returns a
  handle instead because in-process it already has one.
- **Types live in `protocol.ts`**, the module that is "the only description of the bql.sh wire
  format". The admin bodies are wire format too, and the CLI's five hand-written copies are
  deleted in favour of them.

## The surface

| method | route |
|---|---|
| `list()` | `GET /v1/db` |
| `create(name, options?)` | `POST /v1/db` |
| `fork(name, from, at?)` | `POST /v1/db` with `from` |
| `stat(db)` | `GET /v1/db/:db` |
| `configure(db, settings)` | `PATCH /v1/db/:db` |
| `delete(db)` | `DELETE /v1/db/:db` |
| `snapshot(db)` | `POST /v1/db/:db/snapshot` |
| `restore(db, options?)` | `POST /v1/db/:db/restore` |
| `checkpoint(db, mode?)` | `POST /v1/db/:db/checkpoint` |
| `dump(db)` | `GET /v1/db/:db/dump` |
| `import(name, data)` | `POST /v1/db/:db/import` |
| `replication(db)` | `GET /v1/db/:db/replication` |
| `promote(db, options?)` | `POST /v1/db/:db/promote` |
| `cluster()` | `GET /v1/cluster` |
| `backup(db)` | `GET /v1/db/:db/backup` |
| `verifyBackup(db, options?)` | `POST /v1/db/:db/backup/verify` |
| `generations(db)` | `GET /v1/db/:db/backup/generations` |
| `mintToken(options)` | `POST /v1/tokens` |
| `revokeToken(jti)` | `DELETE /v1/tokens/:jti` |

`dump` returns `{txid, bytes, stream}` — a `ReadableStream<Uint8Array>` and the txid the file is
consistent at, from `BQL-Txid`. `import` takes a `Blob`, an `ArrayBuffer`, a `Uint8Array` or a
`ReadableStream`, so a browser can hand it a `File` and Bun can hand it `Bun.file(path)`.

`restore` covers both sources: `{at, into}` restores from the local log, `{from: "s3", bucket,
prefix, generation, at, into}` from the bucket. The result is a union discriminated on `source`.

## Parity with the embedded API

`bql.sh` (in-process) had `create`, `fork`, `delete`, `list` and `stat` but not the three node-local
operations, which are one call each on the tenant it already holds. Added, same names, same shapes:
`snapshot(db)`, `restore(db, {at, into})` and `checkpoint(db, mode?)`. The bucket-sourced restore
stays server-only — it needs the S3 store the route builds, and an embedded caller that wants it
can `serve()`.

## The CLI

`src/cli.ts` now builds a client and calls `client.admin.*`. Deleted: `api()`, and the five body
interfaces. Kept: the flag parsing, the human-readable lines, `--json`, and the friendly
"cannot reach <url>" message, which is now a `NETWORK` `BqlClientError` recognised in `main`'s
catch rather than a `CliError` thrown by the fetch wrapper. Exit codes and stderr text are
unchanged — `DB_NOT_FOUND` still reaches stderr as `bql: DB_NOT_FOUND: …`.

## Tests

`test/client/admin.test.ts`, against the live server of `test/server/harness.ts`, the same fixture
the rest of the client tests use: the lifecycle round trip (create → stat → fork at a txid →
snapshot → restore → checkpoint → delete), dump/import as a byte round trip, a token minted and
then revoked, and the two failure shapes that matter — `DB_NOT_FOUND` from `stat`, and a
`CONFLICT` from creating a name that exists. The existing CLI tests cover the refactor: they drive
the same routes through the binary.
