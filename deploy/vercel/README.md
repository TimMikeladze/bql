# Vercel database deployment (experimental)

BQL runs as a Bun container with disposable local SQLite files. A private Blob
store holds immutable snapshots, transaction records, catalog settings and
revocations. A conditional root update commits a write before BQL acknowledges it.
Concurrent writers can receive `CLOUD_CONFLICT`; BQL never rebases or replays their SQL.

The provider package pins `@vercel/blob` to **2.7.0**, independently of the database
core. Run `bun install --cwd deploy/vercel`, then `bun test deploy/vercel/test`.
`BlobObjectStore` accepts an injected SDK for credential-free tests.

Set these variables separately for each deployment environment:

- `BQL_DATA_DEPLOYMENT_ID`: unique stable ID (letters, digits, `_`, `-`).
- `BQL_DEPLOYMENT_ENV`: `preview`, `production`, or `development`.
- `BQL_AUTH_ADMIN_KEY` and `BQL_AUTH_JWT_KEY`: stable secrets; the JWT key is a
  base64 PKCS#8 Ed25519 signing key. Startup never generates replacement keys.
- `BLOB_READ_WRITE_TOKEN`: token for that environment's private Blob store.
- `VERCEL_BLOB_RETRIES=0`: required; the SDK otherwise retries ambiguous writes.
- `PORT=80`: Vercel's default container port.

Do not connect preview and production to the same store. The provider entrypoint
rejects a mismatch between `VERCEL_ENV` and `BQL_DEPLOYMENT_ENV`. Storage operations
also enforce the deployment namespace, including all referenced objects.

Build from the repository root:

```sh
docker build --platform linux/amd64 -f deploy/vercel/Dockerfile.vercel -t bql-vercel .
```

The image builds the repository's hash-pinned SQLite library and pins Bun 1.4.0.
Supply secrets through an environment file outside the build context. Initialize
once, explicitly, before serving:

```sh
docker run --rm --env-file /private/path/bql.env bql-vercel bun run deploy/vercel/server.ts init
docker run --rm --env-file /private/path/bql.env -p 8080:80 bql-vercel
```

For Vercel, stage the database source/scripts and provider source/package/lockfile
in a separate directory, with this directory's `Dockerfile.vercel` and
`vercel.json` at its root. Use the explicit container service in `vercel.json`:
`framework: null` selects the ordinary JavaScript install path. Keep environment
files, logs and smoke receipts outside the upload directory; inspect
`vercel deploy --dry --json` before deployment. Do not overwrite an existing
website's `.vercel` project link.

`/v1/cloud` describes supported operations. Query, atomic batch, database
create/list/stat/settings/delete and token mint/revoke use remote durability.
Interactive transactions, session SQL/PRAGMA, replication, realtime, generated
APIs, import and PITR are not supported by this initial cloud runtime.

Use SDK `execute(..., { idempotencyKey })` or `batch(..., { idempotencyKey })` to
resolve uncertain writes by repeating the identical request with the same key.
Results are retained for 24 hours. `COMMIT_UNKNOWN` includes `requestId`.
Generation-aware read-your-writes rejects positions from a replaced database.
One deployment root serializes publication; this is not a scalable multi-writer
throughput claim. No automatic object deletion is implemented.

## Qualification evidence — 2026-09-26

- Local adapter/runtime tests pass, including ambiguous responses, concurrent
  publication, queue limits, shutdown and SIGKILL recovery.
- Actual private Blob in `iad1`, SDK 2.7.0: atomic-create race, atomic-replacement
  race, origin visibility and stale-version rejection passed. The API's exact
  existing-blob create error is mapped narrowly; unrecognized errors stay ambiguous.
- Linux amd64 Docker image built successfully. Using the actual Blob backend,
  SQL, saved retry results, catalog, settings and token revocation survived killing
  and replacing the container with empty local disk.
- A protected Vercel preview built and started the container successfully. Through
  HTTPS, the shared smoke verified SQL, saved results, catalog, settings and
  revocation restored from the real Blob backend. Hosted writes also passed the
  smoke. A second, fresh Vercel preview recovered those hosted writes and passed
  all five checks. Both previews remain protected by Vercel authentication.
- The first attempt failed during ordinary workspace installation; explicit
  container service configuration fixed it. Vercel classified that new project's
  first deployment as production even with `--target preview`; subsequent
  deployments were previews. Inspect the returned target.

This is experimental pending cross-region races, large-object and throughput/
overwrite-limit qualification. Local tests are not provider proof.

Test deployment: [protected preview capabilities](https://bql-cloud-test-20260926-92039a-82ts5hqm5-linesofcode.vercel.app/v1/cloud).
The first attempt failed; the two subsequent preview deployments are READY.

To rerun the non-destructive live storage smoke test, set `BQL_BILLABLE_TESTS=1`,
`BLOB_READ_WRITE_TOKEN`, `VERCEL_BLOB_RETRIES=0`, and
`BQL_TEST_PREFIX=bql-qualification/`, then run:

```sh
bun run --cwd deploy/vercel storage:smoke
```

The smoke test writes randomly named objects and leaves them for inspection.
`deploy/shared/http-smoke.ts` seeds/verifies SQL and auth recovery; its receipt
contains a revoked token and must be stored privately.

References: [container images](https://vercel.com/docs/functions/container-images),
[explicit service runtimes](https://vercel.com/docs/services),
[Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk).
