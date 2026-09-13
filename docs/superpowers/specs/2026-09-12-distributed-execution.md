# AgenticBus: distributed execution for dagr workflows

Status: implemented. Replaces the prototype's fixed `creator → reviewer → tester` coordinator and the capability-DAG design that briefly replaced it. No backwards compatibility: the protocol, store, worker CLI, and dashboard all change.

## The decision

AgenticBus does not define workflows. [`dagr`](../../../../dagr) does, and it is 13,700 lines ahead — twelve step kinds, status-aware joins, `foreach`, sub-workflows, loops, human gates, handler-raised questions, checkpoints, resource governance, schedules, triggers, an expression language with a conformance suite. Rebuilding any of that here produces a subset with fewer tests.

AgenticBus owns the one thing dagr rules out on purpose. From `dagr/docs/spec.md` §19:

> Multi-process / multi-node execution … the single-writer design is load-bearing … Adding a second writer is a redesign of those three, not a feature to bolt on.

So AgenticBus is **remote execution for dagr steps**: the engine stays one process with one writer, and step *handlers* move to other machines. Workers never open the engine's database — they speak HTTP to a broker. dagr's invariant is not bent, because nothing about it is contested.

This keeps AgenticBus standalone as a product (its own binary, own service, own store, own operational surface) while supporting 100% of dagr's step kinds *by construction* rather than by chasing parity: the graph is executed by dagr's engine, so every kind it supports works the day it ships one.

### Why not the alternatives

| Option | Verdict |
| --- | --- |
| Reimplement the DAG engine here | A subset of dagr, minus the conformance suite. Rejected. |
| Fork dagr and add a second writer | Redesigns three load-bearing invariants (seq-order-is-commit-order, the no-op advance lock, the in-process transaction queue) to solve a problem that remote workers do not actually have. Rejected. |
| Blocking HTTP calls from a `runtime: http` step | Works, and is the zero-code baseline — but the remote side gets no claim, no lease, no heartbeat and no attempt cap, so a dead worker costs a coarse timeout and never re-dispatches. This is the gap AgenticBus fills. |

## Architecture

```
┌──── engine host ── dagr engine + worker loop ── dagr.db (one writer) ────┐
│  executors: [ remoteExecutor({ runtime: "remote", broker }), … ]          │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │  dispatch · await · cancel   (HTTP)
┌────────────────────────────▼──── broker ── bus.db ───────────────────────┐
│  queue · claim · lease · heartbeat · generation fence · journal           │
└──────────▲──────────────────────────────────▲────────────────────────────┘
           │ register · claim · heartbeat · complete · progress
    ┌──────┴──────┐                    ┌──────┴──────┐
    │  worker A   │                    │  worker B   │   other machines
    │ dagr's own  │                    │ dagr's own  │
    │  executors  │                    │  executors  │
    └─────────────┘                    └─────────────┘
```

**The worker is a harness around dagr's own executors.** `bunExecutor`, `shellExecutor`, `httpExecutor`, `pythonExecutor`, `agentExecutor` and `promptExecutor` are all exported from the `dagr` package root. The worker synthesizes a `StepContext` from the claimed task and calls `executor.run(ctx)`. Runtime parity is therefore not a reimplementation — it is the same code on a different host, including every default-deny allowlist and the agent runtime's session-id checkpointing.

## Contracts

### Dispatch (engine → broker)

`remoteExecutor` is an ordinary dagr `Executor`. Its `run(ctx)`:

1. `POST /api/tasks` with `ctx.idempotencyKey` (dagr's stable `${runId}:${stepKey}`). The broker returns the existing task when that key is already present, so a re-dispatch never duplicates remote work.
2. `ctx.setCheckpoint({ taskId })` immediately, before waiting on anything.
3. Poll for a terminal state, starting at 250ms and backing off to 2s — a four-hour agent step must not cost four hours of tight polling, and a two-second step must not wait two seconds to be noticed. dagr's own worker loop renews the step lease on a timer while this waits, so nothing here touches the lease.
4. `ctx.signal` aborting → `POST /api/tasks/:id/cancel`; the broker asks the worker to stop on its next heartbeat.
5. Terminal success → `{ value, usage }`, so resource governance still accounts remote agent spend. Terminal failure → throw, so dagr classifies and retries by its own policy.

**A reclaimed attempt reattaches.** If the engine host dies mid-step, the reclaim sweep re-runs the step, `ctx.checkpoint.taskId` is present, and the executor resumes waiting on remote work that never stopped. This is the same trick dagr's agent runtime uses for session ids, applied to a whole remote step.

Two attempt counters exist and mean different things: the **broker's** attempts recover a dead worker, the **engine's** `retries` re-run a step that genuinely failed. Documented, not merged.

### Routing

`runtime` is an open string in dagr, so no dagr change is needed. A remoted step names the inner runtime and its selector:

```yaml
review:
  kind: task
  runtime: remote
  with:
    run: agent                       # the runtime the remote worker executes
    select: { pool: gpu, mode: live }  # every entry must match the worker's labels
    input:                            # the inner runtime's own `with`
      prompt_file: ./prompts/review.md
      model: claude-opus-5
```

A host registers one remote executor per resource class, because `consumesAgentResources` is a static property of the executor: `remoteExecutor({ runtime: "remote" })` for portable runtimes, `remoteExecutor({ runtime: "remote-agent", agentClass: true })` for remoted agent work.

### Broker task lifecycle

`queued → claimed (lease, generation) → running (heartbeats) → succeeded | failed | cancelled`

Carried forward from the prototype, which already got these right: expiring leases, monotonic generations, rejection of stale completions, duplicate-safe completion keyed on a result digest, and the worker's on-disk outbox so a completed computation survives a broker outage.

### Authentication

Per-worker tokens, not one shared secret. The broker holds a signing key and mints HMAC-SHA-256 tokens carrying `{ workerId, runtimes, labels, expiry }`; verification is stateless, and a token cannot claim a task outside its runtimes, advertise labels it was not issued for, or impersonate another worker. Minting requires the admin token. This closes the prototype's "the token grants all worker operations" gap.

Transport security stays an operator responsibility: HTTPS termination or an encrypted tunnel. A bearer token must not cross an untrusted network in plaintext.

## Package layout

```
src/broker/     store.ts  server.ts  tokens.ts     the service and its SQLite journal
src/executor/   remote.ts                          the dagr Executor
src/worker/     runner.ts  runtimes.ts             the remote harness around dagr's executors
src/host/       serve.ts                           dagr engine + broker + executor, one process
src/cli/        index.ts                           agenticbus serve | broker | worker | token
src/shared/     protocol.ts                        wire types
```

`agenticbus serve` is the single-box deployment. `agenticbus broker` and `agenticbus worker` are the split one. The dashboard becomes a **fleet** view — workers, runtimes, labels, queue depth, leases, in-flight tasks — which is the thing dagr's run-centric UI does not show; run and step inspection stays dagr's job.

## Boundaries

The broker is one availability boundary, as the engine host is. Cancel stops acceptance of results and asks workers to stop; it does not undo work already done.

A remote worker runs handler code as its own user. `agent`, `shell`, `bun` and `python` steps reach the worker host's filesystem — a child process is a crash boundary, not a sandbox. Run untrusted definitions on workers registering only `http`, or put each worker in a container or VM. The trust posture is inherited from dagr's, and stated the same way.
