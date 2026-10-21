/**
 * The bus on a bql.sh database: ack levels, the replica pre-check, Tier 1, and
 * waiting out a snapshot that holds the writer. These open their own engine
 * with a database named `bus`, the way `bql bus serve` does.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Bql } from "../../db/src/embedded.ts";
import { createBus } from "../src/bus/embedded";
import { createServer } from "../src/bus/server";
import { ensureBusDatabase } from "../src/bus/storage";
import { BusError } from "../src/bus/store";
import { generateKey } from "../src/bus/tokens";
import { BusClient, BusRequestError } from "../src/client/bus";

const W = "default";
const dir = await mkdtemp(`${tmpdir()}/bql-bus-storage-`);
const bq = await Bql.open({ dir });
await ensureBusDatabase(bq);
const bus = createBus({ bql: bq });
bus.store.subscribe(W, { name: "work", pattern: "work.>", deliverFrom: "beginning" });

const adminToken = generateKey();
const server = createServer({
  store: bus.store,
  signingKey: generateKey(),
  adminToken,
  port: 0,
  hostname: "127.0.0.1",
});
// A short failoverMs: with no replica anywhere, NO_REPLICAS is retried until it runs out.
const admin = new BusClient({
  url: `http://127.0.0.1:${server.port}`,
  token: adminToken,
  failoverMs: 300,
});

afterAll(async () => {
  server.stop(true);
  bus.close();
  await bq.close();
  await rm(dir, { recursive: true, force: true });
});

test("the store is on bql.sh database bus, with foreign keys on", () => {
  expect(bq.list().map((row) => row.name)).toContain("bus");
  expect(bq.runtime.registry.catalog.getTenant("bus")?.foreignKeys).toBe(true);
});

test("a publish at ack fsync answers the txid it committed in", async () => {
  const before = bq.db("bus").txid;
  const published = await bus.client.publish({ subject: "work.a", body: 1, ack: "fsync" });
  expect(published.txid).toBeGreaterThan(before);
  expect(published.txid).toBe(bq.db("bus").txid);

  const http = await admin.publish({ subject: "work.b", body: 2, ack: "fsync" });
  expect(http.txid).toBe(bq.db("bus").txid);
  const batch = await admin.publishBatch(
    [{ subject: "work.c" }, { subject: "work.d" }],
    { ack: "local" },
  );
  // One transaction, one txid.
  expect(batch.map((one) => one.txid)).toEqual([http.txid! + 1, http.txid! + 1]);
});

test("ack replica with no replica attached is NO_REPLICAS and writes nothing", async () => {
  const seq = bus.store.lastSeq();
  const txid = bq.db("bus").txid;
  const refused = await bus.client
    .publish({ subject: "work.r", body: 1, ack: "replica" })
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(BusError);
  expect((refused as BusError).status).toBe(503);
  expect((refused as BusError).details.code).toBe("NO_REPLICAS");

  const http = await admin
    .publish({ subject: "work.r", body: 1, ack: "quorum" })
    .catch((error: unknown) => error);
  expect(http).toBeInstanceOf(BusRequestError);
  expect((http as BusRequestError).status).toBe(503);
  expect((http as BusRequestError).code).toBe("NO_REPLICAS");

  expect(bus.store.lastSeq()).toBe(seq);
  expect(bq.db("bus").txid).toBe(txid);
});

test("an unknown ack level is a 400", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subject: "work.x", ack: "eventually" }),
  });
  expect(response.status).toBe(400);
});

test("Tier 1 on bql.sh: the handler's rows and the ack commit together", async () => {
  bus.store.raw().run("CREATE TABLE IF NOT EXISTS processed (seq INTEGER PRIMARY KEY)");
  bus.store.subscribe(W, {
    name: "tier1",
    pattern: "tier1.>",
    deliverFrom: "beginning",
    backoff: { baseMs: 0 },
  });
  const ok = await bus.client.publish({ subject: "tier1.ok", body: 1 });
  const bad = await bus.client.publish({ subject: "tier1.bad", body: 2 });
  const failures: unknown[] = [];
  const loop = bus.consumeTransactional({
    subscription: "tier1",
    waitMs: 5,
    handle: (envelope, db) => {
      db.run("INSERT INTO processed (seq) VALUES (?)", [envelope.message.seq]);
      if (envelope.message.seq === bad.seq) throw new Error("handler failed after writing");
    },
    onError: (error) => failures.push(error),
  });
  const deadline = Date.now() + 3000;
  while (failures.length === 0 && Date.now() < deadline) await Bun.sleep(10);
  await loop.stop();

  const rows = bus.store
    .raw()
    .query("SELECT seq FROM processed ORDER BY seq")
    .all() as { seq: number }[];
  // The failed handler's row rolled back with its ack; the good one has both.
  expect(rows.map((row) => row.seq)).toContain(ok.seq);
  expect(rows.map((row) => row.seq)).not.toContain(bad.seq);
  const statuses = bus.store
    .deliveries(W)
    .filter((delivery) => delivery.subscription === "tier1")
    .map((delivery) => [delivery.messageSeq, delivery.status]);
  expect(statuses).toContainEqual([ok.seq, "acked"]);
  expect(statuses).not.toContainEqual([bad.seq, "acked"]);
});

test("a write refused while a snapshot holds the writer is retried, not failed", async () => {
  const snapshot = bq.snapshot("bus");
  // The synchronous surface refuses outright...
  expect(() => bus.store.raw().run("CREATE TABLE IF NOT EXISTS t (x)")).toThrow(/snapshot/);
  // ...while publish, and an HTTP request, wait for the writer.
  const [direct, http] = await Promise.all([
    bus.client.publish({ subject: "work.s", body: 1 }),
    admin.publish({ subject: "work.s", body: 2 }),
  ]);
  await snapshot;
  expect(http.seq).toBeGreaterThan(0);
  expect(direct.seq).toBeGreaterThan(0);
});

test("an HTTP write refused with TX_BUSY runs again once the writer is free", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // An interactive transaction holds bql.sh's only writer across awaits.
  const holder = bq.db("bus").transaction(async () => {
    await held;
  });
  expect(() => bus.store.raw().run("CREATE TABLE IF NOT EXISTS t2 (x)")).toThrow(/open transaction/);
  // A synchronous route: the server, not the store, does the waiting.
  const subscribed = admin.subscribe({ name: "late", pattern: "late.>" });
  const published = admin.publish({ subject: "late.a", body: 1 });
  await Bun.sleep(100);
  release();
  await holder;
  expect((await subscribed).name).toBe("late");
  expect((await published).seq).toBeGreaterThan(0);
});
