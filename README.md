# AgenticBus

A durable message bus for agents and ordinary work. Bun, SQLite, no runtime dependencies.

Publish to a subject; durable subscriptions deliver to consumers with leases, retries, ordering and a dead-letter path. Nothing in the core knows what an agent is — agent patterns are conventions over subjects, which is what keeps a plain background job queue a first-class use rather than an afterthought.

```sh
agenticbus serve &
agenticbus subscribe work 'work.>'
agenticbus consume work --exec ./handle.sh &
agenticbus publish work.resize '{"src":"a.png"}'
```

Three things at once, from one set of primitives:

| | |
| --- | --- |
| **Work queue** | Competing consumers on one subscription, at-least-once, leases and fencing |
| **Pub/sub** | Many subscriptions on one subject, each with its own cursor, so a message fans out |
| **Request/reply** | A durable response addressed by correlation — ask now, collect after a restart |

## Install

Bun 1.4 or newer.

```sh
bun add agenticbus
bunx agenticbus serve &
bunx agenticbus subscribe work 'work.>'
bunx agenticbus publish work.resize '{"src":"a.png"}'
```

The package ships the library, the `agenticbus` binary and the built dashboard, so `serve` has a
UI with nothing else to install.

**Working on the bus itself** runs it from source instead:

```sh
bun install
bun run build      # the library bundle and the dashboard
bun run dev
```

`bun run dev` starts the bus, three consumer processes and the dashboard, choosing free ports rather than fighting for taken ones.

```sh
bun src/cli/index.ts publish work.slow '{"ms":2000}'
bun src/cli/index.ts request rpc.upper '"hello"'
bun src/cli/index.ts stats
```

![The dashboard](docs/images/dashboard.png)

**The dashboard is read-only until you hand it a token.** The one the bus injects is a `reader`
token — a page that can be opened is not a page that can dispatch work. Pausing, replaying,
purging and requeueing appear once you paste an admin token into **Operator actions**, which is
kept in `sessionStorage` and dies with the tab.

## Subjects

Dot-separated tokens. `*` matches exactly one token, `>` matches one or more trailing tokens — the NATS convention, because people already know it.

```
orders.eu.created        a concrete subject
orders.*.created         matches orders.eu.created, not orders.eu.west.created
orders.>                 matches both
>                        everything
```

## Fan-out happens on pull, not on publish

A subscription holds a cursor into the log. When a consumer asks for work, the bus reads forward from that cursor and creates deliveries for the messages that match.

Three consequences worth knowing:

- **Publishing is O(1)** in the number of subscriptions. Adding the fiftieth subscriber costs producers nothing.
- **A subscription created today can read last week**, with `deliverFrom: "beginning"` or any sequence number.
- **A wall of unrelated subjects cannot starve a subscription.** The cursor advances past messages it examined and did not match, so they are never looked at again. Matching *after* a `LIMIT` — the obvious implementation — is a liveness bug that only appears once you have more than a couple of subjects.

## Delivery

At-least-once, with effectively-once effects available to anyone who wants them.

- A delivery is leased to one consumer for the subscription's `ackWaitMs`, with a monotonic `generation`. An ack or nack from a stale generation is rejected.
- An expired lease returns the delivery to the queue for another consumer, up to `maxAttempts`.
- Exhausting attempts **dead-letters onto an ordinary subject** (`dlq.<subscription>` by default) with the reason in the headers — so a DLQ is just another subscription, and a replay is just another publish. `agenticbus dlq <subscription>` lists them and `dlq requeue <seq>` republishes one onto the subject it failed on, with the `dlq-*` headers stripped and `requeued-from` added. A requeued message is an ordinary new message with its own sequence number: if it fails again it dead-letters again, which is the honest outcome.
- `dedupeKey` is unique per workspace: publishing the same key twice returns the first message, and a deduplicated *request* is handed back the original correlation, so it waits on the answer that will actually arrive.
- Every envelope carries `idempotencyKey` (`<subscription>:<seq>`), stable across redeliveries, for consumers making external effects.

**Ordering.** `ordered: true` stops the bus leasing a delivery whose message `key` already has one in flight on that subscription. Per-key FIFO, with unrelated keys still moving in parallel. Off by default, because ordering costs throughput and most work does not need it.

**Cancellation.** `agenticbus cancel <seq>` stops a message: every unfinished delivery of it moves to a fourth terminal status, `cancelled`, and no subscription will create a new one — including a subscription whose cursor has not reached it yet.

A consumer already running the work learns on its **next lease renewal**, which answers `{cancelled: true}` rather than failing. `BusConsumer` aborts the handler's `signal`, and `--exec` passes that signal to the child process, so the work actually stops rather than a row merely changing colour. Cancelled deliveries are neither acked nor nacked and are never retried.

Cancelling is the **publisher's** call, or an admin's — the bus records which token published each message. A consumer cannot cancel its own work, because a consumer that could make a message it disliked disappear is a very quiet way to lose work.

## Writing a consumer

```ts
import { BusClient, BusConsumer, FatalError } from "agenticbus/client";

const client = new BusClient({ url: "http://127.0.0.1:4317", token: process.env.BUS_TOKEN! });

await new BusConsumer({
  client,
  id: "resizer-1",
  subscription: "work",
  prefetch: 4,
  async handle({ message }, api) {
    if (!supported(message.body)) throw new FatalError("unsupported format");
    await api.extend();               // renew the lease from a long handler
    return { ok: true };              // a returned value answers a request
  },
}).start();
```

Return normally and the message is acked. Throw and it is nacked, retried, and eventually dead-lettered. Throw `FatalError` to dead-letter immediately, because a message this consumer can never handle should not be tried four more times.

Set `handlerTimeoutMs` (or `--exec-timeout`) on anything that could hang. The loop renews the lease for as long as a handler is pending, so the mechanism that protects slow work protects stuck work just as well — without a timeout, a wedged handler holds its message indefinitely.

If the message carried a `reply-to`, whatever the handler returns becomes its response — an RPC consumer is an ordinary consumer that happens to return a value.

**In any other language**, `--exec` is the whole integration: the message arrives on stdin, and stdout becomes the reply.

```sh
agenticbus consume work --exec ./resize.sh --prefetch 4
```

## CLI

| | |
| --- | --- |
| `agenticbus serve` | run the bus |
| `agenticbus token --consumer id --publish 'a.>' --subscribe work` | mint a scoped token |
| `agenticbus publish <subject> <json>` | publish |
| `agenticbus request <subject> <json>` | publish and wait for a reply |
| `agenticbus subscribe <name> <pattern>` | create a durable subscription |
| `agenticbus consume <subscription> --exec CMD [--exec-timeout ms]` | run a consumer |
| `agenticbus cancel <seq>` | stop a message; in-flight handlers abort |
| `agenticbus dlq <subscription>` · `dlq requeue <seq…>` | inspect and requeue dead letters |
| `agenticbus backup <dir>` | a consistent copy of the database and blobs |
| `agenticbus tail` · `stats` | follow the log; subscriptions, consumers, lag |

## HTTP API

| Method | Path | |
| --- | --- | --- |
| `POST` | `/api/publish` | `{subject, key?, headers?, body, dedupeKey?, replyTo?, ttlMs?}` |
| `POST` `GET` | `/api/subscriptions` | create; list |
| `POST` | `/api/subscriptions/:name/claim` | `{consumer, max, waitMs}` — long-polls |
| `POST` | `/api/subscriptions/:name/replay` `/purge` `/pause` | operator actions |
| `POST` | `/api/deliveries/:id/ack` `/nack` `/extend` | `/extend` answers `{cancelled}` too |
| `POST` | `/api/messages/:seq/cancel` · `/api/deliveries/:id/cancel` | stop work; publisher or admin |
| `POST` `GET` | `/api/requests[/:correlation]` | request/reply, both long-polling |
| `GET` | `/api/messages/:seq` · `/api/log[?subject=&newest=]` · `/api/stream` | the log; SSE refresh signal |
| `POST` | `/api/messages/:seq/requeue` | republish a dead letter onto its original subject |
| `POST` `GET` | `/api/consumers/register` · `/api/consumers` · `/api/stats` | fleet |
| `POST` | `/api/tokens` | mint (admin) |
| `GET` | `/metrics` | Prometheus text (read token) |
| `GET` | `/health` · `/ready` | no token; `/ready` is 503 while draining |

## Operating it

[docs/operations.md](docs/operations.md) is the whole story: what to scrape, what to alert on,
how a backup is taken and restored, and what the fleet does afterwards. The short version:

```sh
agenticbus serve --log-level info --log-format json
curl -H "Authorization: Bearer $READER" localhost:4317/metrics
agenticbus backup /backups/$(date +%F)
```

**SIGTERM drains.** The bus stops handing out work first — a claim answers empty rather than
holding the consumer for the rest of its long poll — then lets parked polls return, then finishes
requests in flight, and only then closes the database. `bun run soak --term-bus` is the check:
SIGTERM in the middle of five thousand messages, restart, nothing lost.

**Counters live in the store, gauges are read at scrape time.** A gauge only written when
something moves is stale exactly when it matters: an idle subscription with a thousand pending
deliveries would keep reporting whatever it last reported.

## Security

**Scoped tokens.** A token names its workspace, the subject patterns it may publish to, and the subscriptions it may claim from. Grants are patterns, so `orders.>` licenses everything beneath it. Verification is a signature check with no database round trip — so revocation is by expiry or key rotation, which is the trade a stateless token always makes.

**Three scopes.** `admin` publishes anywhere, manages subscriptions and mints tokens. `consumer` publishes and claims within its grants. `reader` observes, and is what the dashboard is given — a page that can be opened is not a page that can dispatch work.

**Tenancy is enforced, not decorative.** `workspace` is a mandatory filter on every query, and a non-admin token is pinned to its own: it cannot name another one in a header.

**The signing key and admin token live in `.agenticbus/` at mode 0600**, not in argv where `ps` would show them.

**Transport is the operator's job.** A bearer token must not cross an untrusted network in plaintext: terminate TLS or use a tunnel.

## Verify

```sh
bun run typecheck
bun test tests
bun run build
bun run test:e2e
bun run verify-pack
```

`verify-pack` is the one that catches what the others cannot: it packs the tarball, installs it
into an empty directory, imports every advertised entry point and starts a bus from the installed
copy. A bundler can drop a module and still emit its name in the export list — that failure would
otherwise surface in someone else's install.

The end-to-end check is real processes and no mocks — competing consumers, fan-out, a consumer **SIGKILLed mid-message**, a poison message, and a request answered from another process:

```
ok   eight messages were handled with none left pending or dead — pending=0 dead=0
ok   a second subscription received the same messages independently — 8 envelopes
ok   killed worker-a while it held the slow message
ok   a surviving consumer recovered the expired lease — attempt 2, now on worker-b
ok   the poison message reached the dead-letter subject with its reason — unsupported payload
ok   a request was answered by a consumer in another process — "HELLO BUS"
ok   a long handler is running as a real child process — pid 86892
ok   cancelling the message cancelled its in-flight delivery — 1 delivery
ok   the consumer's child process actually stopped
ok   a repeated dedupe key does not publish twice
```

And `bun run soak` is the contention check the unit tests cannot be: eight consumer processes racing on one subscription, 5000 messages, consumers SIGKILLed throughout, asserting every message was handled at least once and acked exactly once with nothing left pending. `--ordered` adds per-key FIFO under kills; `--kill-bus` kills the broker itself mid-flight.

```sh
bun run soak
bun run soak --ordered
bun run soak --kill-bus --repeat 10
```

## dagr

[dagr](https://github.com/TimMikeladze/dagr) is a workflow engine that runs one process against one SQLite journal, and says so plainly: multi-process execution is out of scope, because its single writer is load-bearing. `dagr-remote` closes that gap by putting this bus between the engine and its handlers — a step declares `runtime: remote`, the request goes onto a subject, and a consumer on another machine answers it.

```yaml
review:
  kind: task
  runtime: remote
  with:
    run: agent
    input: { prompt_file: ./prompts/review.md, model: claude-opus-5 }
```

That package lives in dagr's repository and depends on this one. **The bus has no dependency on dagr** — it is one client among many, and nothing about workflows leaks into the core.

## Boundaries

One process owns one SQLite file in WAL mode. Consumers never open it; they hold leases over HTTP, and every claim is a conditional `UPDATE` that only transitions *out of* `pending`, so two consumers racing for one delivery is safe rather than merely unlikely.

The honest ceiling: this is right for a fleet and wrong for infrastructure a dozen services depend on. Replication, failover and multi-writer are not implemented. The store sits behind a seam so that is a swap rather than a rewrite — but nothing here pretends to be a replicated log.

Also not implemented: exactly-once delivery (as opposed to effectively-once effects), message schemas, and priority classes.

## Design

- [A message bus for agents and ordinary work](docs/superpowers/specs/2026-09-12-message-bus.md) — the current design and why it is shaped this way.
- [Finishing AgenticBus](docs/superpowers/specs/2026-09-13-finishing.md) — schema versioning, cancellation, operability, packaging and the decisions behind them.
- [Running it](docs/operations.md) — metrics, logging, shutdown, backup and restore.
