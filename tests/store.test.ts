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
  expect(() =>
    store.ack(W, stale.delivery.id, "c1", stale.delivery.generation),
  ).toThrow(/stale lease/);
  store.close();
});

test("an acked delivery is not redelivered", async () => {
  const store = bus();
  sub(store, "work", "work.>");
  await store.publish(W, { subject: "work.do", body: 1 });
  const envelope = (await store.claim(W, "work", "c1", 1))[0]!;
  store.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation);
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

  store.ack(W, batch[0]!.delivery.id, "c1", batch[0]!.delivery.generation);
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
  store.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation);

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
