# Exactly-once, in three tiers

End-to-end exactly-once against an arbitrary external system is not achievable, and bql.sh/bus
does not claim it. What it does offer is three tiers, each precisely bounded, and a named window
where the last one stops.

Pick the strongest tier your deployment can reach. They compose: a Tier 1 handler can still use
the ledger for a call it has to make to someone else.

| Tier | Guarantee | Requires |
| --- | --- | --- |
| 1 — transactional ack | **Exactly-once processing.** The handler's writes and the ack commit or roll back together. | Embedded mode, a synchronous handler, state in the bus's own SQLite file |
| 2 — atomic read-process-write | **Exactly-once within the bus.** The ack and the messages it produced commit together. | Nothing — it is an option on `ack` |
| 3 — fenced, ledgered effects | **Tight effectively-once** against the outside world, with the remaining window named below. | A destination that supports a conditional write, or an idempotent one |

---

## Tier 1 — transactional ack

The handler runs in the bus's own process and writes to the same SQLite file, so there is one
transaction and nothing to reconcile. No two-phase commit, no idempotency key, no compensation.

```ts
import { createBus } from "bql.sh/bus";

const bus = createBus({ path: "./data/bus.db", blobDirectory: "./data/blobs" });
bus.store.raw().run("CREATE TABLE IF NOT EXISTS processed (seq INTEGER PRIMARY KEY)");
bus.store.subscribe("default", { name: "work", pattern: "work.>" });

bus.consumeTransactional({
  subscription: "work",
  handle: (envelope, db) => {
    db.run("INSERT INTO processed (seq) VALUES (?)", [envelope.message.seq]);
  },
});
```

Kill the process anywhere inside that handler and you get both the row and the ack, or neither.
There is no state in which the work happened and the message comes back.

**The handler must be synchronous.** An `await` inside a SQLite transaction lets another
statement interleave into it, which destroys the one property this exists for. Do the I/O before
the delivery or after the ack; do the *writes* in the handler. The type signature says so.

This is the strongest guarantee available anywhere, and it exists **because** of the
single-writer design rather than despite it. The mode that makes the bus easy to run is the mode
that earns the guarantee.

## Tier 2 — atomic read-process-write

`ack` takes the messages the work produced and commits them in the same transaction:

```ts
await new BusConsumer({
  client,
  id: "resizer-1",
  subscription: "work",
  async handle({ message }, api) {
    api.emit({ subject: "thumbnails.ready", body: await resize(message.body) });
  },
}).start();
```

`api.emit` queues the publish; the ack sends it. The difference from calling `client.publish`
inside the handler is the whole point: that publishes now and acks later, so a crash between the
two duplicates the message on redelivery. A chain of consumers built this way is exactly-once end
to end for as long as the chain stays on the bus.

A **reply** is a special case of the same mechanism rather than a separate path — returning a
value from a handler that received a `reply-to` publishes the answer with the ack, so a crash
cannot leave a request answered but unacked.

The ack is also **idempotent for its own consumer**. A retry from the same consumer and
generation replays the original outcome and answers `replayed: true`, so a lost *response* — the
commonest way at-least-once turns into a duplicate — costs nothing. `BusConsumer` retries acks
for exactly this reason. An ack from a *different* consumer, or a different generation, is still
a conflict: "you already did this" and "someone else owns it now" are different facts and the
API says which.

## Tier 3 — fenced, ledgered effects

For a call to something that is not the bus, two mechanisms, used together.

**The fence token.** Every envelope carries `fence` — `<deliveryId>:<generation>` — which
identifies *this attempt*, not this message, and increases every time the delivery is leased. A
destination that supports a conditional write can reject a stale writer outright:

```ts
await db.run("UPDATE account SET balance = ?, fence = ? WHERE id = ? AND fence < ?", [
  balance, api.fence, id, api.fence,
]);
```

The `idempotencyKey` says "this is the same work". The fence says "this is the newer attempt".
They answer different questions and you will want both.

**The effect ledger.** `api.effect(key, work)` claims the key, runs `work` only if no previous
attempt recorded a result, and commits the result **with the ack**:

```ts
const charge = await api.effect(`charge:${message.body.orderId}`, () =>
  payments.charge(message.body),
);
```

A redelivery replays the recorded result instead of repeating the call.

### The window this does not close

A crash between "the external call succeeded" and "the result was recorded". The ledger then
holds a claim with no result, and the next attempt is told so — `{ fresh: true, retried: true }`
— which is the honest answer: the effect may or may not have happened. The fence makes the repeat
rejectable at the destination. Nothing makes it impossible.

That window is the floor, not a temporary state. If your destination supports neither a
conditional write nor an idempotent request, effectively-once is the strongest thing anyone can
offer you, and a system that claims otherwise is not counting the same crashes.

## What is still at-least-once

Plain `BusConsumer` with no `emit`, no `effect` and no transactional mode. A handler that
performs a side effect and then acks can have the side effect happen twice, because the ack can
be lost after the effect and before it commits. That is the default, it is documented as
at-least-once everywhere, and the three tiers above are how you climb out of it.
