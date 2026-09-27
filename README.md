# bql.sh

One package: SQLite as a multi-tenant database server for Bun, and the durable bus that runs work
against it.

```sh
bun add bql.sh
```

| Import | What it is |
| --- | --- |
| **[`bql.sh`](packages/db)** | The embedded database — `Bql.open()`, a whole server in your own process |
| `bql.sh/client` | The client: `sql`, `live`, transactions, `client.admin` |
| `bql.sh/context` | Bun/Node resolver for saved organizations, projects, and endpoints |
| `bql.sh/sqlite` | The `bun:ffi` driver over a pinned libsqlite3: hooks, the authorizer, killable statements, changesets |
| `bql.sh/server` | Serve it: WAL shipping, replicas, S3 backup, a Raft control plane |
| `bql.sh/kysely`, `bql.sh/drizzle` | A Kysely dialect and a Drizzle driver over any of the above |
| `bql.sh/tenant`, `/wal`, `/realtime`, `/core`, `/http`, `/openapi`, `/dataapi`, `/graphql`, `/protocol` | The layers underneath, each reachable on its own |
| **[`bql.sh/bus`](packages/bus)** | A durable message bus — subjects, consumer groups, leases, retries, a dead-letter path, three tiers of exactly-once |
| `bql.sh/bus/client` | Its client and consumer |

Two binaries: `bql` for the database, `bql bus` for the bus.

Run the CLI from this checkout, or link it globally so `bql` works from any directory:

```sh
bun run cli --help
bun run cli db list
bun run cli:link           # once; global bql follows this checkout's source
bql --help
```

Bun's global bin directory (normally `~/.bun/bin`) must be on your `PATH`.
Run `bun unlink` from this checkout to remove the global link.
Both entry points use `BQL_URL` for the server URL and `BQL_ADMIN_KEY` for its admin
key (or `BQL_TOKEN` for a scoped token; it takes precedence over `BQL_ADMIN_KEY`).

## Saved endpoints

Organize independently deployed servers into local organizations, projects, and named
endpoints. These are connection settings on your machine; database and bus tokens
still control access on each server.

```sh
bql org add personal
bql switch personal
bql project add myapp
bql project use myapp

# Enter the deployment's BQL_AUTH_ADMIN_KEY at the hidden prompt.
bql endpoint add preview --url https://your-preview.vercel.app --prompt-token
bql endpoint add production --url https://your-production.example --prompt-token
bql link --org personal --project myapp --endpoint preview

bql context                       # show target without revealing credentials
bql db list
bql db create myapp
bql exec myapp --sql 'SELECT 1'
bql db list --endpoint production # override for this command
bql endpoint use production       # change this checkout's endpoint
bql endpoint use preview --default # default for this project outside linked checkouts
```

`bql link` offers terminal selection when required context is missing. In scripts,
supply the organization, project, and endpoint explicitly. Links live in
`.bql/project.json`, work from subdirectories, and contain IDs rather than secrets.
Linking adds `.bql/` to `.gitignore`. `bql unlink` removes the nearest project link.
`bql switch` and `bql project use` change global defaults without changing existing links.

All three record types support `list`, `inspect`, `update`, and `remove`, with
`--json` output. Rename with `bql project update myapp --name new-name`; existing links
keep working. Removing a nonempty organization or project requires `--recursive` and
only removes local connection settings, never remote databases. Deleted selections
produce an error until you select or link another record.

For protected Vercel deployments, save that endpoint's **Protection Bypass for Automation**
secret separately from its BQL token:

```sh
bql endpoint update preview --prompt-vercel-bypass
bql db list --endpoint preview
```

The CLI sends `x-vercel-protection-bypass` on HTTP requests and socket handshakes.
Cloud runtimes still support `bql exec` rather than interactive `bql shell` sessions.
CLI requests reject HTTP redirects, and named database connections reject cross-origin
primary-movement retries; select the destination endpoint explicitly instead.

For CI, reference environment variables instead of saving secret values:

```sh
bql endpoint add ci --org personal --project myapp \
  --url https://your-preview.vercel.app \
  --token-env CI_BQL_TOKEN --vercel-bypass-env CI_VERCEL_BYPASS

# Set these secrets through your CI environment, then select the context:
BQL_ORG=personal BQL_PROJECT=myapp BQL_ENDPOINT=ci bql db list --json
```

The registry defaults to `$XDG_CONFIG_HOME/bql` or `~/.config/bql`. Override it with
`--config-dir` or `BQL_CONFIG_DIR` to provision isolated CI configuration. Saved secrets
live in an owner-only `credentials.json`, separately from the registry. Use
`--clear-token` or `--clear-vercel-bypass` to remove credentials. Changing a service URL
clears its old credential references unless you supply new ones in the same command.

Selection order is explicit `--url`; explicit `--org`/`--project`/`--endpoint`; matching
`BQL_ORG`/`BQL_PROJECT`/`BQL_ENDPOINT` variables; legacy `BQL_URL` (bus: `BUS_URL`);
checkout link; global selection; then localhost. `--url` cannot be combined with explicit
selection flags. Within named selection, flags override environment values, then linked
IDs, then global defaults; changing a parent discards incompatible child selections.
`--cwd` changes link lookup without changing the shell directory.

Named endpoints use their own credentials and ignore ambient `BQL_TOKEN`, `BQL_ADMIN_KEY`,
and `BUS_TOKEN`. Explicit `--token` and `--vercel-bypass` override credentials for one
command. Direct URL mode keeps the old environment-variable behavior and never inherits
saved credentials; its bypass variables are `BQL_VERCEL_BYPASS` and `BUS_VERCEL_BYPASS`.

Add an optional bus connection to the same endpoint with separate credentials:

```sh
bql endpoint update preview --bus-url https://your-bus.example --prompt-bus-token
# Add --prompt-bus-vercel-bypass if that service is also protected.
bql bus stats --endpoint preview
bql bus publish work.hello '{"hello":"world"}' --endpoint preview
bql bus follow --endpoint preview --data ./replica
```

Missing bus settings fail explicitly; database credentials are never reused for the bus.
Use `--clear-bus` to remove that connection. Local `serve`, key management, and storage
initialization do not require a saved remote context.

Bun/Node scripts can resolve the same connection; browser SDKs remain explicitly configured:

```ts
import { resolveContext } from "bql.sh/context"
import { createClient } from "bql.sh/client"

const connection = await resolveContext({ org: "personal", project: "myapp", endpoint: "preview" })
const client = createClient(connection)
try {
  console.log(await client.db("myapp").sql`SELECT 1`)
} finally {
  client.close()
}
```

`resolveContext` returns credentials for client construction: don't log its result.
Use the exported `redactContext` for diagnostics. SDK transport behavior remains the
SDK's own; the resolver does not install CLI redirect or WebSocket policies.

The database and the bus ship together because they were solving the same problems apart: storage,
replication, tenancy and a change feed. [docs/monorepo.md](docs/monorepo.md) is why, what moved, and
what comes next.

Bun 1.4 or newer. Zero runtime dependencies.

```sh
bun install

bun run typecheck          # the repository's scripts, then both halves
bun run test               # both halves
bun run bytes              # no raw control bytes in any tracked file

bun run db sqlite:build    # build the pinned libsqlite3 bql.sh needs
bun run db test
bun run bus test
bun run bus dev
```

The repository keeps two source trees — `packages/db` and `packages/bus` — behind that one package,
so `bun run db <script>` and `bun run bus <script>` forward to the tree, and every script either half
already had still runs by its own name.

## The database

Thousands of small SQLite databases in one process, their WAL frames streamed to replicas over a
socket, backed up continuously to any S3-compatible bucket, with realtime subscriptions driven by
SQLite's own `preupdate`/`update` hooks rather than triggers or SQL parsing. It speaks its own API
and libsql's Hrana, so `@libsql/client`, Drizzle and Kysely reach it unmodified. The engine is a
`bun:ffi` driver over a pinned libsqlite3 that exposes what `bun:sqlite` does not: hooks, the
authorizer, query cancellation, per-connection limits, session changesets.

```sh
bun run db sqlite:build                      # once per machine; needs a C compiler
bun run db start                             # prints an admin key the first time, once
```

```ts
import { createClient } from "bql.sh/client"

const db = createClient({ url: "http://localhost:4321", token }).db("acme")

await db.sql`insert into todos(title) values (${"write it"})`.run()
const live = db.live`select * from todos where done = 0`.key("id")
live.on("diff", (e) => patch(e.added, e.removed, e.updated))
```

Phases 0, 1 and 2 are built, and so is the surfaces track: replica streaming and promotion, a Raft
control plane holding per-database leases off the write path, S3 shipping and point-in-time
restore, and one operation model rendered as REST, OpenAPI 3.1 and GraphQL. The control plane is on
the client too, under `client.admin`. [packages/db/README.md](packages/db/README.md) is the real
documentation; [packages/db/docs/api.md](packages/db/docs/api.md) is the API as built.

## The bus

Publish to a subject; durable subscriptions deliver to consumers with leases, retries, ordering and
a dead-letter path. One set of primitives covers a work queue, pub/sub and request/reply. Nothing
in the core knows what an agent is — agent patterns are conventions over subjects, which is what
keeps a plain background job queue a first-class use. It ships the library, the `bql bus` command
and a built dashboard.

```sh
bun run bus dev                              # bus, three consumers and the dashboard, on free ports

bql bus serve &
bql bus subscribe work 'work.>'
bql bus consume work --exec ./handle.sh &
bql bus publish work.resize '{"src":"a.png"}'
```

At-least-once by default, with three named tiers of exactly-once on top — a transactional ack in
embedded mode, atomic read-process-write inside the bus, and fenced ledgered effects against the
outside world. Fan-out happens on pull rather than on publish, so publishing is O(1) in the number
of subscriptions and a subscription created today can read last week. A JSON Schema registry with
computed compatibility checks, scoped tokens with affordable revocation, W3C `traceparent` end to
end, and epoch-fenced promotion over asynchronous log replication.
[packages/bus/README.md](packages/bus/README.md) is the real documentation.

## Together

Neither half imports the other yet. The coupling is the work after the move, in the order the
value lands: the bus swapping `bun:sqlite` for `bql.sh/sqlite`, then a commit hook publishing to
a subject as a transactional outbox with no dual-write window, then the bus's own replication and
backup giving way to WAL shipping. [docs/monorepo.md](docs/monorepo.md#the-work-after-this) has the
sequence and why each step is independently revertable.

## CI and releases

Every push and pull request to `main` runs both halves on Linux. macOS and Windows legs ran here
until 2026-09-26 and both were green — they were dropped for cost and wall-clock, not because they
stopped passing, and what they proved is written down in `packages/db/docs/e1-windows.md`,
`e2-windows-gate.md` and `c6-packaging.md` §1.

One package, one tag: `v0.1.0` publishes `bql.sh` with both halves in it, and the tag must match the
root `package.json` version or the release refuses. `bun run pack:check` is the gate the release runs
first — it packs, installs the tarball somewhere that knows nothing about this repository, builds
libsqlite3 from it, and then uses both halves and both binaries out of that install. Not on npm
yet.

## Deploying to Vercel, Cloudflare, or Fly

BQL uses your existing `vercel`, `wrangler`, or `fly` login. The CLI creates a
separate application, stages only BQL's shipped source and templates, and saves a
connection in your local organization/project registry. It never uploads your
current project or changes its Vercel link or Fly configuration.

Cloudflare and Vercel are **experimental**. Their containers restore committed
state from private object storage; Fly uses a persistent volume. A successful
cloud write means its data, catalog changes and retry result have been published
through one conditional root update. A stopped or replaced container restores
that root on its next request. Local container files are disposable.

Choose a provider based on where you want compute and durable data to live:

| Provider | Compute | Durable data | Default region | Status |
| --- | --- | --- | --- | --- |
| Vercel | Bun container | Private Vercel Blob | `iad1` | Experimental object mode |
| Cloudflare | Worker + named Bun container | Private R2 bucket | `wnam` bucket location hint | Experimental object mode |
| Fly | Bun machine | Encrypted persistent volume at `/data` | `sjc` | Persistent-disk server |

This deployment workflow provisions the **database**, not the message bus. Cloudflare
uses R2; Vercel uses Blob. Neither relies on the container's temporary filesystem
for acknowledged database writes. The database core has no provider SDK dependency:
provider packages contain the SDKs, and native CLIs supply account authentication.

### First deployment

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

The equivalent provider-specific starting points are:

```sh
# Vercel: use your logged-in team; start Docker first.
vercel login
bql deploy init --provider vercel --name my-bql-vercel --scope MY_TEAM --dir ./vercel-preview

# Cloudflare: use your account ID; enable Workers Paid and start Docker first.
wrangler login
bql deploy init --provider cloudflare --name my-bql-cloudflare --scope ACCOUNT_ID --dir ./cloudflare-preview

# Fly: use personal or an organization slug; builds run remotely.
fly auth login
bql deploy init --provider fly --name my-bql-fly --scope personal --dir ./fly-preview

# Plan and apply the chosen deployment directory.
bql deploy plan --dir ./fly-preview
bql deploy apply --dir ./fly-preview
bql deploy status --dir ./fly-preview
```

These are independent examples: provision only the provider you want. Names must
be available in the provider's namespace. Without `--name`, BQL generates a name.

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--provider vercel\|cloudflare\|fly` | `init` | Required deployment target |
| `--name NAME` | `init` | Provider application/resource name |
| `--environment preview\|production` | `init` | Defaults to `preview` |
| `--region REGION` | `init` | Defaults shown in the provider table |
| `--scope ACCOUNT` | `init` | Vercel team, Cloudflare account ID, or Fly organization |
| `--dir DIR` | All deploy commands | Directory containing `.bql/deployment.json`; defaults to cwd |
| `--config-dir DIR` | All deploy commands | Private workstation journal and connection registry |
| `--r2-credentials FILE` | Cloudflare `apply` | Private file containing bucket-scoped S3 credentials |
| `--json` | All deploy commands | Structured output; deploy commands already print JSON |

`init` and `plan` are offline. `apply` creates **billable** resources, builds and
publishes the app, checks readiness, verifies a SQL write/read, and saves a connection
profile. `status` reports recorded resources, current/pending release identities,
and a live readiness probe; it does not provision resources. A probe can wake a
sleeping container and incur usage.

For production, initialize a **different directory and resource name** with
`--environment production`. Vercel explicitly targets the selected environment;
Cloudflare uses a separate Worker, bucket, and named container. Do not edit an
existing deployment's identity or reuse preview storage for production.

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

To make the saved profile the default for a checkout, use the existing link command:

```sh
bql link --org deploy-vercel --project YOUR_APP --endpoint preview
bql db list
bql exec example --sql 'SELECT 42'
```

Use `deploy-cloudflare` or `deploy-fly` for the other providers. BQL admin and
signing keys remain stable across applies. Named connections use their own saved
credentials, so ambient tokens do not silently select a different database.

### How a cloud write becomes durable

1. The runtime reads the authoritative deployment root and checks authorization.
2. It executes the operation against a local SQLite working copy.
3. It uploads immutable, checksummed database records and any changed catalog,
   database settings, revocations, and retained request result.
4. It conditionally replaces the root using the version it originally read.
5. Only successful publication allows a successful write response.

The root points to a complete committed state. Two writers starting from the same
root cannot both replace that version: one wins and the other receives a conflict.
Tentative local changes are discarded on failure. Recovery loads the committed
root and verifies referenced records; shutdown hooks are not required to save an
already acknowledged write.

If a root update reaches storage but its response is lost, the caller receives
`COMMIT_UNKNOWN`. Resolve it with the **same idempotency key and identical request**;
BQL can return the saved result without executing the SQL again. A new key means a
new request. The retained-result window is 24 hours, not an unlimited exactly-once
guarantee. A definite `CLOUD_CONFLICT` requires the application to decide whether
to try the operation again against newer state.

Coming back after 30 days works through the same saved endpoint: the container
starts, reads Blob or R2, and restores committed state. On Fly, the machine reopens
its attached volume. Data retention is independent of container uptime; deleting
the store/volume or configuring an expiry policy can remove the data.

### State and recovery

`.bql/deployment.json` in the deployment directory contains resource identity and
settings, not secrets. Workstation journals, stable signing/admin keys, and staged
releases live below the BQL configuration directory (`~/.config/bql` by default,
`BQL_CONFIG_DIR` or `--config-dir` to override). Files containing credentials are
0600 and deployment directories are 0700. Back up that private configuration.
Changing an existing deployment's provider, identity, environment, or region is
refused. Create a separate deployment for production.

A failed apply reports resources it created and retains them. Run `status`, fix
the reported problem, and apply again. Completed provisioning steps are reused;
new BQL source produces a new release. Applying an older source version after a
newer one republishes it; historical success does not mean it is currently active.
An interrupted publish is tracked separately so returning to the last confirmed
release also republishes when necessary. Status reports saved resources and a live
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

### Capabilities and limits

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

### Costs and resource ownership

Cloudflare's Workers Paid base subscription was $5/month when qualified on
2026-09-26, with compute/storage/request usage charged separately. BQL never
upgrades the subscription automatically. Vercel and Fly charge according to their
plans and resources; sleeping compute does not remove retained storage charges.
Check current [Cloudflare Containers](https://developers.cloudflare.com/containers/platform/pricing/),
[Vercel Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing), and
[Fly](https://fly.io/docs/about/pricing/) pricing before applying.

Apply retains resources after a failure and does not delete them when local
configuration is removed. There is no `bql deploy destroy` command. Inspect and
remove unwanted test resources through the provider's CLI/dashboard only after
preserving any data you need. Backing up the workstation configuration preserves
connection/signing credentials; it is not an independent backup of the database.

### Qualification

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
used small databases in a single configured region. The Fly CLI test also created
and queried a database through its saved profile, restarted its machine, and
recovered the persisted row from the same volume. They do not establish
cross-region behavior, maximum database size, production load capacity, or all
provider payload and overwrite limits. Both object-mode providers remain
experimental pending those gates.

#### Measured storage path

The checked-in [R2](packages/db/bench/results/cloud-r2-2026-09-26.json),
[Blob](packages/db/bench/results/cloud-blob-2026-09-26.json), and
[in-memory baseline](packages/db/bench/results/cloud-fake-2026-09-26.json) reports use Bun
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

### Testing and implementation map

Run `bun run typecheck` alongside the checks below. Normal tests require no provider login or billable resources. Native process and
HTTP boundaries are injectable: the suite covers account selection, private
credentials, interrupted provisioning, resource ownership, missing storage,
release restoration, and endpoint registration with mocks. Local cloud tests use
fault injection and fresh caches; pack checks install the actual tarball and
exercise the deployment workflow, saved profile, and SQL against a local server.

```sh
# From the repository root, after bun install and bun run db sqlite:build:
bun test packages/db/test/deploy packages/db/test/cloud
bun install --cwd deploy/vercel --frozen-lockfile
bun test deploy/vercel/test deploy/cloudflare/test
bun run deploy:templates:check
bun run pack:check

# Local baseline: no cloud credentials or billing.
bun packages/db/bench/cloud.ts
```

For a real storage test, use disposable private storage and set credentials through
your secret manager, never command arguments. Both providers require
`BQL_BILLABLE_TESTS=1` and `BQL_TEST_PREFIX=bql-qualification/`. R2 additionally
requires `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and
`S3_REGION=auto`. Blob requires `BLOB_READ_WRITE_TOKEN` and `VERCEL_BLOB_RETRIES=0`.
Add `BQL_RECOVERY_TESTS=1` to exercise a lost root-write response and empty-cache
recovery, then run the chosen provider's `storage:smoke` command:

```sh
bun run --cwd deploy/cloudflare storage:smoke
# Or:
bun run --cwd deploy/vercel storage:smoke
```

These opt-in tests retain their uniquely named objects. The manual CI workflow uses
`BQL_TEST_BLOB_TOKEN` or `BQL_TEST_R2_BUCKET`, `BQL_TEST_R2_ENDPOINT`,
`BQL_TEST_R2_ACCESS_KEY_ID`, and `BQL_TEST_R2_SECRET_ACCESS_KEY` repository/environment
secrets. Normal push/PR CI runs mocked tests and the clean-package check only.

| Area | Source |
| --- | --- |
| Native CLI orchestration, journals, profiles | [`packages/db/src/deploy`](packages/db/src/deploy) |
| Shared publication and recovery protocol | [`packages/db/src/cloud`](packages/db/src/cloud) |
| Vercel adapter, Docker image, examples | [`deploy/vercel`](deploy/vercel) |
| Cloudflare Worker/container, R2 examples | [`deploy/cloudflare`](deploy/cloudflare) |
| Shipped provider templates | [`packages/db/deploy-templates`](packages/db/deploy-templates) |
| Template synchronization | [`scripts/deploy-templates.ts`](scripts/deploy-templates.ts) |
| Measurement runner | [`packages/db/bench/cloud.ts`](packages/db/bench/cloud.ts) |
| Opt-in billable CI | [`.github/workflows/cloud-qualification.yml`](.github/workflows/cloud-qualification.yml) |

If you change provider examples, run `bun run deploy:templates` to synchronize the
shipped copies, then `bun run deploy:templates:check`. Provider SDKs stay in their
isolated packages; the database core does not gain those runtime dependencies.
