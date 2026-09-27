# Deploying BQL

BQL uses your existing `vercel`, `wrangler`, or `fly` login. The CLI creates a
separate application, stages only BQL's shipped source and templates, and saves a
connection in your local organization/project registry. It never uploads your
current project or changes its Vercel link or Fly configuration.

Cloudflare and Vercel are **experimental**. Their containers restore committed
state from private object storage; Fly uses a persistent volume. A successful
cloud write means its data, catalog changes and retry result have been published
through one conditional root update. A stopped or replaced container restores
that root on its next request. Local container files are disposable.

## First deployment

Install Bun and the provider CLI and sign in (`vercel login`, `wrangler login`,
or `fly auth login`). For Vercel and Cloudflare, start Docker with Linux amd64
build support. Cloudflare Containers requires Workers Paid; BQL does not purchase
or upgrade subscriptions automatically.

Use a separate directory for each deployment:

```sh
mkdir bql-preview
cd bql-preview
bql deploy init --provider vercel --scope my-team
bql deploy plan
bql deploy apply
bql deploy status
```

Use `--provider cloudflare --scope ACCOUNT_ID` or
`--provider fly --scope personal` instead for those providers. Optional init flags
are `--name`, `--region`, and `--environment preview|production`. Defaults are
preview and regions `iad1`, `wnam` (an R2 location hint), or `sjc`, respectively.
Names must be globally available where the provider requires that. Init and plan
do not contact providers. Apply creates **billable** compute and storage.

Cloudflare's first apply creates a private bucket and, if necessary, explains how
to supply its credentials. At the linked R2 token page, create Object Read & Write
credentials limited to that bucket. Wrangler login cannot create these S3 keys.
Save them outside your application in a private file:

```dotenv
BQL_S3_ACCESS_KEY_ID=your-access-key
BQL_S3_SECRET_ACCESS_KEY=your-secret-key
```

```sh
chmod 600 /private/path/r2.env
bql deploy apply --r2-credentials /private/path/r2.env
```

Subsequent applies use the saved private credentials. Never put keys in command
arguments, Git, or chat. Vercel creates private Blob storage linked only to the
selected environment, and retrieves its token through the native CLI. Deployment
Protection stays enabled; the saved connection includes an automation bypass
credential alongside BQL's admin credential.

Apply prints a connection profile with `org`, `project`, and `endpoint` selectors.
Use those values with existing commands, for example:

```sh
bql db create example --org deploy-vercel --project YOUR_APP --endpoint preview
bql exec example --sql 'select 42' --org deploy-vercel --project YOUR_APP --endpoint preview
```

The global connection selection does not change. Apply also retains a small
`bql_deploy_…` database for its scoped SQL smoke check. Repeating the check verifies
the same identity without creating another database.

## State and recovery

`.bql/deployment.json` in the deployment directory contains resource identity and
settings, not secrets. Workstation journals, stable signing/admin keys, and staged
releases live below the BQL configuration directory (`~/.config/bql` by default,
`BQL_CONFIG_DIR` or `--config-dir` to override). Files containing credentials are
0600 and deployment directories are 0700. Back up that private configuration.
Changing an existing deployment's provider, identity, environment, or region is
refused. Create a separate deployment for production.

A failed apply reports resources it created and retains them. Run `status`, fix
the reported problem, and apply again. Completed provisioning steps are reused;
new BQL source produces a new release. Status reports saved resources and a live
readiness check, not a complete provider inventory. Readiness may wake a sleeping
container and incur usage.

A command can succeed remotely even if the connection or local process dies
before its resource ID is saved. If the next apply encounters an existing resource
without recorded ownership, it refuses to adopt it. Reconcile that resource and
recover the private journal before retrying, or use a different deployment name.
There is no automatic deletion, destructive rollback, or resource adoption.
Missing recorded storage or a missing previously initialized root is an error;
apply will not replace it with an empty database.

The first initialization creates a root only when absent. Server startup and
readiness never initialize storage. R2/Blob data remains after 30 days unless you
or a provider lifecycle policy remove it; container lifetime does not determine
data retention. The request-result retry window is separately limited to 24 hours.
Do not configure automatic expiry on the deployment's objects. BQL currently does
not garbage-collect old objects, so retained storage grows with writes.

## Capabilities and limits

| Capability | Vercel / Cloudflare object mode | Fly persistent disk |
| --- | --- | --- |
| SQL reads and writes, atomic batch | Supported | Supported |
| Catalog, database settings, token revocation | Durably published | Persistent disk |
| Container replacement recovery | Private Blob / R2 | Attached volume |
| Explicit keyed retry result | 24-hour window | Ordinary server semantics |
| Interactive transactions, realtime | Rejected | Supported |
| Import, fork, PITR, generated APIs, replication | Rejected in object mode | Ordinary server capabilities |
| Multi-region writes | One global conditional root; conflicts possible | Not configured by this workflow |

Object mode refreshes authoritative metadata from the storage origin and uses
conditional writes. It does not retry uncertain writes automatically or silently
re-execute conflicting SQL. Keep an explicit idempotency key when resolving an
unknown result. Retry retention and generation-aware read-your-writes are
separate from how long your database is retained.

Cloudflare uses one named container, a basic instance, and five-minute idle sleep.
Vercel containers can overlap during deployments; the global root serializes
publication. Fly creates one encrypted 1 GB volume, one machine, IPv6 and shared
IPv4, with automatic stop/start. This workflow does not configure high availability
or independent backups. Retained volumes, objects, compute, requests and data
transfer can all incur provider charges; consult current provider pricing.

## Qualification

As of 2026-09-26, deterministic local tests cover conditional publication,
conflicts, ambiguous outcomes, cache invalidation, revocation, request-result
recovery, empty-disk recovery, shutdown and readiness. Real R2 and private Blob
passed atomic create/replace, stale-version rejection and origin visibility tests.
Both also passed an injected loss of a successfully persisted root response, then
empty-cache recovery and resolution of the original request key without SQL replay.

Vercel's isolated test project recovered acknowledged SQL, catalog/settings,
revocations and saved retry results across two preview deployments. Cloudflare
passed the same checks from local Docker to hosted Containers, through confirmed
idle sleep/wake, and after a new image rollout (container version 3). These tests
used small databases in a single configured region. They do not establish
cross-region behavior, maximum database size, production load capacity, or all
provider payload and overwrite limits. Both object-mode providers remain
experimental pending those gates.

### Measured storage path

The checked-in [R2](../bench/results/cloud-r2-2026-09-26.json),
[Blob](../bench/results/cloud-blob-2026-09-26.json), and
[in-memory baseline](../bench/results/cloud-fake-2026-09-26.json) reports use Bun
1.4.0 on macOS arm64. The remote measurements ran from one workstation against the
isolated R2 bucket and private Blob store. They include real storage latency but
exclude hosted container boot, frontend routing and client network overhead.
Each nonempty row contains 1 KiB of random data. Warm numbers are medians of five
reads; these are observations, not service-level guarantees.

| Provider | Payload | Empty-cache open + first query | Warm read median | Restore transfer |
| --- | ---: | ---: | ---: | ---: |
| R2 | 0 | 3,188 ms | 845 ms | 9.4 KB |
| R2 | 100 KiB | 2,012 ms | 476 ms | 114 KB |
| R2 | 8 MiB | 2,888 ms | 434 ms | 8.51 MB |
| Private Blob | 0 | 1,328 ms | 396 ms | 9.4 KB |
| Private Blob | 100 KiB | 1,488 ms | 377 ms | 114 KB |
| Private Blob | 8 MiB | 3,434 ms | 388 ms | 8.51 MB |

In each two-writer race, one write committed and one returned `CLOUD_CONFLICT`;
fresh recovery contained exactly the successful writes. The 8 MiB scenarios each
made 97 protocol reads and 42 write attempts across setup, recovery, warm reads,
contention and final verification. They transferred about 28.3 MB down / 31.0 MB
up and retained 37 objects totalling about 31.0 MB, including unpublished
candidates. This shows why conflict traffic and retained immutable objects matter
for cost even when the logical database is small.

For an approximate operation-only estimate, multiply measured GETs by the current
read rate and create/replace attempts by the current write rate. At R2 Standard's
published $0.36/$4.50 per million read/write operations, 97 reads and 42 writes are
about $0.000224 before free allowances and billing rounding. Storage, compute,
base subscriptions and provider-specific charges are separate. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
Vercel's rates vary by region and request classification; use its current
[Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing).
The meter counts protocol calls, not SDK-internal HTTP requests or billable usage
reported by a provider.

The largest measured payload is 8 MiB, not a tested maximum. The benchmark uses a
120-second request budget; default hosted requests use 30 seconds. Observed
restores were below that default, but the workstation measurements do not qualify
hosted disk/memory ceilings or provider execution limits. Cross-region tests,
sustained load and larger sizes remain explicit experimental gates.

Run `bun packages/db/bench/cloud.ts` for the local baseline. Real storage requires
`BQL_BILLABLE_TESTS=1` plus the provider variables described in the deployment
example README and `--provider r2|blob`. Objects are retained under unique test
roots. `BQL_RECOVERY_TESTS=1` adds a lost-CAS-response/empty-cache recovery check to
the provider storage smoke runners; build the pinned SQLite library first.
The `cloud-qualification.yml` workflow runs only by manual dispatch with the
confirmation `BILLABLE` and secrets in the `cloud-qualification` environment.
