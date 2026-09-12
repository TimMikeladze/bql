# Prototype verification — 2026-09-11

## Implemented slice

One Bun coordinator, SQLite journal/state/artifacts, separate HTTP worker processes, real Claude/Codex CLI adapters, executable artifact tests, human acceptance, observation hooks, and a React dashboard inspired by `../reportable`.

## Evidence

- `bun run typecheck`: passed with TypeScript 7.0.2.
- `bun test tests`: 12 tests passed, covering 42 assertions across store, HTTP API, and subprocess execution.
- `bun run build`: passed with Vite 8.2.2.
- `bun run test:e2e`: passed. A worker was killed after claiming work, a replacement recovered the lease, review and six actual Bun tests joined on the same artifact, duplicate hooks deduplicated, SQLite state reopened, and acceptance completed through HTTP.
- Live workflow: installed Claude Code 2.1.269 created the TypeScript artifact, Codex CLI 0.154.0 returned an approved structured review, and Bun 1.4.0 passed all six artifact tests. This live run is left awaiting the user's acceptance in local scratch state.
- Browser: created a scripted demo through the form, observed live task completion, opened test-results evidence, and accepted the artifact. Paused/resumed worker intake and filtered journal events. Desktop inspected at 1440×1000; mobile inspected at 390×844 with no horizontal overflow.
- Formatting: Prettier checks passed for source, scripts, tests, and app configuration.

## Review corrections

- Provider children run in managed process groups; cancellation and deadline cleanup terminate descendants in the group. A regression reproduced the earlier hang and now passes on macOS.
- Transient observation-report failures no longer discard a successful artifact before completion persistence. Definitive stale ownership still aborts execution.
- Unauthenticated operator requests require explicit local Host and Origin checks, including rejection of matching foreign Host/Origin requests.
- Completion outboxes use temporary files and atomic rename. UI retries preserve idempotency keys for unchanged ambiguous operations.

## Limits of this evidence

The separate workers ran on one physical host. Remote HTTP operation is implemented but a physical multi-machine deployment is unverified. Windows process-tree cleanup is unverified. Generated test code is not OS-sandboxed. These checks do not establish production multi-tenant isolation, replicated availability, power-loss durability, or arbitrary external-effect reconciliation.
