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
const worker = new BusClient({
  url,
  token: mint(
    {
      sub: "worker-1",
      scope: "consumer",
      workspace: "default",
      publish: ["work.>"],
      subscribe: ["work"],
      exp: 0,
    },
    signingKey,
  ),
});

afterAll(() => {
  server.stop(true);
  store.close();
});

test("a dead letter can be listed and requeued onto the subject it failed on", async () => {
  await admin.subscribe({
    name: "work",
    pattern: "work.>",
    ackWaitMs: 30_000,
    maxAttempts: 1,
  });
  const published = await admin.publish({
    subject: "work.resize",
    key: "a.png",
    body: { src: "a.png" },
    headers: { tenant: "acme" },
  });

  const [envelope] = await worker.claim("work", "worker-1", 1);
  await worker.nack(envelope!.delivery, "worker-1", {
    error: "the encoder is not installed",
    fatal: true,
  });

  const dead = await admin.deadLetters("work");
  expect(dead).toHaveLength(1);
  expect(dead[0]!.subject).toBe("dlq.work");
  expect(dead[0]!.headers["dlq-subject"]).toBe("work.resize");
  expect(dead[0]!.headers["dlq-reason"]).toContain("encoder");

  const requeued = await admin.requeue(dead[0]!.seq);
  expect(requeued.seq).toBeGreaterThan(dead[0]!.seq);

  const republished = await admin.message(requeued.seq);
  expect(republished.subject).toBe("work.resize");
  expect(republished.key).toBe("a.png");
  expect(republished.body).toEqual({ src: "a.png" });
  // The failure headers come off, the caller's own headers stay, and the trail
  // back to the dead letter is recorded.
  expect(republished.headers["dlq-reason"]).toBeUndefined();
  expect(republished.headers["dlq-subject"]).toBeUndefined();
  expect(republished.headers.tenant).toBe("acme");
  expect(republished.headers["requeued-from"]).toBe(String(dead[0]!.seq));

  // It is an ordinary new message, so the subscription picks it up again.
  const [again] = await worker.claim("work", "worker-1", 1);
  expect(again!.message.seq).toBe(requeued.seq);
  await worker.ack(again!.delivery, "worker-1");
  expect(published.seq).toBeLessThan(requeued.seq);
});

test("requeueing something that is not a dead letter is refused", async () => {
  const ordinary = await admin.publish({ subject: "work.plain", body: 1 });
  await expect(admin.requeue(ordinary.seq)).rejects.toThrow(/not a dead letter/);
});

test("requeue is an operator action, not a consumer's", async () => {
  const dead = await admin.deadLetters("work");
  await expect(worker.requeue(dead[0]!.seq)).rejects.toMatchObject({
    status: 403,
  });
});

test("the log's subject filter uses subject semantics, not glob semantics", async () => {
  await admin.publish({ subject: "orders.eu.created", body: 1 });
  await admin.publish({ subject: "orders.eu.west.created", body: 2 });

  const oneToken = await admin.log(0, 50, { subject: "orders.*.created" });
  expect(oneToken.map((m) => m.subject)).toEqual(["orders.eu.created"]);

  const rest = await admin.log(0, 50, { subject: "orders.>" });
  expect(rest.map((m) => m.subject).sort()).toEqual([
    "orders.eu.created",
    "orders.eu.west.created",
  ]);

  const newest = await admin.log(0, 1, { subject: "orders.>", newest: true });
  expect(newest[0]!.subject).toBe("orders.eu.west.created");
});

test("a paused subscription hands out nothing until it is resumed", async () => {
  await admin.pause("work", true);
  await admin.publish({ subject: "work.paused", body: 1 });
  expect(await worker.claim("work", "worker-1", 5)).toHaveLength(0);

  await admin.pause("work", false);
  const claimed = await worker.claim("work", "worker-1", 5);
  expect(claimed.length).toBeGreaterThan(0);
  for (const envelope of claimed) await worker.ack(envelope.delivery, "worker-1");
});

test("a filtered page is filled even when the glob over-matches most of the log", async () => {
  // A hundred messages the SQL glob accepts and the pattern rejects, then ten
  // real matches behind them. A single bounded read — the obvious
  // implementation — returns an empty page here and looks like "no matches".
  for (let index = 0; index < 100; index++)
    await admin.publish({ subject: "eu.west.created", body: index });
  for (let index = 0; index < 10; index++)
    await admin.publish({ subject: "eu.created", body: index });

  // `eu.*` narrows to the SQL glob `eu.*`, which accepts both — but `*` is
  // exactly one token, so only the two-token subject really matches.
  const page = await admin.log(0, 5, { subject: "eu.*" });
  expect(page).toHaveLength(5);
  expect(new Set(page.map((m) => m.subject))).toEqual(new Set(["eu.created"]));

  const newest = await admin.log(0, 3, { subject: "eu.*", newest: true });
  expect(newest).toHaveLength(3);
  expect(newest[0]!.seq).toBeGreaterThan(newest[2]!.seq);
  expect(new Set(newest.map((m) => m.subject))).toEqual(new Set(["eu.created"]));
});
