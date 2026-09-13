# BunQL

Two packages, one repository.

| | |
| --- | --- |
| **[`@bunql/db`](packages/db)** | SQLite as a multi-tenant database server for Bun — WAL shipping, hook-driven realtime, an FFI driver with commit hooks and killable statements |
| **[`@bunql/bus`](packages/bus)** | AgenticBus: a durable message bus — subjects, consumer groups, leases, retries, a dead-letter path, and three tiers of exactly-once |

They are here together because they were solving the same problems apart: storage, replication,
tenancy and a change feed. [docs/monorepo.md](docs/monorepo.md) is why, what moved, and what comes
next.

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

Bun 1.4 or newer. Each package's README is the real documentation:
[@bunql/db](packages/db/README.md), [@bunql/bus](packages/bus/README.md).
