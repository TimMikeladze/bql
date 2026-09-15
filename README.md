# BunQL

Two packages, one repository: a database server and the durable bus that runs work against it.

| | |
| --- | --- |
| **[`@bunql/db`](packages/db)** | SQLite as a multi-tenant database server for Bun — WAL shipping, hook-driven realtime, an FFI driver with commit hooks and killable statements |
| **[`@bunql/bus`](packages/bus)** | AgenticBus: a durable message bus — subjects, consumer groups, leases, retries, a dead-letter path, and three tiers of exactly-once |

They are here together because they were solving the same problems apart: storage, replication,
tenancy and a change feed. [docs/monorepo.md](docs/monorepo.md) is why, what moved, and what comes
next.

Bun 1.4 or newer. Zero runtime dependencies in either package.

```sh
bun install

bun run typecheck          # the repository's scripts, then both packages
bun run test               # both packages
bun run bytes              # no raw control bytes in any tracked file

bun run db sqlite:build    # build the pinned libsqlite3 @bunql/db needs
bun run db test
bun run bus test
bun run bus dev
```

`bun run db <script>` and `bun run bus <script>` forward to that package, so every script each
package already had still runs by its own name.

## `@bunql/db`

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
import { createClient } from "@bunql/db/client"

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

## `@bunql/bus`

Publish to a subject; durable subscriptions deliver to consumers with leases, retries, ordering and
a dead-letter path. One set of primitives covers a work queue, pub/sub and request/reply. Nothing
in the core knows what an agent is — agent patterns are conventions over subjects, which is what
keeps a plain background job queue a first-class use. It ships the library, the `agenticbus` binary
and a built dashboard.

```sh
bun run bus dev                              # bus, three consumers and the dashboard, on free ports

agenticbus serve &
agenticbus subscribe work 'work.>'
agenticbus consume work --exec ./handle.sh &
agenticbus publish work.resize '{"src":"a.png"}'
```

At-least-once by default, with three named tiers of exactly-once on top — a transactional ack in
embedded mode, atomic read-process-write inside the bus, and fenced ledgered effects against the
outside world. Fan-out happens on pull rather than on publish, so publishing is O(1) in the number
of subscriptions and a subscription created today can read last week. A JSON Schema registry with
computed compatibility checks, scoped tokens with affordable revocation, W3C `traceparent` end to
end, and epoch-fenced promotion over asynchronous log replication.
[packages/bus/README.md](packages/bus/README.md) is the real documentation.

## Together

Neither package depends on the other yet. The coupling is the work after the move, in the order the
value lands: the bus swapping `bun:sqlite` for `@bunql/db/sqlite`, then a commit hook publishing to
a subject as a transactional outbox with no dual-write window, then the bus's own replication and
backup giving way to WAL shipping. [docs/monorepo.md](docs/monorepo.md#the-work-after-this) has the
sequence and why each step is independently revertable.

## CI and releases

Every push and pull request to `main` runs both packages. `@bunql/db` gates on macOS (arm64), Linux
(x64) and Windows (x64), all three hard. `@bunql/bus` runs on macOS and Linux; Windows is its own
piece of work, with its own evidence, the way BunQL's was.

Releases are tag-prefixed and independent: `db-v1.2.3` publishes `packages/db`, `bus-v0.1.0`
publishes `packages/bus`. The tag must match that package's `package.json` version or the release
refuses. Neither is on npm yet.
