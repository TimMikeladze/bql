# bql.sh/bus: a message bus for agents and ordinary work

Status: implemented. Supersedes an earlier design in which bql.sh/bus embedded dagr — the dependency was backwards. bql.sh/bus is a general-purpose message bus with no dependency on dagr, and dagr is one of its clients through `dagr-remote`.

## What it is

A durable, subject-addressed message bus on Bun and SQLite. Publish a message to a subject; durable subscriptions deliver it to consumers with leases, retries, ordering and a dead-letter path. Nothing in the core knows what an agent is — agent patterns (mailboxes, request/reply between agents, broadcast) are conventions over subjects, which is what keeps ordinary background work a first-class use rather than an afterthought.

Three things it must be at once:

1. **A work queue.** Competing consumers on one subscription, at-least-once, leases and fencing.
2. **Pub/sub.** Many subscriptions on one subject, each with its own cursor, so a message fans out.
3. **Request/reply.** A durable response addressed by correlation, so a caller can ask and later collect the answer even across a restart.

## Model

Five nouns.

| Noun | Identity | Immutable |
| --- | --- | --- |
| **Message** | `seq` (global order) + `id` | yes |
| **Subscription** | `(workspace, name)` | no — cursor moves |
| **Delivery** | `(subscription, message seq)` | no — lease, attempts |
| **Consumer** | operator-chosen id | no |
| **Response** | `(workspace, correlation)` | written once |

### Subjects

Dot-separated tokens: `orders.eu.created`, `agent.reviewer-1.inbox`, `work.bun`. Patterns use `*` for exactly one token and `>` for one-or-more trailing tokens — the NATS convention, because it is the one people already know.

`orders.*.created` matches `orders.eu.created`, not `orders.eu.west.created`.
`orders.>` matches both. `>` is only legal as the final token.

### Fan-out happens on pull, not on publish

Publishing writes one row. A subscription holds a `cursor_seq` into the log and, when a consumer asks for work, the broker materializes deliveries from the log:

```
claim(subscription, consumer, max):
  1. return expired leases on this subscription to pending
  2. scan the log forward from cursor_seq in bounded batches:
       matching messages  -> insert a delivery
       non-matching ones  -> skipped, and the cursor still advances past them
  3. lease up to `max` pending deliveries, oldest first
```

Advancing the cursor past examined non-matches is the load-bearing detail. The previous design filtered selectors in JavaScript *after* a `LIMIT 50`, so fifty non-matching rows could hide a matching one forever — a liveness bug that only appears once more than a couple of subjects exist. Here a non-match is consumed once and never looked at again.

It also means publish is O(1) regardless of how many subscriptions exist, and a subscription created today can read messages from last week by starting its cursor at `0`.

### Delivery semantics

At-least-once, with effectively-once effects available to anyone who wants them:

- A delivery is leased to one consumer for `ack_wait_ms`, with a monotonic `generation`. An ack, nack or extend from a stale generation is rejected.
- An expired lease returns the delivery to pending for another consumer, up to `max_attempts`.
- Exhausting attempts moves the delivery to `dead` **and republishes** the message onto the subscription's dead-letter subject with the failure reason in its headers, so a DLQ is an ordinary subscription and replay is an ordinary publish.
- `dedupe_key` is unique per workspace: publishing the same key twice returns the first message rather than creating a second.
- Every message carries a stable `idempotency` header (`<subscription>:<seq>`) for consumers that need to make external effects exactly once.

**Ordering.** A subscription may set `ordered: true`, which stops the broker from leasing a delivery whose message `key` already has an in-flight delivery in that subscription. Per-key FIFO, with unrelated keys still moving in parallel. Off by default, because ordering costs throughput and most work does not need it.

**Cancellation.** `cancelled` is a fourth terminal delivery status, and `messages.cancelled_at` stops a subscription materializing a delivery for a message it has not reached yet. A consumer learns on its next `extend`, which answers `{cancelled: true}`; the consume loop aborts the handler's signal and neither acks nor nacks, because the delivery is already terminal. Cancelling is the publisher's or an admin's — `messages.publisher` records the token subject, so it is the credential that published, not a field the payload can claim. See [the finishing spec](2026-09-13-finishing.md).

### Request/reply

A message published with `reply_to` and a `correlation` header is a request. The consumer that handles it publishes a response; the broker records it in `responses` keyed by `(workspace, correlation)`. The caller collects it with `GET /api/requests/:correlation`, which long-polls.

This is what makes RPC durable: the caller can die and come back, and the answer is still there. dagr's remote step dispatch is exactly this and gets no special case.

### Tenancy

`workspace` is a mandatory filter on **every** query, not a column that gets written and forgotten — which is what it was in the previous design, written on dispatch and read nowhere. A token carries its workspace; a request cannot name another one.

### Payloads

`{ subject, key, headers, body }`. Headers are a flat string map for routing and correlation; the body is arbitrary JSON. Bodies over `inlineMaxBytes` (default 64 KiB) go to a `BlobStore` — an interface with a filesystem implementation, so the SQLite row stays small.

## Storage

```sql
messages(seq PK AUTOINCREMENT, id UNIQUE, workspace, subject, key, headers, body,
         body_blob, published_at, expires_at, dedupe_key,
         UNIQUE(workspace, dedupe_key))
subscriptions(id PK, workspace, name, pattern, cursor_seq, ack_wait_ms,
              max_attempts, ordered, dlq_subject, paused, created_at,
              UNIQUE(workspace, name))
deliveries(id PK, subscription_id, message_seq, status, consumer_id, generation,
           attempt, lease_until, key, error, created_at, updated_at,
           UNIQUE(subscription_id, message_seq))
responses(workspace, correlation, message_seq, body, created_at,
          PRIMARY KEY(workspace, correlation))
consumers(id PK, workspace, name, subscriptions, labels, last_seen, paused)
schema_version(version PK, applied_at)
```

The schema is an ordered, append-only list of migrations rather than a pile of `CREATE TABLE IF
NOT EXISTS`. A database with the tables but no `schema_version` row is adopted at version 1; a
database at a version this build does not know is **refused**, because a binary rolled back onto
a newer schema cannot say what the extra columns mean.

Indexed on `messages(workspace, seq)`, `deliveries(subscription_id, status, message_seq)`, `deliveries(status, lease_until)`, `deliveries(subscription_id, status, key)`.

One broker process owns one SQLite file in WAL mode. Consumers never open it — they hold leases over HTTP, and the conditional `UPDATE … WHERE status='pending'` is what makes two consumers racing for one delivery safe rather than merely unlikely. The honest ceiling: fine for a fleet, wrong for infrastructure a dozen services depend on. The store is behind a seam so that is a swap and not a rewrite, but nothing here pretends to be replicated.

`reclaim` runs in the sweep and on the claim path **for one subscription only**, not as a global scan on every claim — the previous version's dominant write cost at any real consumer count. An idle long poll does not re-run it at all until the log moves or a lease could plausibly have expired.

Retention and TTL deletion are both guarded by "no unfinished delivery of this message": `deliveries` cascades from `messages`, and a cursor being past a message means it was examined, not that anyone finished it. Blob handles outlive their message row in a `blobs` table so orphans are collectable — a dead letter shares its original's handle, so "no message references it" is the only safe test.

## HTTP API

| Method | Path | |
| --- | --- | --- |
| `POST` | `/api/publish` | `{subject, key?, headers?, body, dedupeKey?, replyTo?, correlation?, ttlMs?}` |
| `POST` | `/api/subscriptions` | create or update `{name, pattern, ackWaitMs?, maxAttempts?, ordered?, deliverFrom?}` |
| `GET` `DELETE` | `/api/subscriptions[/:name]` | list, inspect, remove |
| `POST` | `/api/subscriptions/:name/claim` | `{consumer, max?, waitMs?}` — long-polls |
| `POST` | `/api/deliveries/:id/ack` `/nack` `/extend` | `{consumer, generation, …}`; `extend` also answers `{cancelled}` |
| `POST` | `/api/messages/:seq/cancel`, `/api/deliveries/:id/cancel` | stop work; publisher or admin |
| `POST` | `/api/subscriptions/:name/replay` | `{fromSeq}` — rewind the cursor |
| `POST` | `/api/requests` | publish and wait for the response |
| `GET` | `/api/requests/:correlation` | collect a response, long-polling |
| `GET` | `/api/messages/:seq`, `/api/log?after=` | read the log |
| `GET` | `/api/stream` | SSE: new sequence numbers |
| `POST` | `/api/consumers/register`, `/api/consumers/:id/pause` | fleet |
| `POST` | `/api/tokens` | mint a scoped token (admin) |
| `POST` | `/api/messages/:seq/requeue` | republish a dead letter onto its original subject |
| `GET` | `/api/log?subject=&newest=` | the log, filtered by subject pattern |
| `GET` | `/metrics` | Prometheus text (read token) |
| `GET` | `/health`, `/ready` | no token; `/ready` is 503 while draining |

## Security

Per-consumer HMAC tokens carrying `{ subject, scope, workspace, publish[], subscribe[], expiry }`. A token names the subject patterns it may publish to and the subscriptions it may claim from; `admin` mints and manages, `reader` observes. Verification is stateless. Carried forward from the existing implementation, with workspace and subject scoping added.

Transport stays the operator's problem: TLS or a tunnel. A bearer token must not cross an untrusted network in plaintext.

## dagr

dagr becomes a client and bql.sh/bus stops importing it. The two coupled modules move out:

| Today | Becomes |
| --- | --- |
| `src/worker/runtimes.ts` (hosts dagr's executors) | `dagr-remote` — a consumer that runs dagr steps off the bus |
| `src/host/serve.ts` (builds dagr's engine) | `dagr-remote` — registers the `remote` runtime |

`src/broker/*` already imports nothing from dagr, and `executor/remote.ts` imports only types, so this is a move rather than a rewrite. A remote step becomes `POST /api/requests` on subject `work.<runtime>`; the adapter package depends on both `dagr` and `bql-bus`, and neither depends on the other.

## Not in scope

Replication, failover, and multi-writer. Exactly-once delivery (as opposed to effectively-once effects). Message schemas or a registry. Priority classes. Hierarchical workspaces.
