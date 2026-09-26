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
