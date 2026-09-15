# L7 — ship a tarball that can build its own engine

`docs/plan-limits.md` L7. A three-line fix and the gate that makes it stay fixed, plus one
documentation bug the gate found on its first real run.

## 1. The bug

`package.json` `files` was `["LICENSE", "src", "docs/design.md", "docs/api.md", "README.md"]`. It
excluded `scripts/`, so `scripts/sqlite.ts` and `scripts/native/walsum.c` were not in the published
package — and `sqlite:build` is advertised in `package.json` and in the README as the thing you run
once per machine.

The reason nobody noticed is the reason it is worth a gate rather than a fix: every test, every
type-check and every CI leg runs against the **working tree**, where `scripts/` is present and
`vendor/` is usually already built. A clone hides it completely. The only way to see it is to
install what npm would actually publish.

## 2. What it is now

`files` gains `scripts` (and `docs/c6-packaging.md`, which is where an operator is sent when the
build fails, and this file). `vendor/` is deliberately **not** listed: it is gitignored build
output, created by the script rather than shipped, and `scripts/sqlite.ts` writes into it at
`<package root>/vendor/sqlite` — which resolves correctly from inside `node_modules`, because both
it and `src/sqlite/lib.ts` locate it relative to their own module URL.

`scripts/pack-check.ts` (`bun run pack:check`) is the gate:

1. `npm pack` into a temp directory, so nothing lands in the working tree;
2. `npm install <tarball>` into a second, empty temp directory with a package.json of its own — a
   real dependency, not a clone and not a workspace link;
3. assert `scripts/sqlite.ts`, `scripts/native/walsum.c` and `src/sqlite/lib.ts` are all there;
4. run the build from the installed copy and check the artefact it names exists;
5. a smoke test *in that directory*, importing `@bunql/db` by name: assert the loaded library is
   the vendored one and reports `preupdate`, `session` and `walsum`, then open a database, create a
   table, insert a row and read it back.

It runs in about 13 seconds on macOS, most of which is compiling SQLite. Reverting `files` to its
pre-L7 value fails it at step 3 with `the tarball is missing scripts/sqlite.ts`, so it catches
exactly the bug it exists for.

## 3. What the gate found: the documented command does not work

The README said *"Once published, `bun add @bunql/db` and `bun run sqlite:build` in your own
project."* That is wrong, and it would have been wrong in the first published release: `npm run`
and `bun run` resolve a script name against **your** `package.json`, not a dependency's, so a
consumer running `bun run sqlite:build` gets "script not found".

The command that works — the one `pack-check.ts` runs, from the directory a consumer would run it
in — is the path:

```sh
bun run node_modules/@bunql/db/scripts/sqlite.ts
```

The README and `docs/c6-packaging.md` now say that. This is the install path the gate proves, which
is what the plan's "Done when" asks to be recorded.

## 4. Done when — against the plan's criteria

| criterion | result |
|---|---|
| a CI job runs `npm pack`, installs the tarball into a clean temp directory, and runs `sqlite:build` plus a smoke test there | **yes.** `scripts/pack-check.ts`, wired as the `tarball` job in `.github/workflows/ci.yml` |
| green on macOS and Linux | **run and green locally on macOS (arm64).** The job is declared for `macos-latest` and `ubuntu-latest`; the Linux leg has not been observed yet, because that needs a push. It is a gate, not `continue-on-error`, so it is green on both or the branch is red |
| `docs/c6-packaging.md` records the install path it proves | **yes** — and the path it records is a correction, §3 |

## 5. What it touched

`package.json` (`files`, the `pack:check` script), `scripts/pack-check.ts` (**new**),
`.github/workflows/ci.yml` (the `tarball` job), `README.md` and `docs/c6-packaging.md` (the install
path).
