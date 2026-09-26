# Multi-endpoint CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task if native execution is selected; use superpowers:subagent-driven-development if delegated execution is selected. Steps use checkbox syntax for tracking.

**Goal:** Operate independent BQL deployments through local organizations, projects, named endpoints, and linked checkouts, including Vercel protection bypass.

**Architecture:** A Bun-only context module owns validated configuration, private credentials, project links, and deterministic resolution. Thin management commands and database/bus adapters consume it; portable SDKs remain free of workstation discovery.

**Tech Stack:** Existing Bun/TypeScript, node filesystem APIs, Bun test runner; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-26-multi-endpoint-design.md`

## Global Constraints

- Organizations are local connection namespaces, not server authorization boundaries.
- Stable record IDs survive mutable slug names; project names are scoped to organizations.
- Config directory: `--config-dir`, `BQL_CONFIG_DIR`, `$XDG_CONFIG_HOME/bql`, then `~/.config/bql`.
- Newly created config directories use 0700; credentials use 0600.
- `--org` selects organizations; `--scope` retains token permission semantics.
- Selection and credentials follow the exact six-stage precedence in the approved spec.
- Database and bus service credentials remain separate and bound to their service URLs.
- Local server/storage/key operations do not require remote context.
- Existing CLI shortcuts and unrelated worktree changes remain intact.

## Review Focus

- Interrupted credential rotation must not couple an old registry URL to new credentials (Task 1).
- An explicit organization override must not reuse another organization's linked project (Task 2).
- Piped input or EOF must not hang interactive linking or expose prompted secrets (Task 3).
- Bus consumers and followers must use the resolved transport, not bypass it via separately constructed clients (Task 5).
- A proxy redirect must not leak bypass headers or bearer credentials (Tasks 4 and 5).

## File boundaries

- `packages/db/src/context/model.ts`: validated versioned types, slug/URL validation.
- `packages/db/src/context/store.ts`: locked registry transactions, private immutable credential entries, atomic files.
- `packages/db/src/context/link.ts`: nearest checkout link, write/unlink, ignore rules.
- `packages/db/src/context/index.ts`: public resolver and redacted views.
- `packages/db/src/cli/context.ts`: organization/project/endpoint commands.
- `packages/db/src/cli/prompt.ts`: terminal selection and hidden credentials.
- `packages/db/src/cli/transport.ts`: CLI-specific fetch and Bun socket factories.
- `packages/db/src/cli.ts`: management dispatch and resolved database connections.
- `packages/bus/src/cli/connection.ts`: resolved bus client options.
- `packages/bus/src/cli/index.ts`: use connection adapter at every remote client construction.
- `package.json`: `./context` export; README and deployment docs: operator instructions.

### Task 1: Registry and credential persistence

**Files:** Create context `model.ts`, `store.ts`; test `packages/db/test/context/store.test.ts`.

**Interfaces:** Export `Registry` (version 1, organizations/projects/endpoints, global selection), `Credentials`, `ServiceConnection` (URL plus credential references), `ContextStore`, and `configDirectory({ configDir?, env? }): string`. Records use UUIDs. `ContextStore.read(): Promise<Registry>` and `ContextStore.mutate(change: (state: Registry, secrets: Credentials) => void): Promise<void>` own persistence. Credential references use new immutable UUID keys for replacements.

- [x] Write failing tests for round-trip, duplicate sibling names, duplicate IDs, invalid URLs, corrupt/unsupported versions, owner-only permissions, concurrent writers, stale lock timeout, and failed atomic replacement.
- [x] Run `bun test packages/db/test/context/store.test.ts`; confirm missing implementation failures.
- [x] Implement validation, a bounded directory lock, and atomic same-directory temp-file replacement. Stage new immutable credential entries before registry publication; remove unreferenced entries only after registry publication. Existing references remain valid across interrupted writes.
- [x] Add fault-injection coverage: interrupt after credential staging, verify old URL still resolves old credentials; complete transaction, verify new URL resolves new credentials.
- [x] Run the store tests and inspect resulting file modes; require all checks to pass.

### Task 2: Checkout links and connection resolution

**Files:** Create context `link.ts`, `index.ts`; tests `packages/db/test/context/link.test.ts`, `resolve.test.ts`; modify root `package.json` export.

**Interfaces:** `ResolveOptions { cwd?, configDir?, env?, org?, project?, endpoint?, url?, token?, vercelBypass?, service?: 'database' | 'bus' }`; `resolveContext(options?: ResolveOptions): Promise<ResolvedContext>`. Result includes mode/source, selected IDs/names, URL, token, and HTTP headers. `redactContext(result)` explicitly constructs a credential-free view. `findLink(cwd): Promise<ProjectLink | null>`, `writeLink(directory, link): Promise<void>`, `unlinkProject(cwd): Promise<void>` own checkout state.

- [x] Write failing tests for each of the six mode-precedence stages and each field's flags/environment/link/default precedence. Assert explicit URL plus selection flags fails; named mode ignores ambient legacy credentials.
- [x] Add nested-directory link lookup, rename persistence, stale IDs, explicit organization/project invalidation, missing environment reference, database/bus separation, and missing bus URL tests.
- [x] Run `bun test packages/db/test/context/link.test.ts packages/db/test/context/resolve.test.ts`; confirm failures.
- [x] Implement resolver using validated registry data. Explicit parent changes discard incompatible lower-precedence children. Broken configured selections fail before network access. Legacy direct mode does not need to parse unrelated saved context.
- [x] Implement atomic checkout link writes and append-only ignore-rule updates. Unlink removes only the nearest link file, leaving other `.bql` contents intact.
- [x] Export `bql.sh/context` and verify package subpath resolution plus redaction tests; rerun all context tests.

### Task 3: Management commands and terminal workflow

**Files:** Create `cli/context.ts`, `cli/prompt.ts`; modify `cli.ts`; test `packages/db/test/cli/context.test.ts`.

**Interfaces:** `runContextCommand(args: ParsedArgs, options: { cwd: string; env: Record<string, string | undefined> }): Promise<boolean>` returns whether handled. Prompt functions accept injectable input/output and terminate on EOF/cancellation. Reuse parsed arguments without importing the executable from context modules.

- [x] Write CLI subprocess tests for org/project/endpoint add/list/inspect/update/remove, global switch/project use, link/unlink, endpoint use and `--default`, and `context --json`.
- [x] Assert first endpoint becomes default, nonempty parent removal needs `--recursive`, endpoint URL replacement clears old credentials, renames preserve links, and remote database deletion never occurs during registry removal.
- [x] Add terminal-adapter tests for selection, hidden credential entry, Ctrl-C, and EOF; noninteractive incomplete input must fail promptly. Assert secrets never appear in captured stdout/stderr or ordinary registry JSON.
- [x] Run `bun test packages/db/test/cli/context.test.ts`; confirm failures.
- [x] Implement management dispatch before remote-client construction, exact help, environment credential references and hidden secret prompts, human tables and JSON views. `--cwd` applies to link lookup without changing the caller's process directory.
- [x] Rerun CLI/context suites; check `bun run cli --help` and representative group help manually.

### Task 4: Database transport and protected endpoints

**Files:** Create `cli/transport.ts`; modify `cli.ts`; tests `packages/db/test/cli/endpoints.test.ts`.

**Interfaces:** `cliFetch` wraps fetch with `redirect: 'error'`; `cliSocketFactory(headers): WebSocketFactory` injects Vercel bypass into Bun handshakes. Remote construction consumes `ResolvedContext` and preserves existing SDK behavior and CLI integer formatting.

- [x] Write failing integration tests against two independent database servers with different keys/data. Switching named endpoints must route create/list/query correctly without cross-sending keys.
- [x] Add a protected proxy fixture checking both bearer and bypass headers; verify no-bypass failure, correct authenticated success, direct URL credential isolation, and redirect rejection without contacting the destination.
- [x] Exercise socket handshake headers using a socket-capable fixture; retain cloud runtime's existing unsupported-session behavior.
- [x] Run `bun test packages/db/test/cli/endpoints.test.ts`; confirm failures.
- [x] Resolve only remote database commands; keep serve/cloud-init/help independent. Move resolution inside CLI error handling. Inject fetch and socket adapters without modifying portable SDK discovery behavior.
- [x] Run `bun test packages/db/test/context packages/db/test/cli packages/db/test/client packages/db/test/cloud/cli.test.ts`; require all passing.

### Task 5: Bus transport integration

**Files:** Create `packages/bus/src/cli/connection.ts`; modify bus `cli/index.ts`; create `packages/bus/test/cli-context.test.ts` (adjust to the existing test directory convention if required).

**Interfaces:** `resolveBusConnection({ argv, cwd?, env? }): Promise<ClientOptions>` uses the shared resolver, retains legacy local-secret loading only in legacy mode, and injects bypass/redirect handling through existing `fetchImpl` support.

- [x] Write failing bus fixture tests for publish/consume/request using the selected bus URL/token and bypass header; assert selected database credentials never reach the bus.
- [x] Test missing selected bus URL fails without generating local secrets; legacy BUS_URL/BUS_TOKEN works; serve/key operations ignore broken remote context.
- [x] Inspect and cover every remote construction path, including follower and consumer clients. Test redirects do not reach the destination with credentials.
- [x] Run the new bus tests; confirm failures.
- [x] Implement connection adapter and update all remote constructors while retaining local operation behavior and workspace selection.
- [x] Run `bun run bus test` and database endpoint suites; require passing results.

### Task 6: Documentation, verification, and final audit

**Files:** Modify README, `deploy/vercel/README.md`, CLI help, package export tests; mark plan checkboxes only after evidence exists.

- [x] Document a complete personal-org/project/preview setup, linking and switching, production overrides, CI environment references, optional bus configuration, Vercel bypass credentials, direct legacy migration, renaming, and removal.
- [x] Execute documented setup in a temporary config and checkout against fixtures, including the `bql.sh/context` API. No real credentials enter the repository.
- [x] Run `bun run typecheck`, `bun run bytes`, database context/CLI/client/cloud CLI suites, and bus tests. Run package export/pack checks appropriate to the new exported module.
- [x] Review the full diff against every spec requirement; inspect failure behavior, credential boundaries, interrupted persistence, and all remote construction paths. Resolve findings and rerun affected tests.
- [x] Record test results and limitations. Mark the goal complete only when the approved design is implemented and verified. Do not publish or change the deployed service as part of this task.

## Execution recommendation

Native execution in the current session: the six tasks share context types and transport
boundaries, so sequential implementation keeps those interfaces consistent. The
alternative is task-by-task subagent implementation and review. The user approved native execution; implementation and verification are complete.


## Completion evidence — 2026-09-26

| Requirement | Evidence |
| --- | --- |
| Validated organization/project/endpoint registry, private credentials, concurrent updates | `test/context/store.test.ts`: round-trip, permissions, duplicate/URL validation, lock timeout, eight concurrent mutations, interruption at registry publication, corrupt JSON/null preservation |
| Linked checkouts and deterministic selection | `test/context/resolve.test.ts`: flags/environment/direct/link/global/default precedence, incompatible parent selection, nested link lookup, renames, missing references, empty explicit target, bus isolation |
| Stable IDs cannot redirect or revive a stale link | Regression reproduces name/ID hijacking; saved references now resolve by ID only and ambiguous explicit selectors fail |
| Credential confidentiality | Hidden-prompt tests, safe views, ASCII validation across stored/environment/override/legacy paths, subprocess stderr non-disclosure regression |
| Management commands | `test/cli/context.test.ts`: organization/project/endpoint lifecycle, switching, linking, endpoint defaults, recursive removal, URL credential reset, custom cwd, JSON output |
| Database and Vercel protection | `test/cli/endpoints.test.ts`: two real database servers, distinct credentials/data, protected proxy requiring bearer and bypass, direct URL isolation, redirect and cross-origin movement rejection |
| Socket protection | `test/context/transport.test.ts`: real Bun socket handshake headers/protocol and redirect rejection |
| Bus integration | `packages/bus/tests/cli-context.test.ts`: publish, request/consumer response, follower replication, separate bus credentials, bypass, redirects, missing bus settings, legacy behavior, local keys |
| Local operations | Local database server starts and bus key operations work with corrupt remote registry; help remains available |
| Public package and global CLI | Export loading tests, installed tarball `resolveContext` smoke, database/bus tarball smoke, compiled binary check, identical repository/global CLI help |
| Documentation | Root README, Vercel connection guide, CLI help, regenerated site reference and test counts |

Final commands: `bun run test` **1,814 passed, 2 skipped, 0 failed** (database 1,655,
bus 141, site 18); `bun run typecheck`, `bun run bytes`, `bun run site:build`,
`bun run pack:check`, and `git diff --check` passed.

An independent read-only review found credential error disclosure and saved-ID/name
collisions. Both were reproduced with failing tests and fixed before the final green
suite. No minor findings were deferred.

Implementation remains in the current checkout on `feat/multi-endpoint-context`, with
no publish, merge, or deployment changes. This preserves the existing global CLI link.
Named CLI endpoints deliberately reject cross-origin primary-movement retries; select
the new endpoint explicitly. Direct legacy mode preserves the SDK's movement behavior.

Qualification limits: protection behavior was tested with local HTTP/socket fixtures,
not a live Vercel deployment. Prompt behavior was tested with injected terminal streams,
not a physical terminal emulator. Persistence evidence covers concurrent and interrupted
file publication, not arbitrary machine power loss. These limits do not change the
implemented local-registry scope.
