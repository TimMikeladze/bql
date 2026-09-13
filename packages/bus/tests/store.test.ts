import { expect, test } from "bun:test";
import { BusStore } from "../src/bus/store";

let clock = 1_000_000;
const now = () => clock;
const bus = () => new BusStore(":memory:", { now });
const W = "default";

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
    maxAttempts: 2,
    deliverFrom: "beginning",
    // These tests drive a frozen clock and assert on the transition itself, so
    // they opt out of retry pacing. The pacing has tests of its own below —
    // running it here would only be asserting that `Math.random` works.
    backoff: { baseMs: 0 },
    ...extra,
  });

test("a message fans out to every matching subscription, once each", async () => {
  const store = bus();
  sub(store, "audit", "orders.>");
  sub(store, "billing", "orders.*.created");
  await store.publish(W, { subject: "orders.eu.created", body: { id: 1 } });

  const audit = await store.claim(W, "audit", "c1", 10);
  const billing = await store.claim(W, "billing", "c2", 10);
  expect(audit).toHaveLength(1);
  expect(billing).toHaveLength(1);
  expect(audit[0]!.message.body).toEqual({ id: 1 });
  // Each subscription has its own cursor, so one publish is two deliveries.
  expect(audit[0]!.delivery.id).not.toBe(billing[0]!.delivery.id);
  store.close();
});

test("competing consumers on one subscription each get different messages", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  for (let index = 0; index < 4; index++)
    await store.publish(W, { subject: "work.do", body: { index } });

  const first = await store.claim(W, "work", "c1", 2);
  const second = await store.claim(W, "work", "c2", 2);
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(2);
  const seqs = [...first, ...second].map((e) => e.message.seq);
  expect(new Set(seqs).size).toBe(4);
  store.close();
});

test("a non-matching run cannot hide a matching message behind it", async () => {
  const store = bus();
  sub(store, "rare", "rare.event");
  // Many unrelated subjects, then the one this subscription wants.
  for (let index = 0; index < 120; index++)
    await store.publish(W, { subject: "noise.tick", body: index });
  await store.publish(W, { subject: "rare.event", body: "here" });

  const envelopes = await store.claim(W, "rare", "c1", 1);
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.message.body).toBe("here");
  store.close();
});

test("a subscription can start from the beginning or from now", async () => {
  const store = bus();
  await store.publish(W, { subject: "a.b", body: "old" });
  const fresh = store.subscribe(W, { name: "fresh", pattern: "a.>" });
  const historic = store.subscribe(W, {
    name: "historic",
    pattern: "a.>",
    deliverFrom: "beginning",
  });
  expect(fresh.cursorSeq).toBeGreaterThan(0);
  expect(historic.cursorSeq).toBe(0);

  expect(await store.claim(W, "fresh", "c1", 10)).toHaveLength(0);
  expect(await store.claim(W, "historic", "c1", 10)).toHaveLength(1);
  store.close();
});

test("an expired lease returns the delivery to another consumer", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });

  const first = await store.claim(W, "work", "c1", 1);
  expect(await store.claim(W, "work", "c2", 1)).toHaveLength(0);
  clock += 5000;
  const second = await store.claim(W, "work", "c2", 1);
  expect(second).toHaveLength(1);
  expect(second[0]!.delivery.attempt).toBe(2);
  expect(second[0]!.delivery.generation).toBeGreaterThan(
    first[0]!.delivery.generation,
  );
  store.close();
});

test("acking with a stale generation is rejected", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const stale = (await store.claim(W, "work", "c1", 1))[0]!;
  clock += 5000;
  await store.claim(W, "work", "c2", 1);
  await expect(
    store.ack(W, stale.delivery.id, "c1", stale.delivery.generation),
  ).rejects.toThrow(/stale lease/);
  store.close();
});

test("an acked delivery is not redelivered", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  await store.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation);
  clock += 10_000;
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(0);
  store.close();
});

test("exhausting attempts dead-letters onto an ordinary subject", async () => {
  const store = bus();
  sub(store, "work", "work.>", { maxAttempts: 2 });
  sub(store, "failures", "dlq.>");
  await store.publish(W, { subject: "work.do", body: "poison" });

  for (let attempt = 0; attempt < 2; attempt++) {
    const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
    store.nack(W, envelope.delivery.id, "c1", envelope.delivery.generation, {
      error: "boom",
    });
  }
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(0);

  const dead = await store.claim(W, "failures", "c2", 10);
  expect(dead).toHaveLength(1);
  expect(dead[0]!.message.body).toBe("poison");
  expect(dead[0]!.message.headers["dlq-reason"]!).toBe("boom");
  expect(dead[0]!.message.headers["dlq-subject"]!).toBe("work.do");
  store.close();
});

test("a fatal nack skips the remaining attempts", async () => {
  const store = bus();
  sub(store, "work", "work.>", { maxAttempts: 5 });
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  store.nack(W, envelope.delivery.id, "c1", envelope.delivery.generation, {
    fatal: true,
    error: "cannot handle",
  });
  clock += 5000;
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(0);
  store.close();
});

test("a delayed nack holds the delivery back", async () => {
  const store = bus();
  sub(store, "work", "work.>", { maxAttempts: 5 });
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  store.nack(W, envelope.delivery.id, "c1", envelope.delivery.generation, {
    delayMs: 5000,
  });
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(0);
  clock += 6000;
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(1);
  store.close();
});

test("an ordered subscription serializes deliveries sharing a key", async () => {
  const store = bus();
  sub(store, "work", "work.>", { ordered: true });
  await store.publish(W, { subject: "work.do", body: 1, key: "cart-1" });
  await store.publish(W, { subject: "work.do", body: 2, key: "cart-1" });
  await store.publish(W, { subject: "work.do", body: 3, key: "cart-2" });

  const batch = await store.claim(W, "work", "c1", 10);
  // Two of the three, because the second cart-1 message waits its turn.
  expect(batch.map((e) => e.message.body).sort()).toEqual([1, 3]);

  await store.ack(W, batch[0]!.delivery.id, "c1", batch[0]!.delivery.generation);
  const next = await store.claim(W, "work", "c1", 10);
  expect(next.map((e) => e.message.body)).toEqual([2]);
  store.close();
});

test("an unordered subscription does not serialize on key", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1, key: "k" });
  await store.publish(W, { subject: "work.do", body: 2, key: "k" });
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(2);
  store.close();
});

test("publishing the same dedupe key twice returns the first message", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  const first = await store.publish(W, {
    subject: "work.do",
    body: 1,
    dedupeKey: "order-7",
  });
  const second = await store.publish(W, {
    subject: "work.do",
    body: 2,
    dedupeKey: "order-7",
  });
  expect(second.seq).toBe(first.seq);
  expect(second.duplicate).toBe(true);
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(1);
  store.close();
});

test("replay after purge redelivers settled messages", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  await store.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation);

  store.replay(W, "work", 0);
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(0); // acked, skipped
  store.purge(W, "work", 0);
  store.replay(W, "work", 0);
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(1);
  store.close();
});

test("a paused subscription hands out nothing", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  store.pauseSubscription(W, "work", true);
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(0);
  store.pauseSubscription(W, "work", false);
  expect(await store.claim(W, "work", "c1", 10)).toHaveLength(1);
  store.close();
});

test("workspaces cannot see each other's messages or subscriptions", async () => {
  const store = bus();
  store.subscribe("tenant-a", {
    name: "work",
    pattern: "work.>",
    deliverFrom: "beginning",
  });
  store.subscribe("tenant-b", {
    name: "work",
    pattern: "work.>",
    deliverFrom: "beginning",
  });
  await store.publish("tenant-a", { subject: "work.do", body: "a" });

  expect(await store.claim("tenant-b", "work", "c1", 10)).toHaveLength(0);
  const mine = await store.claim("tenant-a", "work", "c1", 10);
  expect(mine).toHaveLength(1);
  expect(() => store.subscription("tenant-b", "missing")).toThrow(/no subscription/);
  await expect(store.message("tenant-b", mine[0]!.message.seq)).rejects.toThrow(
    /not found/,
  );
  store.close();
});

test("a response is recorded against its correlation", async () => {
  const store = bus();
  const published = await store.publish(W, {
    subject: "rpc.add",
    body: { a: 1 },
    replyTo: "reply",
  });
  expect(published.correlation).toBeTruthy();
  expect(store.response(W, published.correlation!)).toBeNull();
  store.respond(W, published.correlation!, published.seq, { sum: 3 }, {});
  expect(store.response(W, published.correlation!)?.body).toEqual({ sum: 3 });
  store.close();
});

test("stats report lag, depth and dead letters", async () => {
  const store = bus();
  sub(store, "work", "work.>", { maxAttempts: 1 });
  await store.publish(W, { subject: "work.do", body: 1 });
  await store.publish(W, { subject: "other.thing", body: 2 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  store.nack(W, envelope.delivery.id, "c1", envelope.delivery.generation, {
    error: "x",
  });

  const stats = store.stats(W);
  const work = stats.subscriptions.find((s) => s.name === "work")!;
  expect(work.dead).toBe(1);
  expect(stats.messages).toBe(3); // two published, one dead letter
  store.close();
});

test("a body larger than the inline limit goes to the blob store", async () => {
  const blobs = new Map<string, string>();
  const store = new BusStore(":memory:", {
    now,
    inlineMaxBytes: 64,
    blobs: {
      put: async (key, data) => {
        blobs.set(key, data);
        return key;
      },
      get: async (handle) => blobs.get(handle)!,
      has: async (handle) => blobs.has(handle),
      delete: async (handle) => {
        blobs.delete(handle);
      },
    },
  });
  sub(store, "work", "work.>");
  const big = "x".repeat(500);
  await store.publish(W, { subject: "work.do", body: { big } });
  expect(blobs.size).toBe(1);
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  expect(envelope.message.body).toEqual({ big });
  store.close();
});

test("a subscription's pattern is immutable", () => {
  const store = bus();
  sub(store, "work", "work.>");
  expect(() => sub(store, "work", "other.>")).toThrow(/already exists/);
  store.close();
});

test("the idempotency key is stable across redeliveries", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const first = (await store.claim(W, "work", "c1", 1))[0]!;
  clock += 5000;
  const second = (await store.claim(W, "work", "c2", 1))[0]!;
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  store.close();
});

test("a deduplicated request keeps the original correlation", async () => {
  const store = bus();
  const first = await store.publish(W, {
    subject: "rpc.add",
    body: 1,
    replyTo: "reply",
    dedupeKey: "job-1",
  });
  const retry = await store.publish(W, {
    subject: "rpc.add",
    body: 1,
    replyTo: "reply",
    dedupeKey: "job-1",
  });
  expect(retry.duplicate).toBe(true);
  // The retry must wait on the correlation the answer will arrive under.
  expect(retry.correlation).toBe(first.correlation);

  store.respond(W, first.correlation!, first.seq, { sum: 2 }, {});
  expect(store.response(W, retry.correlation!)?.body).toEqual({ sum: 2 });
  store.close();
});

test("retention never deletes a message whose delivery is unfinished", async () => {
  const store = new BusStore(":memory:", { now, retentionMs: 1000 });
  store.subscribe(W, {
    name: "work",
    pattern: "work.>",
    ackWaitMs: 60_000,
    deliverFrom: "beginning",
  });
  await store.publish(W, { subject: "work.do", body: "unhandled" });
  await store.publish(W, { subject: "work.do", body: "in-flight" });

  // Move the cursor past both — examined is not the same as finished.
  const claimed = await store.claim(W, "work", "c1", 1);
  expect(claimed).toHaveLength(1);

  clock += 10_000;
  store.sweep();

  // The leased one is still there for its consumer to ack.
  await store.ack(W, claimed[0]!.delivery.id, "c1", claimed[0]!.delivery.generation);
  // And the one that was never delivered is still waiting.
  const rest = await store.claim(W, "work", "c1", 10);
  expect(rest.map((e) => e.message.body)).toEqual(["in-flight"]);
  store.close();
});

test("retention does collect messages every subscription has settled", async () => {
  const store = new BusStore(":memory:", { now, retentionMs: 1000 });
  store.subscribe(W, {
    name: "work",
    pattern: "work.>",
    ackWaitMs: 60_000,
    deliverFrom: "beginning",
  });
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  await store.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation);

  clock += 10_000;
  store.sweep();
  expect(store.stats(W).messages).toBe(0);
  store.close();
});

test("a ttl does not delete a message a consumer is holding", async () => {
  const store = new BusStore(":memory:", { now, retentionMs: 0 });
  store.subscribe(W, {
    name: "work",
    pattern: "work.>",
    ackWaitMs: 60_000,
    deliverFrom: "beginning",
  });
  await store.publish(W, { subject: "work.do", body: 1, ttlMs: 1000 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;

  clock += 5000;
  store.sweep();
  // The handler is still running; taking its message away would leave it
  // acking a delivery that no longer exists.
  await expect(
    store.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation),
  ).resolves.toBeDefined();
  store.close();
});

test("blobs are collected once no message references them", async () => {
  const blobs = new Map<string, string>();
  const store = new BusStore(":memory:", {
    now,
    inlineMaxBytes: 32,
    retentionMs: 1000,
    blobs: {
      put: async (key, data) => {
        blobs.set(key, data);
        return key;
      },
      get: async (handle) => blobs.get(handle)!,
      has: async (handle) => blobs.has(handle),
      delete: async (handle) => {
        blobs.delete(handle);
      },
    },
  });
  store.subscribe(W, {
    name: "work",
    pattern: "work.>",
    ackWaitMs: 60_000,
    deliverFrom: "beginning",
  });
  await store.publish(W, { subject: "work.do", body: { big: "x".repeat(200) } });
  expect(blobs.size).toBe(1);

  // Still referenced while the message lives.
  expect(await store.collectBlobs()).toBe(0);

  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  await store.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation);
  clock += 10_000;
  store.sweep();

  expect(await store.collectBlobs()).toBe(1);
  expect(blobs.size).toBe(0);
  store.close();
});

test("a ttl collects a message nobody ever consumed", async () => {
  const store = new BusStore(":memory:", { now, retentionMs: 0 });
  store.subscribe(W, {
    name: "work",
    pattern: "work.>",
    deliverFrom: "beginning",
  });
  await store.publish(W, { subject: "work.do", body: 1, ttlMs: 1000 });
  // Materialize the delivery without leasing it, then let the ttl pass.
  await store.claim(W, "work", "c1", 0);
  clock += 5000;
  store.sweep();
  // An expired message that nobody started must not outlive its own ttl just
  // because a delivery row was created for it.
  expect(store.stats(W).messages).toBe(0);
  store.close();
});

test("a match is found across many scan batches, not just the first", async () => {
  // scanBatch is deliberately tiny so the cursor has to walk the log in steps.
  const store = new BusStore(":memory:", { now, scanBatch: 10 });
  store.subscribe(W, {
    name: "rare",
    pattern: "rare.event",
    ackWaitMs: 1000,
    deliverFrom: "beginning",
  });
  for (let index = 0; index < 95; index++)
    await store.publish(W, { subject: "noise.tick", body: index });
  await store.publish(W, { subject: "rare.event", body: "found" });

  let envelopes: Awaited<ReturnType<typeof store.claim>> = [];
  for (let attempt = 0; attempt < 20 && envelopes.length === 0; attempt++)
    envelopes = await store.claim(W, "rare", "c1", 1);

  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.message.body).toBe("found");
  store.close();
});

test("a subscription whose pattern starts with a wildcard still matches", async () => {
  // narrowingGlob gives up and returns '*' here, so this exercises the path
  // where SQL narrows nothing and the token match does all the work.
  const store = bus();
  store.subscribe(W, {
    name: "created",
    pattern: "*.created",
    ackWaitMs: 1000,
    deliverFrom: "beginning",
  });
  await store.publish(W, { subject: "orders.created", body: 1 });
  await store.publish(W, { subject: "orders.eu.created", body: 2 });
  await store.publish(W, { subject: "users.created", body: 3 });

  const envelopes = await store.claim(W, "created", "c1", 10);
  expect(envelopes.map((e) => e.message.body).sort()).toEqual([1, 3]);
  store.close();
});
