> **Superseded (2026-09-12).** The prototype this plans was replaced by the distributed-execution design; see [../specs/2026-09-12-distributed-execution.md](../specs/2026-09-12-distributed-execution.md).

# bql.sh/bus end-to-end prototype implementation plan

**Goal:** Run a durable artifact creation, review, test, and human approval workflow through a Bun coordinator and independent HTTP workers, visible in a Reportable-inspired dashboard.

**Architecture:** One SQLite authority persists runs, tasks, events, workers, and content-addressed artifacts. Worker subprocesses claim expiring tasks over HTTP. A React/Vite dashboard uses the API and SSE invalidation; live provider invocations are explicit and separate from scripted demo workers.

**Tech stack:** Bun, SQLite, React, Vite, Tailwind 4, shadcn-style Base UI components.

**Spec:** [Architecture proposal](../specs/2026-09-11-bql-bus-design.md).

## Constraints and refinements

- This is an end-to-end prototype, not a static UI or a production deployment.
- Run on a dedicated prototype branch; scratch data lives under `.prototype/` and is ignored.
- Reportable inspiration: `base-mira`, neutral palette, warm sidebar, 7px radius, 24px heading, 13px body, compact controls.
- One fixed useful example: a `slugify` utility with executable tests. The run brief can add instructions but the artifact contract remains fixed.
- Demo mode creates the same artifact deterministically. Live mode uses installed Claude for creation and Codex for review. No fabricated provider activity.
- Ready for approval requires both review and tests to pass for the same artifact. Human approval marks the artifact accepted; it does not publish or merge anything.
- Claims are fenced, expired claims retry at most three times, and completions are idempotent. Prototype tasks are retry-safe computations, with no deployment/PR side effects.
- Local development binds to loopback. Remote worker access requires a token; HTTPS termination/tunneling remains a deployment prerequisite, not a built-in certificate service.
- Tests target transactions, dependency joins, fencing, auth, and real subprocess completion. UI is checked in the browser.

## Task 1: Durable coordinator

Files: `src/shared/protocol.ts`, `src/server/store.ts`, `src/server/server.ts`, `tests/store.test.ts`, `tests/api.test.ts`.

- [x] Write tests for duplicate task request, artifact fan-out/join, reopen persistence, stale completions, lease recovery, and approval gates.
- [x] Run `bun test tests/store.test.ts` and confirm missing kernel behavior.
- [x] Implement `BusStore.createRun`, `registerWorker`, `claim`, `heartbeat`, `complete`, `recover`, `approve`, `cancel`, `retry`, `snapshot`, `events`, and `artifact`.
- [x] Implement authenticated `/api` endpoints with bounded payloads and an SSE observation stream; expose no filesystem paths.
- [x] Run kernel/API tests.

## Task 2: Independent runners and real artifact tests

Files: `src/worker/runner.ts`, `src/worker/executors.ts`, `scripts/dev.ts`, `scripts/e2e.ts`.

- [x] Implement runner registration, claims, heartbeats, bounded execution, stale claim cancellation, and completion retry.
- [x] Demo creator produces TypeScript; tester runs six real Bun tests in a temporary folder; reviewer reports structured findings.
- [x] Live creator invokes `claude -p` with tool access disabled; reviewer invokes read-only `codex exec --json`. Parse provider JSON and retain result evidence, not terminal decoration.
- [x] Start coordinator and three separate workers with one `bun run dev` command.
- [x] Run `bun run test:e2e` through HTTP and subprocesses, and verify approval plus restart recovery.

## Task 3: Dashboard

Files: `src/client/*`, `src/client/components/ui/*`, `vite.config.ts`, `index.html`.

- [x] Build the Reportable-inspired shell with run list, searchable journal, worker health, artifact inspector, and run detail.
- [x] Wire create, approve, reject/cancel, retry, and worker pause to real API operations. Use explicit loading, disconnected, and failure states.
- [x] Render the workflow graph from real task states, with a live event timeline and readable code/test/review artifacts.
- [x] Verify desktop/mobile layout, keyboard interaction, run creation, event arrival, and approval in browser.

## Task 4: Review and handoff

- [x] Run `bun run typecheck`, `bun test`, `bun run build`, and `bun run test:e2e`.
- [x] Exercise live provider mode where installed authentication allows; report exact limits otherwise.
- [x] Record validated refinements, startup/remote commands, and operational limits in README.
- [x] Review the final implementation, fix material findings, and leave the prototype running for inspection.

## Completed evidence

See [prototype verification](../../prototype-verification.md). The prototype was built on `prototype/e2e`; the user subsequently requested all changes be committed and pushed to `main`. Backend and whole-prototype reviews passed after corrections. Physical multi-machine testing and production guarantees remain explicitly outside verified evidence.
