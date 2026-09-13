import { afterAll, expect, test } from "bun:test";
import { createServer } from "../src/bus/server";
import { BusStore } from "../src/bus/store";
import { generateKey } from "../src/bus/tokens";
import { BusClient, BusConsumer, FatalError } from "../src/client/bus";

const adminToken = generateKey();
const store = new BusStore(":memory:");
const server = createServer({
  store,
  signingKey: generateKey(),
  adminToken,
  port: 0,
  hostname: "127.0.0.1",
});
const client = new BusClient({
  url: `http://127.0.0.1:${server.port}`,
  token: adminToken,
});

afterAll(() => {
  server.stop(true);
  store.close();
});

async function drain(consumer: BusConsumer, ms: number) {
  const running = consumer.start();
  await Bun.sleep(ms);
  consumer.stop();
  await running;
}

test("a handler that hangs is aborted and its message redelivered", async () => {
  await client.subscribe({
    name: "hang",
    pattern: "hang.>",
    ackWaitMs: 5000,
    maxAttempts: 2,
  });
  await client.publish({ subject: "hang.forever", body: 1 });

  let started = 0;
  const consumer = new BusConsumer({
    client,
    id: "hanger",
    subscription: "hang",
    handlerTimeoutMs: 300,
    waitMs: 200,
    async handle(_envelope, api) {
      started++;
      // Never resolves on its own; only the timeout ends it.
      await new Promise((_, reject) =>
        api.signal.addEventListener("abort", () => reject(api.signal.reason)),
      );
    },
  });
  await drain(consumer, 2500);

  // Attempt one timed out, and the message came back for attempt two rather
  // than being held forever by a lease this consumer kept renewing.
  expect(started).toBeGreaterThanOrEqual(2);
  const stats = await client.stats();
  const hang = stats.subscriptions.find((s) => s.name === "hang")!;
  expect(hang.dead).toBe(1);
});

test("a handler that returns acks, and a FatalError dead-letters at once", async () => {
  await client.subscribe({
    name: "mixed",
    pattern: "mixed.>",
    ackWaitMs: 5000,
    maxAttempts: 5,
  });
  await client.publish({ subject: "mixed.good", body: "ok" });
  await client.publish({ subject: "mixed.bad", body: "no" });

  const seen: string[] = [];
  const consumer = new BusConsumer({
    client,
    id: "mixer",
    subscription: "mixed",
    prefetch: 2,
    waitMs: 200,
    async handle({ message }) {
      seen.push(message.subject);
      if (message.subject.endsWith("bad")) throw new FatalError("never works");
    },
  });
  await drain(consumer, 1500);

  const stats = await client.stats();
  const mixed = stats.subscriptions.find((s) => s.name === "mixed")!;
  // One acked, one dead on its first attempt rather than after five.
  expect(mixed.dead).toBe(1);
  expect(mixed.pending).toBe(0);
  expect(seen.filter((s) => s.endsWith("bad"))).toHaveLength(1);
});
