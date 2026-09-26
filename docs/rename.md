# The rename to bql.sh

One product, one published package: **`bql.sh`**, with flat subpaths. No npm org, no second
package. Nothing is published yet, so this is one break with no migration path to maintain.

## What becomes what

| Was | Is |
| --- | --- |
| `@bunql`&#47;`db` | `bql.sh` — `bql.sh`, `bql.sh/client`, `/sqlite`, `/server`, `/kysely`, `/drizzle`, `/protocol`, `/tenant`, `/realtime`, `/wal`, `/core`, `/http`, `/openapi`, `/dataapi`, `/graphql` |
| `@bunql`&#47;`bus` | `bql.sh/bus`, `bql.sh/bus/client` — prefixed, because a flat `./client` already belongs to the database |
| `bql` (binary) | `bql` |
| `bql-bus` (binary) | `bql-bus` |
| `BQL_*` (env) | `BQL_*` |
| `BQL-Ack`, `BQL-Primary`, … (headers) | `BQL-Ack`, `BQL-Primary`, … |
| `bql.toml` | `bql.toml` (`BQL_CONFIG` names another) |
| `bql_*_total` (metrics), `bql_db_config_int` (build shim) | `bql_*_total`, `bql_db_config_int` |
| `BqlError`, `BqlClientError`, `BqlDialect`, `bql.sh` | `BqlError`, `BqlClientError`, `BqlDialect`, `Bql` |
| `.bql-bus/` (bus state dir) | `.bql-bus/` |
| "bql.sh" in prose | "bql.sh" |

One thing deliberately keeps its name: the **GitHub repository**, whose URL stays
`TimMikeladze/bql` until someone renames it there — no package carries that name any more either
way. The bus has no separate product name of its own; it is `bql.sh/bus`, and in prose "the bus".

## The published shape

The root manifest becomes the package. `packages/db` and `packages/bus` stay as they are on disk —
two source trees, two dev manifests (`bql-db`, `bql-bus`, both private), one workspace install, one
CI matrix — and the root `exports` map points into both. A consumer sees one package and one version;
a contributor keeps `bun run db test` and `bun run bus test`.

Everything publishes as **TypeScript source**, which is what `bql.sh` already did. That retires
the bus's `prepack`/`postpack` manifest rewriting (it existed to repoint `./src/…` at `./dist/…` for
a `files: ["dist"]` tarball). The one build that survives is the dashboard: the bus CLI serves
`dist/dashboard`, so the root `prepack` builds it and `files` ships it.

Releases collapse to one tag. `db-v*` and `bus-v*` become `v*`, and the tag has to match the root
manifest's version or the release refuses — the rule the two had, applied once.

## Order

1. Strings and identifiers, repo-wide, in the order the table above reads (longest first, so
   `bql.sh/sqlite` is not left half-renamed by the `bql.sh` pass). GitHub URLs and absolute
   `workspace/bql` paths are protected.
2. Manifests: the root becomes `bql.sh` (public, both binaries, the merged `exports`, the merged
   `files`); the two inner manifests go private and lose their `bin`, `exports` and packing scripts;
   root scripts' `--filter` targets follow the new names; `release.yml` collapses to `v*`.
3. Renamed files: `bql.toml` fixtures, `experiments/bql_native.c`, the bus's state directory.
4. Verification, all of it: `typecheck`, both suites, `bytes`, `routes:check`, `pack:check`,
   `verify-pack`, a rebuilt libsqlite3 (the shim symbol changed), a live server answering `bql`'s own
   CLI, and the site's tests.

## What it cost

Four thousand references across 323 files, and four things that only a test could have caught:

- **`Bql` is an identifier and "bql.sh" is prose**, and the same six letters were both. The pass that
  renamed the product name broke `export default BunQL` into `export default bql.sh`; `tsc` found
  every one, including inside the Markdown code blocks the site renders and the site's own
  build resolves by exact text.
- **A Prometheus metric name cannot contain a hyphen.** `agenticbus_messages_published` wanted to
  become `bql-bus_…`, which scrapes as a parse error rather than as a metric.
- **The exports contract test read the manifest it no longer lives next to.** It now reads the root's,
  and checks both trees' subpaths and both READMEs' import lines.
- **Nothing links the root package into its own `node_modules`.** Bun self-links workspace members,
  and the root manifest is not one, so `import "bql.sh/sqlite"` from inside the repository did not
  resolve at all. `scripts/self-link.ts` runs on `postinstall`.

Verified: `typecheck`, 1566 database tests, 137 bus tests, 18 site tests, `bytes`, `routes:check`, a
rebuilt libsqlite3 (the shim symbol is `bql_db_config_int` now), and the site rebuilt from the
renamed READMEs.
