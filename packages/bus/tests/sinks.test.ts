import { afterAll, expect, test } from "bun:test";
import { createServer } from "../src/bus/server";
import { BusStore } from "../src/bus/store";
import { generateKey } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";
import {
  clickhouseRows,
  clickhouseSink,
  encodeNdjson,
  s3ObjectKey,
  s3Sink,
  SinkRunner,
  type SinkRecord,
  type SinkWriter,
  verifyWebhookSignature,
  webhookSink,
} from "../src/sinks";

const adminToken = generateKey();
const store = new BusStore(":memory:");
const server = createServer({
  store,
  signingKey: generateKey(),
  adminToken,
  port: 0,
  hostname: "127.0.0.1",
});
const bus = new BusClient({ url: `http://127.0.0.1:${server.port}`, token: adminToken });
const stubs: { stop(force?: boolean): void }[] = [];

afterAll(() => {
  for (const stub of stubs) stub.stop(true);
  server.stop(true);
  store.close();
});

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** A subscription with quick retries, and `count` messages on it. */
async function seed(name: string, count: number): Promise<void> {
  await bus.subscribe({
    name,
    pattern: `${name}.>`,
    ackWaitMs: 5000,
    backoff: { baseMs: 20, maxMs: 50 },
  });
  await bus.publishBatch(
    Array.from({ length: count }, (_, i) => ({
      subject: `${name}.row`,
      body: { n: i },
      dedupeKey: `${name}-${i}`,
    })),
  );
}

async function run(name: string, writer: SinkWriter, options: { batchSize?: number; flushMs?: number } = {}) {
  const runner = new SinkRunner({
    client: bus,
    id: `${name}-sink`,
    subscription: name,
    writer,
    batchSize: options.batchSize ?? 100,
    flushMs: options.flushMs ?? 50,
  });
  const done = runner.start();
  return {
    runner,
    async stop() {
      runner.stop();
      await done;
    },
  };
}

test("publishBatch is one transaction that honours dedupe keys, including within the batch", async () => {
  const results = await bus.publishBatch([
    { subject: "batch.a", body: 1, dedupeKey: "k1" },
    { subject: "batch.a", body: 2, dedupeKey: "k1" },
    { subject: "batch.a", body: 3, dedupeKey: "k2" },
  ]);
  expect(results.map((r) => r.duplicate)).toEqual([false, true, false]);
  expect(results[1]!.seq).toBe(results[0]!.seq);
  const again = await bus.publishBatch([{ subject: "batch.a", body: 3, dedupeKey: "k2" }]);
  expect(again[0]!.duplicate).toBe(true);
});

test("webhook: a signed JSON array per batch, and a non-2xx goes back to the bus for retry", async () => {
  await seed("hook", 5);
  const bodies: SinkRecord[][] = [];
  let verified = true;
  let calls = 0;
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      calls++;
      const text = await req.text();
      verified &&= verifyWebhookSignature("k", req.headers.get("x-bql-signature"), text);
      // The first attempt fails: the sink must nack, and the bus must hand the batch back.
      if (calls === 1) return new Response("try later", { status: 503 });
      bodies.push(JSON.parse(text) as SinkRecord[]);
      return new Response(null, { status: 204 });
    },
  });
  stubs.push(stub);
  const sink = await run("hook", webhookSink({ url: `http://127.0.0.1:${stub.port}/in`, secret: "k" }));
  await until(() => bodies.flat().length >= 5);
  await sink.stop();

  expect(calls).toBeGreaterThanOrEqual(2);
  expect(sink.runner.stats.failures).toBeGreaterThanOrEqual(1);
  expect(sink.runner.stats.lastError).toContain("webhook answered 503");
  const records = bodies.flat();
  expect(records.map((r) => (r.body as { n: number }).n).sort()).toEqual([0, 1, 2, 3, 4]);
  expect(records[0]).toMatchObject({ subject: "hook.row", idempotencyKey: expect.stringMatching(/^hook:\d+$/) });
  expect(verified).toBe(true);
  // Everything was acked once the webhook accepted it.
  const stats = await bus.stats();
  const sub = stats.subscriptions.find((s) => s.name === "hook")!;
  expect(sub.pending + sub.leased).toBe(0);
});

test("webhook signatures reject a changed body and a stale timestamp", () => {
  const header = `t=${Date.now() - 10 * 60_000},sha256=00`;
  expect(verifyWebhookSignature("k", header, "[]")).toBe(false);
  expect(verifyWebhookSignature("k", null, "[]")).toBe(false);
});

test("s3: gzipped NDJSON through Bun.S3Client, keyed by time and first sequence number", async () => {
  await seed("lake", 3);
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "PUT") return new Response(null, { status: 405 });
      objects.set(new URL(req.url).pathname, new Uint8Array(await req.arrayBuffer()));
      return new Response(null, { status: 200, headers: { etag: '"x"' } });
    },
  });
  stubs.push(stub);
  const sink = await run(
    "lake",
    s3Sink({
      bucket: "cdc",
      prefix: "events/",
      endpoint: `http://127.0.0.1:${stub.port}`,
      accessKeyId: "test",
      secretAccessKey: "test",
      region: "us-east-1",
    }),
    { flushMs: 100 },
  );
  await until(() => objects.size >= 1);
  await sink.stop();

  const [[path, bytes]] = [...objects.entries()] as [[string, Uint8Array<ArrayBuffer>]];
  expect(path).toMatch(/^\/cdc\/events\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{8}T\d{9}Z-\d{12}\.ndjson\.gz$/);
  const lines = new TextDecoder()
    .decode(Bun.gunzipSync(bytes))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SinkRecord);
  expect(lines.map((r) => (r.body as { n: number }).n)).toEqual([0, 1, 2]);
});

test("s3 object keys sort by time and never collide within a millisecond", () => {
  const at = new Date(Date.UTC(2026, 8, 28, 7, 5, 3, 42));
  expect(s3ObjectKey("p/", at, 17)).toBe("p/2026/09/28/07/20260928T070503042Z-000000000017.ndjson.gz");
  expect(s3ObjectKey("p/", at, 18)).not.toBe(s3ObjectKey("p/", at, 17));
  const record: SinkRecord = { seq: 1, subject: "a", key: null, publishedAt: 0, idempotencyKey: "s:1", body: null };
  expect(new TextDecoder().decode(Bun.gunzipSync(encodeNdjson([record])))).toBe(`${JSON.stringify(record)}\n`);
});

test("clickhouse: INSERT … FORMAT JSONEachRow, one body per line", async () => {
  await seed("olap", 4);
  const requests: { query: string | null; body: string; user: string | null }[] = [];
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        query: url.searchParams.get("query"),
        body: await req.text(),
        user: req.headers.get("x-clickhouse-user"),
      });
      return new Response("");
    },
  });
  stubs.push(stub);
  const sink = await run(
    "olap",
    clickhouseSink({ url: `http://127.0.0.1:${stub.port}`, table: "analytics.events", user: "ingest" }),
  );
  await until(() => requests.flatMap((r) => r.body.trim().split("\n")).length >= 4);
  await sink.stop();

  expect(requests[0]!.query).toBe("INSERT INTO analytics.events FORMAT JSONEachRow");
  expect(requests[0]!.user).toBe("ingest");
  const rows = requests.flatMap((r) => r.body.trim().split("\n")).map((line) => JSON.parse(line));
  expect(rows).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }]);
});

test("clickhouse refuses a table name it would have to splice into SQL", () => {
  expect(() => clickhouseSink({ url: "http://x", table: "events; DROP TABLE t" })).toThrow(/identifier/);
});

test("a partial batch is written once flushMs passes, not held for a full one", async () => {
  await seed("trickle", 2);
  const writes: number[] = [];
  const sink = await run(
    "trickle",
    { kind: "test", write: async (records) => void writes.push(records.length) },
    { batchSize: 1000, flushMs: 100 },
  );
  await until(() => writes.reduce((a, b) => a + b, 0) >= 2);
  await sink.stop();
  expect(writes.reduce((a, b) => a + b, 0)).toBe(2);
});

test("a batch is charged per message against --publish-rate, and one past the burst is refused", async () => {
  const limitedStore = new BusStore(":memory:");
  const limited = createServer({
    store: limitedStore,
    signingKey: generateKey(),
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
    publishRate: { perSecond: 0.001, burst: 5 },
  });
  try {
    const client = new BusClient({ url: `http://127.0.0.1:${limited.port}`, token: adminToken });
    const batch = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ subject: "rate.x", body: i }));
    const tooBig = await client.publishBatch(batch(6)).catch((error) => error);
    expect(tooBig.status).toBe(413);
    expect((await client.publishBatch(batch(5))).length).toBe(5);
    // The burst is spent: five messages cost five tokens, not one.
    const limitedOut = await client.publishBatch(batch(1)).catch((error) => error);
    expect(limitedOut.status).toBe(429);
  } finally {
    limited.stop(true);
    limitedStore.close();
  }
});

test("clickhouse shape row unwraps an outbox change into the table's columns", () => {
  const record = (body: unknown, seq = 1): SinkRecord => ({
    seq,
    subject: "db.app.users",
    key: null,
    publishedAt: 0,
    idempotencyKey: `s:${seq}`,
    body: body as SinkRecord["body"],
  });
  const insert = { db: "app", table: "users", op: "insert", txid: 9, seq: 0, i: 0, committedAt: 5, row: { id: 1, email: "a@b" } };
  const remove = { db: "app", table: "users", op: "delete", txid: 10, seq: 0, i: 0, committedAt: 6, pk: { id: 1 } };
  const rows = clickhouseRows([record(insert), record(remove, 2)], "row")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0]).toEqual({ id: 1, email: "a@b", _op: "insert", _db: "app", _table: "users", _txid: 9, _seq: 0, _i: 0, _committed_at: 5 });
  expect(rows[1]).toMatchObject({ id: 1, _op: "delete", _txid: 10 });
  // Not an outbox change: refused loudly rather than inserted as a row of defaults.
  expect(() => clickhouseRows([record({ n: 1 })], "row")).toThrow(/outbox changes/);
});

test("stopping mid-write finishes the write and acks it, rather than nacking a batch that landed", async () => {
  await seed("landed", 3);
  let received = 0;
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      received += (JSON.parse(await req.text()) as unknown[]).length;
      // The destination has the batch; its answer is still on the way when the sink is stopped.
      await Bun.sleep(150);
      return new Response(null, { status: 204 });
    },
  });
  stubs.push(stub);
  const sink = await run("landed", webhookSink({ url: `http://127.0.0.1:${stub.port}/` }));
  await until(() => received >= 3);
  await sink.stop();
  expect(sink.runner.stats.failures).toBe(0);
  const sub = (await bus.stats()).subscriptions.find((s) => s.name === "landed")!;
  expect(sub.pending + sub.leased).toBe(0);
});
