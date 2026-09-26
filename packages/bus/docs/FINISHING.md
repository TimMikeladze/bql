# Prompt: finish bql.sh/bus

Hand this to an agent (or a fresh session) as the task. It assumes no memory of how the code got here.

---

## What you are working on

**bql.sh/bus** (`~/workspace/bql-bus`) is a durable message bus for agents and ordinary background work. Bun, SQLite, zero runtime dependencies. Publish to a subject; durable subscriptions deliver to consumers with leases, retries, per-key ordering and a dead-letter path. It is three things from one set of primitives: a work queue (competing consumers), pub/sub (many subscriptions per subject, each with its own cursor), and durable request/reply (a response recorded against a correlation, collectable after a restart).

**dagr-remote** (`~/workspace/dagr/packages/dagr-remote`) is its first real client: it lets [dagr](https://github.com/TimMikeladze/dagr), a single-node workflow engine, run step handlers on other machines over the bus. dagr depends on the bus. **The bus must never depend on dagr** — that dependency was inverted once already and re-introducing it undoes the whole point.

Read `README.md` and `docs/superpowers/specs/2026-09-12-message-bus.md` before touching anything. The design decisions there are load-bearing and were expensive to reach.

## How to work

These are not style preferences. They are what kept the previous passes honest.

1. **Write the failing test first.** Every bug fixed so far was found by a test that failed before the fix. If you cannot make a test fail, you have not understood the bug.
2. **Verify with real processes.** Unit tests drive one writer deterministically and will not find the interesting failures. The end-to-end suites spawn actual OS processes and SIGKILL them. Extend that habit; do not replace it with mocks.
3. **Claim nothing you have not run.** If you could not verify something, say so plainly in your report. "Should work" is a failure to verify, not a result.
4. **Spec before multi-file work.** Short and decision-dense, in `docs/`. Not a template.
5. **Keep docs true.** README, spec and code comments are part of the change. A comment that claims a safety the code lacks is worse than no comment — one already caused a data-loss bug here.
6. **Commit per coherent change**, with a message that explains *why*, and end with the attribution lines used on the existing commits (`git log` shows the format).

## Current state, honestly

Verified working, with tests: subject matching (`*` one token, `>` the rest), pull-based fan-out with per-subscription cursors, competing consumers, leases with generation fencing, expired-lease recovery onto another machine, per-key ordering, dead-lettering onto an ordinary subject, dedupe (including correlation reuse on a deduplicated request), replay and purge, TTL and retention with separate guards, blob overflow and collection, scoped tokens with subject-pattern grants, workspace tenancy enforced on every query, long-poll claim, durable request/reply.

61 tests. Two end-to-end suites with real processes. `bun run typecheck` clean under `noUncheckedIndexedAccess`.

**Trust these least**, in order:

- `materialize()` in `src/bus/store.ts` — the cursor-ceiling arithmetic is the subtlest code in the repo. Correct as far as the tests reach; the tests may not reach far enough.
- **Concurrency.** Nothing has exercised many consumers racing on one subscription under load. Every test drives a single writer deterministically.
- **The blob path.** Unit tests only; never exercised through the HTTP layer or a real filesystem under churn.

## The work

Ordered. Each item states what "done" means. Do not move on until the gate passes.

### 1. Prove the concurrency claims (do this first)

Everything below assumes the core is sound, and nothing has tested that under contention.

- `scripts/soak.ts`: N consumer processes (default 8) against one subscription, M messages (default 5000), randomly SIGKILLing consumers throughout. Assert: every message handled **at least** once, every message acked **exactly** once, no message stuck pending at the end, no unexpected dead letters.
- A variant with `ordered: true` asserting per-key FIFO held under kills.
- A variant that kills the **bus** process mid-flight and restarts it, asserting WAL recovery loses nothing and no delivery is double-acked.

**Gate:** all three pass ten consecutive runs. If any fail, fix the store before continuing — everything after this compounds on it.

### 2. Schema versioning

`migrate()` is `CREATE TABLE IF NOT EXISTS` with no version table, so the first schema change to a deployed bus is a silent corruption or a crash.

- A `schema_version` table, an ordered migration list, and a refusal to open a database newer than the code.
- A test that opens a database written by the previous schema and migrates it.

**Gate:** a database created before the change opens and works after it.

### 3. Cancellation

The one gap documented but not built, and it is what `dagr-remote` needs most: when a caller abandons work, the consumer runs to completion regardless.

- `POST /api/deliveries/:id/cancel` and `POST /api/messages/:seq/cancel` (admin or the publisher's token).
- A cancelled delivery's consumer learns on its next `extend`, which returns `{cancelled: true}`; `BusConsumer` aborts the handler's signal.
- `dagr-remote`'s `remoteExecutor` cancels on `ctx.signal` abort.
- Update both READMEs — the "cancellation is one-way" sections come out.

**Gate:** an e2e that starts a long handler, cancels it, and asserts the child process actually stopped.

### 4. Operability

Nobody can run this in anger without these.

- **Metrics.** `GET /metrics`, Prometheus text: messages published, deliveries by status, claim latency, lag per subscription, consumer count. Follow dagr's `MetricsSink` shape for consistency.
- **Graceful shutdown.** SIGTERM stops accepting claims, lets in-flight long-polls drain, then closes. Today it stops the server and closes the store, and the long-poll abort guard is the only thing that makes that safe.
- **Structured logging** with a level flag. `console.error` in a few places is the current story.
- **Backup and restore**, documented and tested: a `sqlite3 .backup`-based procedure that survives a restore into a running fleet.

**Gate:** `/metrics` scrapes clean; SIGTERM during an active soak loses nothing.

### 5. Operator surface

The API has actions the dashboard and CLI cannot reach.

- Dashboard: pause/resume a subscription, replay, purge, and a DLQ view with a requeue button.
- CLI: `bql-bus dlq <subscription>` to list, `bql-bus dlq requeue` to republish onto the original subject.
- Verify the dashboard with the browser agent, not by reading the JSX.

**Gate:** a dead letter can be inspected and requeued without touching `curl`.

### 6. Packaging

Nothing here is usable by anyone else until this is done.

- Publish `bql-bus` to npm: `files`, a build (dagr uses `bunup` — match it), exports verified from a clean install in a temp directory.
- Then `dagr-remote`, replacing `"bql-bus": "file:../../../bql-bus"` with the published version.
- README install instructions that work from `bun add bql-bus` rather than from a sibling checkout.

**Gate:** `bun add bql-bus` in an empty directory, then publish and consume a message.

### 7. Deployment

- A Dockerfile and a `fly.toml` (the owner has a Fly account). Loopback-bound by default; TLS terminated by the platform.
- Document the posture already stated in the README: one process, one file, no replication.

**Gate:** deployed, a remote consumer connects over TLS, a message round-trips.

## Explicitly not in scope

Do not build these, and do not let "100%" be read as including them:

- Replication, failover, multi-writer. One process owns one SQLite file. The store sits behind a seam so this is a future swap, not a rewrite — but do not start the swap.
- Exactly-once *delivery*. At-least-once with effectively-once effects is the contract.
- Message schemas or a registry. Priority classes. Hierarchical workspaces.
- Anything that makes the bus aware of workflows, agents, or dagr.

## Definition of done

- `bun run typecheck` · `bun test tests` · `bun run build` · `bun run test:e2e` all clean.
- `bun scripts/soak.ts` passes ten consecutive runs.
- dagr-remote's e2e passes, and dagr's own `bun run type-check` passes across all its packages.
- Both packages published and installable from npm.
- README and spec describe what the code actually does, including every limit.
- A report saying what you verified, how, and what you could not.
