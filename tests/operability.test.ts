import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "bun:test";
import { createLogger } from "../src/bus/log";
import { prometheusMetrics } from "../src/bus/metrics";
import { createServer } from "../src/bus/server";
import { BusStore } from "../src/bus/store";
import { generateKey, mint } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";

const scratch = await mkdtemp(`${tmpdir()}/agenticbus-ops-`);
afterAll(() => rm(scratch, { recursive: true, force: true }));

// ------------------------------------------------------------------ logging

test("the logger filters by level and renders both formats", () => {
  const lines: string[] = [];
  const text = createLogger({
    level: "warn",
    write: (line) => lines.push(line),
    now: () => 0,
  });
  text.debug("nope");
  text.info("also nope");
  text.warn("lease lost", { consumer: "worker-1", attempt: 3 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("warn");
  expect(lines[0]).toContain("lease lost consumer=worker-1 attempt=3");

  const json: string[] = [];
  createLogger({
    format: "json",
    write: (line) => json.push(line),
    now: () => 0,
  })
    .child({ component: "bus" })
    .error("boom", { code: 500 });
  expect(JSON.parse(json[0]!)).toEqual({
    time: "1970-01-01T00:00:00.000Z",
    level: "error",
    message: "boom",
    component: "bus",
    code: 500,
  });
});

// ------------------------------------------------------------------ metrics

test("metrics counters and gauges reach the scrape, and it needs a read token", async () => {
  const metrics = prometheusMetrics();
  const store = new BusStore(":memory:", { metrics });
  const signingKey = generateKey();
  const adminToken = generateKey();
  const server = createServer({
    store,
    signingKey,
    adminToken,
    metrics,
    port: 0,
    hostname: "127.0.0.1",
  });
  const url = `http://127.0.0.1:${server.port}`;
  const admin = new BusClient({ url, token: adminToken });

  await admin.subscribe({ name: "work", pattern: "work.>", ackWaitMs: 5000 });
  await admin.publish({ subject: "work.a", body: 1 });
  await admin.publish({ subject: "work.b", body: 2 });
  const [envelope] = await admin.claim("work", "worker-1", 1);
  await admin.ack(envelope!.delivery, "worker-1");

  const scrape = await fetch(`${url}/metrics`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(scrape.status).toBe(200);
  const body = await scrape.text();

  expect(body).toContain("agenticbus_messages_published 2");
  expect(body).toContain('agenticbus_deliveries_acked{subscription="work"} 1');
  expect(body).toContain("# TYPE agenticbus_claim_duration summary");
  // Depth is read at scrape time, not written when something moves: one
  // message was acked, so the other is still pending.
  expect(body).toContain(
    'agenticbus_subscription_deliveries{status="pending",subscription="work",workspace="default"} 1',
  );

  // A consumer token can claim but must not read the shape of the install.
  const consumer = mint(
    {
      sub: "worker-1",
      scope: "consumer",
      workspace: "default",
      publish: [],
      subscribe: ["work"],
      exp: 0,
    },
    signingKey,
  );
  expect(
    (await fetch(`${url}/metrics`, { headers: { Authorization: `Bearer ${consumer}` } }))
      .status,
  ).toBe(403);
  expect((await fetch(`${url}/metrics`)).status).toBe(401);

  server.stop(true);
  store.close();
});

// ----------------------------------------------------------------- shutdown

test("shutdown drains parked long polls instead of cutting them off", async () => {
  const store = new BusStore(":memory:");
  const adminToken = generateKey();
  const server = createServer({
    store,
    signingKey: generateKey(),
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
  });
  const url = `http://127.0.0.1:${server.port}`;
  const admin = new BusClient({ url, token: adminToken });
  await admin.subscribe({ name: "quiet", pattern: "quiet.>" });

  // Parked for ten seconds on a subscription with nothing on it.
  const parked = admin.claim("quiet", "worker-1", 1, 10_000);
  await Bun.sleep(150);
  expect((await (await fetch(`${url}/ready`)).json()).ok).toBe(false);

  const started = Date.now();
  await server.shutdown({ timeoutMs: 5000 });
  const elapsed = Date.now() - started;

  // The poll returned an ordinary empty claim rather than a connection error,
  // and it did not wait out its remaining nine seconds.
  expect(await parked).toEqual([]);
  expect(elapsed).toBeLessThan(3000);
  expect(server.draining).toBe(true);

  // Only now is it safe to close the store: the request that was still using
  // it has returned.
  store.close();
});

// ------------------------------------------------------------------- backup

test("a backup is a consistent copy that opens on its own", async () => {
  const path = `${scratch}/live.db`;
  const store = new BusStore(path);
  store.subscribe("default", { name: "work", pattern: "work.>" });
  const first = await store.publish("default", { subject: "work.a", body: 1 });

  const into = `${scratch}/backup/bus.db`;
  await Bun.write(`${scratch}/backup/.keep`, "");
  store.backup(into);

  // The live database keeps taking writes after the backup is taken.
  const second = await store.publish("default", { subject: "work.b", body: 2 });
  expect(second.seq).toBeGreaterThan(first.seq);

  const restored = new BusStore(into);
  const log = await restored.log("default");
  expect(log.map((message) => message.subject)).toEqual(["work.a"]);
  // And it is a real database, not a file: the subscription still works.
  const claimed = await restored.claim("default", "work", "worker-1", 5);
  expect(claimed).toHaveLength(1);
  restored.close();
  store.close();
});

test("shutdown ends an open SSE stream instead of waiting for it forever", async () => {
  const store = new BusStore(":memory:");
  const adminToken = generateKey();
  const server = createServer({
    store,
    signingKey: generateKey(),
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
  });
  const url = `http://127.0.0.1:${server.port}`;

  // An SSE response never completes on its own, so `server.stop(false)` — which
  // waits for in-flight requests — used to wait for it forever. One open
  // dashboard turned SIGTERM into a hang.
  const stream = await fetch(`${url}/api/stream?token=${adminToken}`);
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  await reader.read(); // the first tick, so the stream is genuinely established

  const started = Date.now();
  await server.shutdown({ timeoutMs: 3000 });
  expect(Date.now() - started).toBeLessThan(3000);

  // The client side sees the stream end rather than hanging.
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  store.close();
});

test("shutdown is idempotent, and still drains after a bare stop()", async () => {
  const store = new BusStore(":memory:");
  const server = createServer({
    store,
    signingKey: generateKey(),
    adminToken: generateKey(),
    port: 0,
    hostname: "127.0.0.1",
  });
  server.stop();
  // `draining` alone is not evidence that anything was awaited, so this must
  // still do the work rather than return immediately on the flag.
  await server.shutdown({ timeoutMs: 1000 });
  await server.shutdown({ timeoutMs: 1000 });
  expect(server.draining).toBe(true);
  store.close();
});
