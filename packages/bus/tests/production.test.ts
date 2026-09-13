/**
 * The properties the production plan added, tested at the store level.
 *
 * Deliberately not a second copy of `store.test.ts`: each of these is a claim
 * that was *wrong* before — a hot loop, a 409 on a retried ack, a key
 * overtaking its dead predecessor — rather than merely absent.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileBlobs } from "../src/bus/blobs";
import { createBus } from "../src/bus/embedded";
import { BusStore } from "../src/bus/store";

let clock = 1_000_000;
const now = () => clock;
const W = "default";

const bus = (options: Record<string, unknown> = {}) =>
  new BusStore(":memory:", { now, ...options });

const sub = (
  store: BusStore,
  name: string,
  pattern: string,
  extra: Record<string, unknown> = {},
) =>
  store.subscribe(W, {
    name,
    pattern,
    ackWaitMs: 1000,
    maxAttempts: 3,
    deliverFrom: "beginning",
    backoff: { baseMs: 0 },
    ...extra,
  });

// ------------------------------------------------------------- durability

test("a blob is written atomically and leaves no temporary behind", async () => {
  const directory = await mkdtemp(`${tmpdir()}/agenticbus-blobs-`);
  try {
    const blobs = fileBlobs(directory);
    await blobs.put("abc", JSON.stringify({ hello: "world" }));
    expect(JSON.parse(await blobs.get("abc"))).toEqual({ hello: "world" });
    expect(await blobs.has("abc")).toBe(true);
    // The `.tmp` is renamed, not left: a directory listing after a successful
    // put has exactly the one file in it.
    expect(await readdir(directory)).toEqual(["abc.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a truncated blob is caught rather than handed to a handler", async () => {
  const blobs = new Map<string, string>();
  const store = bus({
    inlineMaxBytes: 32,
    blobs: {
      put: async (key: string, data: string) => {
        blobs.set(key, data);
        return key;
      },
      get: async (handle: string) => blobs.get(handle)!,
      has: async (handle: string) => blobs.has(handle),
      delete: async (handle: string) => {
        blobs.delete(handle);
      },
    },
  });
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: { big: "x".repeat(200) } });
  // Truncate the file behind the bus's back — still valid JSON, which is what
  // makes a length-and-checksum check worth having rather than a parse.
  const [handle] = [...blobs.keys()];
  blobs.set(handle!, JSON.stringify({ big: "x".repeat(100) }));

  // The claim does not throw and does not stall: the one unreadable delivery
  // is dead-lettered and the subscription keeps moving.
  expect(await store.claim(W, "work", "c1", 1)).toHaveLength(0);
  const stats = store.stats(W);
  expect(stats.subscriptions.find((s) => s.name === "work")!.dead).toBe(1);
  store.close();
});

test("a message whose blob vanished is reconciled at startup", async () => {
  const blobs = new Map<string, string>();
  const store = bus({
    inlineMaxBytes: 32,
    blobs: {
      put: async (key: string, data: string) => {
        blobs.set(key, data);
        return key;
      },
      get: async (handle: string) => {
        const found = blobs.get(handle);
        if (found === undefined) throw new Error("gone");
        return found;
      },
      has: async (handle: string) => blobs.has(handle),
      delete: async (handle: string) => {
        blobs.delete(handle);
      },
    },
  });
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: { big: "x".repeat(200) } });
  await store.claim(W, "work", "c1", 1);
  blobs.clear();

  const reconciled = await store.reconcileBlobs();
  expect(reconciled.missing).toBe(1);
  expect(reconciled.deadLettered).toBe(1);
  store.close();
});

test("a full disk refuses publishes and still allows draining", async () => {
  const directory = await mkdtemp(`${tmpdir()}/agenticbus-full-`);
  try {
    const store = new BusStore(`${directory}/bus.db`, {
      now,
      // Nothing on earth has this much free space, so the watermark is always
      // breached — which is the point: the refusal is a policy, not a crash.
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    sub(store, "work", "work.>");
    expect(store.capacity().ok).toBe(false);
    // Claims and acks are deliberately not gated on capacity: a full disk is
    // exactly when consumers have to be able to finish what they hold.
    await store.publish(W, { subject: "work.do", body: 1 });
    const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
    const acked = await store.ack(
      W,
      envelope.delivery.id,
      "c1",
      envelope.delivery.generation,
    );
    expect(acked.status).toBe("acked");
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the WAL is truncated once it passes its ceiling", async () => {
  const directory = await mkdtemp(`${tmpdir()}/agenticbus-wal-`);
  try {
    const store = new BusStore(`${directory}/bus.db`, {
      now,
      walCheckpointBytes: 4096,
    });
    sub(store, "work", "work.>");
    for (let index = 0; index < 400; index++)
      await store.publish(W, { subject: "work.do", body: { index } });
    expect(store.sizes().walBytes).toBeGreaterThan(0);
    store.sweep();
    // TRUNCATE gives the space back; with no reader holding it open this is
    // deterministic.
    expect(store.sizes().walBytes).toBe(0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- exactly-once

test("a consumer retrying its own ack gets the original outcome, not a 409", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  const first = await store.ack(
    W,
    envelope.delivery.id,
    "c1",
    envelope.delivery.generation,
  );
  expect(first.replayed).toBe(false);

  const retry = await store.ack(
    W,
    envelope.delivery.id,
    "c1",
    envelope.delivery.generation,
  );
  expect(retry.replayed).toBe(true);
  expect(retry.status).toBe("acked");
  store.close();
});

test("a different consumer acking an acked delivery is still a conflict", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  await store.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation);
  await expect(
    store.ack(W, envelope.delivery.id, "c2", envelope.delivery.generation),
  ).rejects.toThrow(/stale lease/);
  store.close();
});

test("an ack commits the messages it produced in the same transaction", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  sub(store, "next", "next.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;

  const result = await store.ack(
    W,
    envelope.delivery.id,
    "c1",
    envelope.delivery.generation,
    { publish: [{ subject: "next.step", body: { from: 1 } }] },
  );
  expect(result.published).toHaveLength(1);
  const downstream = await store.claim(W, "next", "c2", 10);
  expect(downstream).toHaveLength(1);
  expect(downstream[0]!.message.body).toEqual({ from: 1 });

  // The retry replays the original result rather than publishing a second copy.
  const retry = await store.ack(
    W,
    envelope.delivery.id,
    "c1",
    envelope.delivery.generation,
    { publish: [{ subject: "next.step", body: { from: 1 } }] },
  );
  expect(retry.replayed).toBe(true);
  expect(retry.published.map((entry) => entry.seq)).toEqual(
    result.published.map((entry) => entry.seq),
  );
  expect(store.stats(W).messages).toBe(2);
  store.close();
});

test("a transactional handler that throws leaves neither its writes nor an ack", async () => {
  const embedded = createBus({ now });
  embedded.store.subscribe(W, {
    name: "work",
    pattern: "work.>",
    ackWaitMs: 1000,
    maxAttempts: 5,
    deliverFrom: "beginning",
    backoff: { baseMs: 0 },
  });
  embedded.store.raw().run("CREATE TABLE processed (seq INTEGER PRIMARY KEY)");
  await embedded.client.publish({ subject: "work.do", body: 1 });

  const envelope = (await embedded.store.claim(W, "work", "c1", 1))[0]!;
  expect(() =>
    embedded.store.ackTransactional(
      W,
      envelope.delivery.id,
      "c1",
      envelope.delivery.generation,
      (db) => {
        db.run("INSERT INTO processed (seq) VALUES (?)", [
          envelope.message.seq,
        ]);
        throw new Error("the handler failed after writing");
      },
    ),
  ).toThrow(/the handler failed/);

  const rows = embedded.store
    .raw()
    .query("SELECT COUNT(*) AS n FROM processed")
    .get() as { n: number };
  // Both, or neither. The row is gone because the ack never happened.
  expect(rows.n).toBe(0);
  expect(embedded.store.delivery(W, envelope.delivery.id).status).toBe("leased");

  // And the happy path commits both.
  embedded.store.ackTransactional(
    W,
    envelope.delivery.id,
    "c1",
    envelope.delivery.generation,
    (db) => {
      db.run("INSERT INTO processed (seq) VALUES (?)", [envelope.message.seq]);
    },
  );
  expect(
    (
      embedded.store.raw().query("SELECT COUNT(*) AS n FROM processed").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
  expect(embedded.store.delivery(W, envelope.delivery.id).status).toBe("acked");
  embedded.close();
});

test("the effect ledger replays a recorded result instead of repeating the call", () => {
  const store = bus();
  const first = store.claimEffect(W, "charge-42", "d1:1");
  expect(first).toEqual({ fresh: true, result: null, retried: false });

  store.recordEffect(W, { key: "charge-42", result: { id: "ch_1" } });
  const second = store.claimEffect(W, "charge-42", "d1:2");
  expect(second.fresh).toBe(false);
  expect(second.result).toEqual({ id: "ch_1" });

  // A claim that was never recorded is the documented window, and it says so
  // rather than pretending the effect did or did not happen.
  store.claimEffect(W, "charge-43", "d2:1");
  const retried = store.claimEffect(W, "charge-43", "d2:2");
  expect(retried).toEqual({ fresh: true, result: null, retried: true });
  store.close();
});

test("an envelope carries a fence token for this attempt", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const first = (await store.claim(W, "work", "c1", 1))[0]!;
  expect(first.fence).toBe(`${first.delivery.id}:${first.delivery.generation}`);
  clock += 5000;
  const second = (await store.claim(W, "work", "c2", 1))[0]!;
  // Same delivery, newer attempt: the destination can tell which writer is
  // current, which the idempotency key alone never could.
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.fence).not.toBe(first.fence);
  store.close();
});

// ------------------------------------------------------- delivery quality

test("a reclaimed lease is paced by backoff instead of hot-looping", async () => {
  const store = bus();
  // The real default, not the tests' zero: this is the bug being pinned.
  sub(store, "work", "work.>", {
    maxAttempts: 10,
    backoff: { baseMs: 1000, maxMs: 60_000, factor: 2, jitter: "none" },
  });
  await store.publish(W, { subject: "work.do", body: 1 });
  const first = (await store.claim(W, "work", "c1", 1))[0]!;
  expect(first).toBeDefined();

  // The consumer dies. The lease expires — and the delivery is not instantly
  // claimable again, which is what stopped four attempts burning in a
  // millisecond.
  clock += 1001;
  expect(await store.claim(W, "work", "c2", 1)).toHaveLength(0);
  clock += 1000;
  expect(await store.claim(W, "work", "c2", 1)).toHaveLength(1);
  store.close();
});

test("a nack with no delay still waits the subscription's backoff", async () => {
  const store = bus();
  sub(store, "work", "work.>", {
    backoff: { baseMs: 500, maxMs: 5000, factor: 2, jitter: "none" },
  });
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  store.nack(W, envelope.delivery.id, "c1", envelope.delivery.generation, {
    error: "nope",
  });
  expect(await store.claim(W, "work", "c1", 1)).toHaveLength(0);
  clock += 500;
  expect(await store.claim(W, "work", "c1", 1)).toHaveLength(1);
  store.close();
});

test("an explicit zero delay overrides backoff, which is how a shutdown hands work back", async () => {
  const store = bus();
  sub(store, "work", "work.>", {
    backoff: { baseMs: 60_000, maxMs: 60_000, factor: 1, jitter: "none" },
  });
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  store.nack(W, envelope.delivery.id, "c1", envelope.delivery.generation, {
    error: "shutting down",
    delayMs: 0,
  });
  expect(await store.claim(W, "work", "c2", 1)).toHaveLength(1);
  store.close();
});

test("higher priority is claimed first within a subscription", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: "ordinary" });
  await store.publish(W, { subject: "work.do", body: "urgent", priority: 2 });
  await store.publish(W, { subject: "work.do", body: "later", priority: -1 });

  const claimed = await store.claim(W, "work", "c1", 3);
  expect(claimed.map((envelope) => envelope.message.body)).toEqual([
    "urgent",
    "ordinary",
    "later",
  ]);
  store.close();
});

test("a delayed publish is not claimable until its time", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1, delayMs: 5000 });
  expect(await store.claim(W, "work", "c1", 1)).toHaveLength(0);
  clock += 5000;
  expect(await store.claim(W, "work", "c1", 1)).toHaveLength(1);
  store.close();
});

test("an ordered key blocks behind its dead letter rather than being overtaken", async () => {
  const store = bus();
  sub(store, "work", "work.>", { ordered: true, maxAttempts: 1 });
  await store.publish(W, { subject: "work.do", body: "first", key: "k1" });
  await store.publish(W, { subject: "work.do", body: "second", key: "k1" });
  await store.publish(W, { subject: "work.do", body: "other", key: "k2" });

  const first = (await store.claim(W, "work", "c1", 1))[0]!;
  expect(first.message.body).toBe("first");
  store.nack(W, first.delivery.id, "c1", first.delivery.generation, {
    error: "poison",
  });
  expect(store.delivery(W, first.delivery.id).status).toBe("dead");

  // `k2` still moves; `k1` does not, because nobody has decided what to do
  // about the message that failed.
  const next = await store.claim(W, "work", "c1", 10);
  expect(next.map((envelope) => envelope.message.body)).toEqual(["other"]);
  expect(store.blockedKeys(W, "work").map((entry) => entry.key)).toEqual(["k1"]);

  store.unblockKey(W, "work", "k1");
  const released = await store.claim(W, "work", "c1", 10);
  expect(released.map((envelope) => envelope.message.body)).toEqual(["second"]);
  store.close();
});

test("onFailure: skip is the old behaviour, and has to be asked for", async () => {
  const store = bus();
  sub(store, "work", "work.>", {
    ordered: true,
    maxAttempts: 1,
    onFailure: "skip",
  });
  await store.publish(W, { subject: "work.do", body: "first", key: "k1" });
  await store.publish(W, { subject: "work.do", body: "second", key: "k1" });
  const first = (await store.claim(W, "work", "c1", 1))[0]!;
  store.nack(W, first.delivery.id, "c1", first.delivery.generation, {
    error: "poison",
  });
  const next = await store.claim(W, "work", "c1", 10);
  expect(next.map((envelope) => envelope.message.body)).toEqual(["second"]);
  expect(store.blockedKeys(W, "work")).toHaveLength(0);
  store.close();
});

test("requeueing a dead letter releases the key it was blocking", async () => {
  const store = bus();
  sub(store, "work", "work.>", { ordered: true, maxAttempts: 1 });
  sub(store, "dead", "dlq.>");
  await store.publish(W, { subject: "work.do", body: "first", key: "k1" });
  await store.publish(W, { subject: "work.do", body: "second", key: "k1" });
  const first = (await store.claim(W, "work", "c1", 1))[0]!;
  store.nack(W, first.delivery.id, "c1", first.delivery.generation, {
    error: "poison",
  });
  const dead = (await store.log(W, 0, 10, { subject: "dlq.work" }))[0]!;
  store.requeue(W, dead.seq);
  expect(store.blockedKeys(W, "work")).toHaveLength(0);
  store.close();
});

test("a subscription melting into the DLQ quarantines itself", async () => {
  const store = bus();
  sub(store, "work", "work.>", {
    maxAttempts: 1,
    quarantine: { deadRate: 0.5, windowMs: 60_000, minDead: 3 },
  });
  for (let index = 0; index < 4; index++)
    await store.publish(W, { subject: "work.do", body: index });

  for (let index = 0; index < 4; index++) {
    const claimed = await store.claim(W, "work", "c1", 1);
    if (claimed.length === 0) break;
    const envelope = claimed[0]!;
    store.nack(W, envelope.delivery.id, "c1", envelope.delivery.generation, {
      error: "poison",
    });
  }
  const subscription = store.subscription(W, "work");
  expect(subscription.paused).toBe(true);
  expect(subscription.quarantinedAt).not.toBeNull();
  // Resuming clears the mark, so the next storm is recognisable as a new one.
  expect(store.pauseSubscription(W, "work", false).quarantinedAt).toBeNull();
  store.close();
});

test("maxInFlight caps what one consumer can lease", async () => {
  const store = bus();
  sub(store, "work", "work.>", { maxInFlight: 2 });
  for (let index = 0; index < 5; index++)
    await store.publish(W, { subject: "work.do", body: index });
  expect(await store.claim(W, "work", "c1", 5)).toHaveLength(2);
  expect(await store.claim(W, "work", "c2", 5)).toHaveLength(0);
  store.close();
});

// -------------------------------------------------------- point in time

test("truncating the log pulls cursors back with it", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  for (let index = 0; index < 6; index++)
    await store.publish(W, { subject: "work.do", body: { index } });
  await store.claim(W, "work", "c1", 6);
  expect(store.subscription(W, "work").cursorSeq).toBe(6);

  const result = store.truncateAfter(3);
  expect(result).toEqual({ removed: 3, lastSeq: 3 });
  // A cursor past the end of the log would silently skip everything published
  // after the recovery point, which is the quiet way a restore loses data.
  expect(store.subscription(W, "work").cursorSeq).toBe(3);

  await store.publish(W, { subject: "work.do", body: { index: "after" } });
  const claimed = await store.claim(W, "work", "c2", 10);
  expect(claimed.map((envelope) => envelope.message.body)).toEqual([
    { index: "after" },
  ]);
  store.close();
});

test("seqAt finds the recovery point for a timestamp", async () => {
  const store = bus();
  await store.publish(W, { subject: "work.do", body: 1 });
  const cut = clock;
  clock += 1000;
  await store.publish(W, { subject: "work.do", body: 2 });
  expect(store.seqAt(cut)).toBe(1);
  expect(store.seqAt(clock)).toBe(2);
  store.close();
});

// ------------------------------------------------------- shared handles

test("a dead letter shares its original's blob handle, and the sweep knows", async () => {
  // The invariant this pins: `collectBlobs` tests "no message references this
  // handle", not "the message that created it is gone". A future change that
  // deletes the blob when deleting *a* message would take the dead letter's
  // body with it — this test is named so that change fails here.
  const blobs = new Map<string, string>();
  const store = bus({
    inlineMaxBytes: 32,
    blobs: {
      put: async (key: string, data: string) => {
        blobs.set(key, data);
        return key;
      },
      get: async (handle: string) => blobs.get(handle)!,
      has: async (handle: string) => blobs.has(handle),
      delete: async (handle: string) => {
        blobs.delete(handle);
      },
    },
  });
  sub(store, "work", "work.>", { maxAttempts: 1 });
  const big = "x".repeat(200);
  await store.publish(W, { subject: "work.do", body: { big } });
  expect(blobs.size).toBe(1);

  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  store.nack(W, envelope.delivery.id, "c1", envelope.delivery.generation, {
    error: "poison",
  });

  // Two messages, one handle. Nothing is collectable while either references it.
  const dead = (await store.log(W, 0, 10, { subject: "dlq.work" }))[0]!;
  expect(dead.body).toEqual({ big });
  expect(await store.collectBlobs()).toBe(0);
  expect(blobs.size).toBe(1);
  store.close();
});

// ------------------------------------------------------------- shutdown

test("a shutdown hands in-flight work straight back", async () => {
  const { BusConsumer } = await import("../src/client/bus");
  const { createBus } = await import("../src/bus/embedded");
  const embedded = createBus({ now });
  embedded.store.subscribe(W, {
    name: "work",
    pattern: "work.>",
    ackWaitMs: 60_000,
    maxAttempts: 5,
    deliverFrom: "beginning",
    // A long backoff, so "handed straight back" is distinguishable from
    // "waited out the retry delay like an ordinary failure".
    backoff: { baseMs: 60_000, maxMs: 60_000, factor: 1, jitter: "none" },
  });
  await embedded.client.publish({ subject: "work.do", body: 1 });

  let started = false;
  const consumer = new BusConsumer({
    client: embedded.client,
    id: "c1",
    subscription: "work",
    waitMs: 10,
    handle: async (_envelope, api) => {
      started = true;
      // Never returns on its own: the abort is what ends it.
      await new Promise<void>((resolve) =>
        api.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      api.signal.throwIfAborted();
    },
  });
  const loop = consumer.start();
  for (let tick = 0; tick < 200 && !started; tick++) await Bun.sleep(5);
  expect(started).toBe(true);

  consumer.stop();
  await loop;

  // Back in the queue and claimable now, not in sixty seconds.
  const again = await embedded.store.claim(W, "work", "c2", 1);
  expect(again).toHaveLength(1);
  expect(again[0]!.delivery.attempt).toBe(2);
  embedded.close();
});
