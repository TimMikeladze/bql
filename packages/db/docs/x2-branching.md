# X2 — Branching as a product

Item 2 of `docs/plan-ecosystem.md`. The O(1) fork of design §4.4 already existed; this makes it a
workflow: lineage in the catalog, branch/diff/reset in the CLI, `diffSchema` in the SDK, and a
GitHub Action for per-PR branches.

## Decisions

- **Lineage lives in the catalog row**, two nullable columns: `parent` (db name) and `forked_at`
  (txid, decimal TEXT like every other u64 there). Written by `Tenant.fork`, the one place every
  fork passes through — so `POST /v1/db` with `from` *and* a local point-in-time restore
  (`POST /v1/db/:db/restore`, which forks into a new name) both record it. Additive migration:
  existing rows read null.
- **Deleting a parent leaves the child alone.** The child's `parent` still names it; list/stat
  report `parentDeleted: true` so a UI can show the dangling edge. No cascade, no rewrite. A name
  later re-created is a *different* database: lineage is by name, so `parentDeleted` is computed
  as "no live row with that name", and a revived name silently re-links. Documented, not solved.
- **`reset` is a server operation** (`POST /v1/db/:db/reset`, `admin.reset`), not delete + fork
  from the CLI, so it can be as safe as a single process can make it:
  1. fork the parent at head into `trash/<name>-staging-<ms>`. Nothing about the branch is
     touched yet; a failure here leaves the branch exactly as it was, and a crash mid-copy leaves
     a directory the ordinary trash sweep removes after `[durability] retention`.
  2. evict the branch (subscriptions, transactions) and close it. Record the swap in the catalog
     (`resets` table: staging path, old path, the new position), written with
     `synchronous = full` so a power cut cannot keep the renames and lose the record. Then rename
     the branch's directory to `trash/<name>-reset-<ms>`, rename staging into place, and rewrite
     the row (position, `forked_at`, snapshot rows dropped) **in the same transaction that
     deletes the `resets` record**.
  3. reopen. Steps 2's renames and the catalog writes are synchronous: no request interleaves.

  **Crash recovery.** A crash anywhere in step 2 leaves the `resets` record and the branch's old
  catalog row. The next `open` of that name (`TenantRegistry.#recoverReset`, run before the row is
  read) looks at the directories:
  - staging *and* branch directory present: nothing moved. The staging directory is removed, the
    record dropped, and the branch opens as it was.
  - staging present, branch directory gone: move staging in, rewrite the row.
  - staging gone, branch directory present: both renames happened. Rewrite the row.
  - neither: the trash sweep removed them first (a crash then no open for `retention`); refused
    as `RESET_LOST`.
  It runs on the open path rather than at registry start because workers share one catalog and
  only the shard that opens a database may touch its directory. Tests throw at each step
  (`crashAt: "marked" | "moved" | "swapped"`), reopen, and check that the recorder's checksum is
  the file's own. The first version of this had a window the review found: between moving the
  copy in and rewriting the row, a restart opened the parent's file with the branch's old
  position, and because the zeroed WAL position means "the file is the state" the recorder did
  not check it, chaining records onto the wrong checksum (`LOG_DIVERGED` later).
  Replicas and change-feed consumers see what delete-then-create would show them (`onChange`
  fires both), and the branch's txid moves to the parent's head, which can be lower than it was.
  Refused with `400 BAD_REQUEST` (tenant code `NO_PARENT`) when the row has no parent, and
  `404 DB_NOT_FOUND` naming the parent when it has been deleted. The branch keeps its epoch (cluster leases are keyed on it), its
  settings (foreign keys, ack override) and its creation time.
- **`diffSchema(a, b)`** runs against anything with `execute(sql) → rows` (`client.db()`,
  embedded `bq.db()`), so it works in every mode. Reads `pragma_table_list` (to drop FTS/vec/R*Tree
  shadow tables), `pragma_table_xinfo`, `pragma_index_list`/`pragma_index_xinfo`, `sqlite_schema`
  for triggers/views, and one `union all` of `count(*)` per side. Result is structured
  (`added/removed/changed` per kind, column-level changes, row counts both sides) with
  `formatSchemaDiff` as the text renderer the CLI prints.
- **CLI**: `bql db branch` is `fork` with a clearer name; `branches [<db>]` lists children (or
  every database that has a parent); `diff <a> <b> [--json]`; `reset <branch>`.
- **Cloud mode**: fork is already `CLOUD_UNSUPPORTED` there, so lineage never arises; list/stat
  report nulls. `reset` is not in `CLOUD_OPERATIONS`, so it is refused the same way. The cloud
  catalog document is unchanged.
- **Workers**: `reset` routes by the branch name like every `/v1/db/:db/*` route. A parent on
  another shard has the same caveat fork already has.

## Pieces

| Piece | Where |
|---|---|
| catalog columns + migration | `src/tenant/catalog.ts` |
| fork records lineage, reset | `src/tenant/tenant.ts`, `src/tenant/registry.ts` |
| list/stat fields, reset route | `src/server/routes.ts`, `src/server/registry.ts` |
| `admin.reset`, types | `src/client/admin.ts`, `src/client/protocol.ts` |
| `diffSchema`, `formatSchemaDiff` | `src/client/diff.ts` |
| CLI | `src/cli.ts` |
| GitHub Action | `.github/actions/bql-branch/action.yml` |

## Example workflow

`.github/actions/bql-branch/action.yml` is a composite action; this repository runs no workflow
that uses it. In a consuming repository:

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
jobs:
  branch:
    runs-on: ubuntu-latest
    steps:
      - id: db
        uses: TimMikeladze/bql/.github/actions/bql-branch@main
        with:
          url: ${{ secrets.BQL_URL }}
          token: ${{ secrets.BQL_ADMIN_KEY }}
          source: main
          action: ${{ github.event.action == 'closed' && 'delete' || 'create' }}
          on-exists: keep
      - run: bun run migrate
        env:
          BQL_DB: ${{ steps.db.outputs.name }}
```

`create` is idempotent (a `409` is "already there", and `on-exists: reset` turns it into a reset);
`delete` treats `404` as done. **`delete` refuses** a name equal to `source` — on a push to `main`
the ref fallback would otherwise name `main` itself — and a database whose stat has no `parent`:
only a branch is ever deleted. Both fail the step. `test/cli/branch-action.test.ts` lifts the
step's script out of `action.yml` and runs it with bash and curl against a test server. The branch name is `pr-<number>`, else the ref, sanitised to
`[a-z0-9][a-z0-9-_]{0,63}` the same way the README's Vercel recipe does it. 

## Where the plan was wrong

- **"reset = delete and re-fork"** would leave a window where the branch does not exist and, if
  the fork failed, no branch at all. Built as a server operation that forks first and swaps after.
- **Lineage is not only for `fork`.** A local `restore` is a fork into a new name, so it records
  lineage too — which makes a restored copy resettable, arguably useful.
- **A dangling parent needed a field.** The plan said list/stat return `parent`; without
  `parentDeleted` a UI cannot tell a live edge from a dead one without a second call.
- **No new error code.** `NO_PARENT` maps to `400 BAD_REQUEST`, like `NO_SNAPSHOT`: the
  vocabulary in `src/server/errors.ts` stays closed.
- **Row counts are full scans.** Fine for preview databases; `diffSchema(a, b, { rows: false })`
  skips them.
- **Cloud mode** needed nothing: forks are refused there, so lineage never arises and `reset` is
  outside `CLOUD_OPERATIONS`.
