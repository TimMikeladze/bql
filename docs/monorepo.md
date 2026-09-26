# The monorepo: one package, two trees

The bus moves into this repository. Two source trees under one root, one lockfile, one CI pipeline.

> **Since [docs/rename.md](rename.md)** the two no longer publish separately: everything ships as
> one package, `bql.sh`, whose subpaths reach into both trees. The reasoning below is the reasoning
> for the move itself, which is unchanged — where it says "two packages", read "two trees".

## Why

The two projects were solving overlapping problems in parallel and neither could use the
other's answer:

- **Storage.** The bus opens `bun:sqlite` directly (`packages/bus/src/bus/store.ts`). bql.sh
  ships its own SQLite over `bun:ffi` with commit/preupdate/WAL hooks, a killable statement
  deadline, an authorizer and session changesets — none of which `bun:sqlite` exposes.
- **Replication.** The bus ships its own log over HTTP with a file lease and asynchronous lag
  (`packages/bus/src/bus/replication.ts`, 224 lines). bql.sh ships WAL frames with a segment log,
  snapshots, point-in-time restore and epoch-fenced promotion.
- **Tenancy.** The bus separates workspaces by column in one file. bql.sh separates tenants by
  database, with per-database quotas, retention and checkpoint policy.
- **Realtime.** The bus polls to refresh its dashboard. bql.sh has a change feed driven by commit
  hooks.

None of that is worth a cross-repository dependency with a version skew between them. In one
repository it is worth it, and the first consumer of `bql.sh` is `bql.sh/bus`.

**This move does not itself couple them.** No source file changes in this restructuring beyond
package metadata and config. The bus still opens `bun:sqlite` when this lands. The coupling is
the next piece of work, and it is easier to do — and to revert — once both trees are in one
place.

## Layout

```
package.json              the published package, name "bql.sh", workspaces ["packages/*", "site"]
tsconfig.base.json        the strictness both packages share
tsconfig.json             root type-check: references both packages
scripts/bytes.ts          repo-wide; it walks `git ls-files`, so it belongs to the repository
docs/monorepo.md          this file
packages/db/              the database — src, test, bench, scripts, docs, experiments, vendor
packages/bus/             the bus — src, tests, scripts, docs, examples, dashboard build
```

Everything else stays where it was *inside* its package. Both trees resolve their own paths from
`import.meta.dir` or `import.meta.url` relative to the package root — `packages/db/scripts/sqlite.ts`
writes `packages/db/vendor/sqlite`, `packages/db/src/sqlite/lib.ts` reads it back from
`../../vendor/sqlite/`, and every `packages/bus/scripts/*.ts` resolves `root` as `import.meta.dir/..`.
Moving whole trees keeps all of that correct; moving files between trees would not have.

## Decisions

**The bus publishes as `bql.sh/bus`.** At the time of the move that meant a second npm package;
[docs/rename.md](rename.md) then made it a subpath of the first, which is what it is now. Its binary
is `bql-bus` and its environment variables are `BQL_BUS_*`. Nothing had been published yet, so both
decisions cost nothing to make and would have cost a deprecation later.

**History is preserved with `git subtree`.** `git subtree add --prefix packages/bus ../bql-bus main`
brings every bql.sh/bus commit into this history rather than landing 8,600 lines as one anonymous
"import" commit.

Reaching it takes the right incantation, and it is worth writing down because the obvious one
returns nothing. Those commits touched `src/bus/store.ts`, not `packages/bus/src/bus/store.ts` —
the path they are recorded under does not exist on this side of the merge, and history
simplification stops a path-limited `git log` at the merge commit either way:

```sh
git log packages/bus/src/bus/store.ts                     # 1 commit: the subtree merge
git log --follow 6800161^2 -- src/bus/store.ts            # 10 commits: the file's whole life
```

`6800161^2` is the subtree merge's second parent — the bql.sh/bus tip as it was imported. Every
commit is present and reachable; only the path is addressed as it was, not as it is.

**One lockfile at the root.** Bun workspaces hoist. The bus's React/Vite/Tailwind dashboard
dependencies and bql.sh's Kysely/Drizzle/GraphQL peers resolve in one tree, and
`bun install --frozen-lockfile` in CI means one thing for the whole repository.

**`tsconfig.base.json` holds what both agree on; each package overrides what it must.** They did
not agree on everything, and pretending otherwise would have meant loosening one of them:

| | `bql.sh` | `bql.sh/bus` |
| --- | --- | --- |
| `target` / `lib` | `ESNext` | `ES2022` — kept, its output is bundled by bunup for a pinned Bun |
| `types` | `bun-types` | `bun`, `vite/client` — the dashboard reads `import.meta.env` |
| `jsx` | — | `react-jsx` |
| `verbatimModuleSyntax` | `true` | `false` — the bus tree is not written for it yet |
| `paths` | — | `@/*` → `src/dashboard/*` |

The shared base is the strictness that actually matters and that both already set: `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`allowImportingTsExtensions`, `skipLibCheck`, `noEmit`.

**CI runs both packages, but the bus is not on the Windows gate yet.** bql.sh earned that gate
over three exploratory runs (`docs/e2-windows-gate.md`); the bus has never run in any CI at all,
let alone on Windows, and adding it to a hard gate on day one would mean either a red main branch
or a `continue-on-error` that makes the gate meaningless for both. The bus runs on macOS and
Ubuntu now. Windows is its own piece of work, with its own evidence, the way bql.sh's was.

**Releases are tag-prefixed.** `db-v1.2.3` publishes `packages/db`, `bus-v0.1.0` publishes
`packages/bus`. The existing check — the tag must match the `package.json` version or the release
refuses — is kept per package. Two packages that version independently cannot share a `v*` tag
namespace without one of them lying.

## What changed outside the move

Three edits, each one something the move broke or exposed. Nothing else in either `src/` moved or
changed.

- **`packages/bus/scripts/verify-pack.ts`** spelled `bql-bus` into a tarball glob, two import
  specifiers and a `node_modules` path. A scoped name packs with the scope flattened —
  `bql.sh/bus` produces `bql-bus-0.1.0.tgz` — so all four broke at once on the rename. They are
  derived from `manifest.name` now, which is the same discipline
  `packages/db/test/package/exports.test.ts` already applies. The *binary* name is still spelled
  out, because `bql-bus` is genuinely fixed and the check is that it has not moved.
- **`scripts/bytes.ts`** read every path `git ls-files` returned and ended the scan on the first
  one that was absent. A path can be tracked and absent at once — a staged deletion is the
  ordinary case, and deleting `packages/bus/bun.lock` produced exactly that. It skips them now.
- **Both READMEs** gained their monorepo install path, and the bus's gained its new published
  name.

## What this does not do

- No change to either package's `src/`. `bun test` reports the same counts as before the move:
  1487 pass / 2 skip for `bql.sh`, 137 pass for `bql.sh/bus`.
- No shared code yet. `bql.sh/bus` does not depend on `bql.sh` in this commit.
- No Windows coverage for the bus. See the CI note above.
- The `bql-bus` repository is left exactly as it is. Archive it when the monorepo has run
  green for a while, not on the same day.

## The work after this

In the order the value lands, each independently revertable:

1. **Swap the driver.** `packages/bus/src/bus/store.ts` imports `Database` from `bql.sh/sqlite`
   instead of `bun:sqlite`. The shape matches deliberately — bql.sh's `Database` carries `open`,
   `exec`, `prepare`, `query`, `run`, `transaction` under the `bun:sqlite` spelling. This buys the
   bus commit hooks for its SSE stream, a real `walCheckpoint` result for its WAL ceiling, and a
   statement deadline for a query that will not end.
2. **The change feed as an outbox.** A bql.sh commit hook publishing to a bus subject is a
   transactional outbox with no dual-write window, because the feed is post-commit and carries the
   txid.
3. **Delete `packages/bus/src/bus/replication.ts`** in favour of WAL shipping, and the bus's
   bespoke backup/restore with it.
4. **The bus as bql.sh's own job layer** — backup shipping, retention, compaction and replication
   retries are durable work with leases and a dead-letter path, which is what the bus is.

Steps 1 and 2 are additive. Steps 3 and 4 make the two packages genuinely one product, and should
be decided as that rather than arrived at.
