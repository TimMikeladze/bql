import { afterAll, expect, test } from "bun:test";
import { createServer } from "../src/bus/server";
import { BusStore } from "../src/bus/store";
import { generateKey, mint } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";

const signingKey = generateKey();
const adminToken = generateKey();
const store = new BusStore(":memory:");
const server = createServer({
  store,
  signingKey,
  adminToken,
  port: 0,
  hostname: "127.0.0.1",
});
const url = `http://127.0.0.1:${server.port}`;

const admin = new BusClient({ url, token: adminToken });
const consumerToken = mint(
  {
    sub: "worker-1",
    scope: "consumer",
    workspace: "default",
    publish: ["results.>"],
    subscribe: ["work"],
    exp: 0,
  },
  signingKey,
);
const worker = new BusClient({ url, token: consumerToken });

afterAll(() => {
  server.stop(true);
  store.close();
});

test("health needs no credential; the API does", async () => {
  expect((await fetch(`${url}/health`)).status).toBe(200);
  expect((await fetch(`${url}/api/stats`)).status).toBe(401);
  const bad = await fetch(`${url}/api/stats`, {
    headers: { Authorization: "Bearer nonsense" },
  });
  expect(bad.status).toBe(401);
});

test("a subscription is created and then consumed end to end", async () => {
  await admin.subscribe({ name: "work", pattern: "work.>", ackWaitMs: 5000 });
  const published = await admin.publish({
    subject: "work.resize",
    body: { src: "a.png" },
  });
  expect(published.seq).toBeGreaterThan(0);

  const envelopes = await worker.claim("work", "worker-1", 1);
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.message.body).toEqual({ src: "a.png" });
  expect(envelopes[0]!.idempotencyKey).toBe(`work:${published.seq}`);

  const acked = await worker.ack(envelopes[0]!.delivery, "worker-1");
  expect(acked.status).toBe("acked");
});

test("a consumer token cannot publish outside its grants or admin the bus", async () => {
  await expect(
    worker.publish({ subject: "work.resize", body: 1 }),
  ).rejects.toThrow(/may not publish/);
  await expect(
    worker.publish({ subject: "results.ok", body: 1 }),
  ).resolves.toBeTruthy();
  await expect(
    worker.subscribe({ name: "other", pattern: "x.>" }),
  ).rejects.toThrow(/admin/);
  await expect(worker.stats()).rejects.toThrow(/read access/);
});

test("a consumer cannot claim a subscription it was not granted", async () => {
  await admin.subscribe({ name: "secret", pattern: "secret.>" });
  await expect(worker.claim("secret", "worker-1", 1)).rejects.toThrow(
    /may not consume/,
  );
});

test("a consumer cannot act as another consumer", async () => {
  await expect(worker.claim("work", "worker-2", 1)).rejects.toThrow(
    /issued for consumer/,
  );
});

test("a claim long-polls and returns as soon as a message arrives", async () => {
  const started = Date.now();
  const pending = worker.claim("work", "worker-1", 1, 5000);
  setTimeout(() => {
    void admin.publish({ subject: "work.late", body: "arrived" });
  }, 150);
  const envelopes = await pending;
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.message.body).toBe("arrived");
  // It waited for the message rather than returning empty immediately, and it
  // did not sit out the whole window either.
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  expect(Date.now() - started).toBeLessThan(4000);
  await worker.ack(envelopes[0]!.delivery, "worker-1");
});

test("request and reply travel through the bus", async () => {
  await admin.subscribe({ name: "rpc", pattern: "rpc.>" });
  const pending = admin.request({
    subject: "rpc.add",
    body: { a: 2, b: 3 },
    waitMs: 5000,
  });

  // A responder is an ordinary consumer that publishes back on the correlation.
  const envelopes = await admin.claim("rpc", "responder", 1, 3000);
  expect(envelopes).toHaveLength(1);
  const { message, delivery } = envelopes[0]!;
  const { a, b } = message.body as { a: number; b: number };
  await admin.reply(message, { sum: a + b });
  await admin.ack(delivery, "responder");

  const result = await pending;
  expect(result.response?.body).toEqual({ sum: 5 });

  // And it is still collectable afterwards, which is what makes it durable.
  const later = await admin.response(result.correlation!);
  expect(later?.body).toEqual({ sum: 5 });
});

test("a request that nobody answers returns 202 with no response", async () => {
  const result = await admin.request({
    subject: "rpc.void",
    body: null,
    waitMs: 100,
  });
  expect(result.response).toBeNull();
  expect(await admin.response(result.correlation!)).toBeNull();
});

test("an unknown workspace is rejected for a pinned token", async () => {
  const pinned = mint(
    {
      sub: "t",
      scope: "consumer",
      workspace: "tenant-a",
      publish: ["x.>"],
      subscribe: [],
      exp: 0,
    },
    signingKey,
  );
  const other = new BusClient({ url, token: pinned, workspace: "tenant-b" });
  await expect(other.publish({ subject: "x.y", body: 1 })).rejects.toThrow(
    /pinned to another workspace/,
  );
});

test("a malformed subject is a 400, not a 500", async () => {
  await expect(admin.publish({ subject: "bad..subject", body: 1 })).rejects.toThrow(
    /invalid subject token|subject/,
  );
  await expect(admin.publish({ subject: "with.*.wildcard", body: 1 })).rejects.toThrow(
    /wildcard/,
  );
});

test("the admin can read stats, the log and mint scoped tokens", async () => {
  const stats = await admin.stats();
  expect(stats.subscriptions.map((s) => s.name)).toContain("work");
  expect(stats.lastSeq).toBeGreaterThan(0);

  const log = await admin.log(0, 5);
  expect(log.length).toBeGreaterThan(0);
  expect(log[0]!.subject).toBeTruthy();

  const minted = (await admin.call("/api/tokens", {
    consumer: "fresh-1",
    publish: ["a.>"],
    subscribe: ["work"],
  })) as { token: string };
  const fresh = new BusClient({ url, token: minted.token });
  await expect(fresh.publish({ subject: "a.b", body: 1 })).resolves.toBeTruthy();
  await expect(fresh.publish({ subject: "b.c", body: 1 })).rejects.toThrow();
});
