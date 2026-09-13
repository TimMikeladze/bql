# The monorepo: `@bunql/db` and `@bunql/bus`

AgenticBus moves into this repository. Two packages under one root, one lockfile, one CI
pipeline, two independently versioned npm publishes.

## Why

The two projects were solving overlapping problems in parallel and neither could use the
other's answer:

- **Storage.** The bus opens `bun:sqlite` directly (`packages/bus/src/bus/store.ts`). BunQL
  ships its own SQLite over `bun:ffi` with commit/preupdate/WAL hooks, a killable statement
  deadline, an authorizer and session changesets — none of which `bun:sqlite` exposes.
- **Replication.** The bus ships its own log over HTTP with a file lease and asynchronous lag
  (`packages/bus/src/bus/replication.ts`, 224 lines). BunQL ships WAL frames with a segment log,
  snapshots, point-in-time restore and epoch-fenced promotion.
- **Tenancy.** The bus separates workspaces by column in one file. BunQL separates tenants by
  database, with per-database quotas, retention and checkpoint policy.
- **Realtime.** The bus polls to refresh its dashboard. BunQL has a change feed driven by commit
  hooks.

None of that is worth a cross-repository dependency with a version skew between them. In one
repository it is worth it, and the first consumer of `@bunql/db` is `@bunql/bus`.

**This move does not itself couple them.** No source file changes in this restructuring beyond
package metadata and config. The bus still opens `bun:sqlite` when this lands. The coupling is
the next piece of work, and it is easier to do — and to revert — once both trees are in one
place.

## Layout

```
package.json              private workspace root, name "bunql", workspaces ["packages/*"]
tsconfig.base.json        the strictness both packages share
tsconfig.json             root type-check: references both packages
scripts/bytes.ts          repo-wide; it walks `git ls-files`, so it belongs to the repository
docs/monorepo.md          this file
packages/db/              @bunql/db   — src, test, bench, scripts, docs, experiments, vendor
packages/bus/             @bunql/bus  — src, tests, scripts, docs, examples, dashboard build
```

Everything else stays where it was *inside* its package. Both trees resolve their own paths from
`import.meta.dir` or `import.meta.url` relative to the package root — `packages/db/scripts/sqlite.ts`
writes `packages/db/vendor/sqlite`, `packages/db/src/sqlite/lib.ts` reads it back from
`../../vendor/sqlite/`, and every `packages/bus/scripts/*.ts` resolves `root` as `import.meta.dir/..`.
Moving whole trees keeps all of that correct; moving files between trees would not have.

## Decisions

**The bus publishes as `@bunql/bus`.** The binary stays `agenticbus`, the log prefix, the
`AGENTICBUS_*` environment variables and the product name are unchanged — exactly the split
`release.yml` already documents for BunQL itself, where the scope is the publishing name and
nothing else. Neither package has been published yet, so this costs nothing to decide now and
would cost a deprecation later.

**History is preserved with `git subtree`.** `git subtree add --prefix packages/bus ../agenticbus main`
brings every AgenticBus commit into this history rather than landing 8,600 lines as one
anonymous "import" commit. `git log --follow packages/bus/src/bus/store.ts` still reaches back
through the whole file's life.

**One lockfile at the root.** Bun workspaces hoist. The bus's React/Vite/Tailwind dashboard
dependencies and BunQL's Kysely/Drizzle/GraphQL peers resolve in one tree, and
`bun install --frozen-lockfile` in CI means one thing for the whole repository.

**`tsconfig.base.json` holds what both agree on; each package overrides what it must.** They did
not agree on everything, and pretending otherwise would have meant loosening one of them:

| | `@bunql/db` | `@bunql/bus` |
| --- | --- | --- |
| `target` / `lib` | `ESNext` | `ES2022` — kept, its output is bundled by bunup for a pinned Bun |
| `types` | `bun-types` | `bun`, `vite/client` — the dashboard reads `import.meta.env` |
| `jsx` | — | `react-jsx` |
| `verbatimModuleSyntax` | `true` | `false` — the bus tree is not written for it yet |
| `paths` | — | `@/*` → `src/dashboard/*` |

The shared base is the strictness that actually matters and that both already set: `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`allowImportingTsExtensions`, `skipLibCheck`, `noEmit`.

**CI runs both packages, but the bus is not on the Windows gate yet.** BunQL earned that gate
over three exploratory runs (`docs/e2-windows-gate.md`); the bus has never run in any CI at all,
let alone on Windows, and adding it to a hard gate on day one would mean either a red main branch
or a `continue-on-error` that makes the gate meaningless for both. The bus runs on macOS and
Ubuntu now. Windows is its own piece of work, with its own evidence, the way BunQL's was.

**Releases are tag-prefixed.** `db-v1.2.3` publishes `packages/db`, `bus-v0.1.0` publishes
`packages/bus`. The existing check — the tag must match the `package.json` version or the release
refuses — is kept per package. Two packages that version independently cannot share a `v*` tag
namespace without one of them lying.

## What this does not do

- No source change in either package. `bun test` before and after must report the same counts.
- No shared code yet. `@bunql/bus` does not depend on `@bunql/db` in this commit.
- The `agenticbus` repository is left exactly as it is. Archive it when the monorepo has run
  green for a while, not on the same day.

## The work after this

In the order the value lands, each independently revertable:

1. **Swap the driver.** `packages/bus/src/bus/store.ts` imports `Database` from `@bunql/db/sqlite`
   instead of `bun:sqlite`. The shape matches deliberately — BunQL's `Database` carries `open`,
   `exec`, `prepare`, `query`, `run`, `transaction` under the `bun:sqlite` spelling. This buys the
   bus commit hooks for its SSE stream, a real `walCheckpoint` result for its WAL ceiling, and a
   statement deadline for a query that will not end.
2. **The change feed as an outbox.** A BunQL commit hook publishing to a bus subject is a
   transactional outbox with no dual-write window, because the feed is post-commit and carries the
   txid.
3. **Delete `packages/bus/src/bus/replication.ts`** in favour of WAL shipping, and the bus's
   bespoke backup/restore with it.
4. **The bus as BunQL's own job layer** — backup shipping, retention, compaction and replication
   retries are durable work with leases and a dead-letter path, which is what the bus is.

Steps 1 and 2 are additive. Steps 3 and 4 make the two packages genuinely one product, and should
be decided as that rather than arrived at.
