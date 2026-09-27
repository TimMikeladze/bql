# Experimental Cloudflare deployment

The Worker routes every request to one named `DatabaseContainer`, using the
configured environment and deployment ID. Its Bun process uses disposable SQLite
files and the shared synchronous R2 publication/recovery protocol. After five
minutes idle the container may sleep; waking reconstructs committed state from R2.
No shutdown flush is needed for acknowledged writes. Live sleep/wake and image replacement checks passed. Cross-region behavior,
larger databases, sustained load, and exhaustive provider limits remain
unqualified, so this target remains experimental.

The isolated package pins `@cloudflare/containers` 0.3.7 and Wrangler 4.135.0.
Run these from the repository root:

```sh
bun install --cwd deploy/cloudflare --frozen-lockfile
bun test deploy/cloudflare/test
bun run --cwd deploy/cloudflare check
```

Hosted Containers require the Workers Paid plan. Wrangler login alone does not
enable that product; check account eligibility before creating deployment
resources. See [Workers/Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).

The last command runs `wrangler deploy --dry-run`, including an actual Docker
build and Worker bundle; it needs Docker but no Cloudflare login. Wrangler sends
the Dockerfile through stdin, so the repository `.dockerignore` must allow the
two Cloudflare runtime files as well as the common database source.

For a live deployment, use a separate Worker, R2 bucket, deployment ID and
bucket-scoped S3 credentials for each preview/production environment. Edit
`wrangler.jsonc` with the Worker name, environment, deployment ID, bucket and R2
S3 endpoint. Install these Worker secrets with `wrangler secret put NAME`:

- `BQL_STORAGE_DEPLOYMENT_ID`, matching the deployment ID in Worker vars
- `BQL_ADMIN_KEY`, a stable randomly generated admin key
- `BQL_JWT_ED25519`, a stable base64-encoded Ed25519 PKCS8 private signing key
- `BQL_S3_ACCESS_KEY_ID` and `BQL_S3_SECRET_ACCESS_KEY`, restricted to this bucket

Use the same settings to run `bun deploy/cloudflare/server.ts init` **once**
before deployment. This explicitly creates an empty root and refuses to replace
an existing root. Then run `wrangler deploy` from `deploy/cloudflare`. Supply
initialization secrets via the process environment; do not commit them. Normal
startup never initializes a missing root. Changing storage credentials without
the matching storage identity fails closed.

The Worker forwards authorization, idempotency and causal-consistency headers
unchanged. Container startup allows only the declared settings/secrets. It does
not accept a caller-selected container name. SQL, atomic batches and the cloud
catalog/token operations are supported; `/v1/cloud` lists capabilities. Interactive
transactions, WebSockets and unsupported ordinary-server routes remain rejected.

`S3ObjectStore` uses Bun's SigV4 presigning and an injectable HTTP transport. It
sends `If-None-Match: *` on create and `If-Match` on replacement directly to the
private S3 endpoint. It never retries an uncertain PUT. Existing backup
`S3Store` behavior is unchanged. Credential-free tests include real loopback HTTP
requests and injected dropped responses.

To run the non-destructive, billable storage smoke test against a disposable R2
bucket, supply these environment variables through your secret manager:

- `BQL_BILLABLE_TESTS=1`
- `S3_BUCKET`
- `S3_ENDPOINT` (private R2 S3 API endpoint)
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `S3_REGION=auto`
- `BQL_TEST_PREFIX=bql-qualification/`

Run `bun run --cwd deploy/cloudflare storage:smoke`. It writes a randomly named
object and leaves it there for inspection. It checks create/CAS races, origin
visibility and stale-version rejection. Each CAS changes the bytes: S3 ETags can
be equal for equal content. Cloud root revisions must always advance.

Evidence as of 2026-09-26: local contract/routing/startup tests and Wrangler's
Docker/Worker dry run pass. The Linux amd64 image loads pinned SQLite 3.53.4 with
session, snapshot and WAL checksum features, and round-trips Zstandard data.
Real R2 atomic-create/CAS races, origin visibility and stale-version rejection
passed against a separate private bucket. A Linux container initialized the root
and wrote SQL, catalog/settings changes and a token revocation. After SIGKILL and
removing that container, a fresh container with empty local disk recovered the
SQL, saved retry result, catalog, settings and revocation from R2. After the
account's authorized Workers Paid upgrade, the hosted container recovered that
same state. Hosted writes then survived confirmed idle sleep/wake and a new image
rollout (container version 3); all five checks passed after each event. A readiness
bug found during this test is covered by regression tests: probes restore an
invalidated cache without requiring a user request first, but never initialize a
missing root.

Cross-region visibility, large databases, load capacity and exhaustive provider
payload/overwrite limits remain unqualified. See the [deployment CLI guide](../../packages/db/docs/cloud-deployments.md)
for repeatable provisioning, credentials and operational limits.

References: [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/),
[container secrets](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/).
