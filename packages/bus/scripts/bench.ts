/**
 * Publish, claim and ack throughput on a single-node bus, at `ack: "fsync"`
 * (the default) and `ack: "local"`, in one process.
 *
 *   bun scripts/bench.ts                       # 4 rounds, 2000 messages in-process, 1000 over HTTP
 *   bun scripts/bench.ts --rounds 6 --messages 5000 --http-messages 2000
 *
 * Each round runs both ack levels once, alternating which goes first, on a
 * fresh data directory. A round publishes N messages one at a time, then
 * claims them 100 at a time and acks each one on its own. Reported numbers
 * are medians over rounds. Check `uptime` first: the bench machine is never
 * quiet.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { Bql } from "../../db/src/embedded.ts";
import { createServer } from "../src/bus/server";
import { bqlStorage, ensureBusDatabase } from "../src/bus/storage";
import { BusStore } from "../src/bus/store";
import { generateKey } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";
import { emit } from "../../db/bench/report.ts";

const argv = process.argv.slice(2);
const num = (name: string, fallback: number) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(argv[at + 1]);
};
const rounds = num("rounds", 4);
const messages = num("messages", 2000);
const httpMessages = num("http-messages", 1000);
const W = "default";

type Kind = "fsync" | "local";
interface Rates {
  publish: number;
  claim: number;
  ack: number;
}

async function open(kind: Kind, dir: string) {
  const bq = await Bql.open({ dir });
  await ensureBusDatabase(bq);
  const store = new BusStore(bqlStorage(bq, { ack: kind }));
  return {
    store,
    close: async () => {
      store.close();
      await bq.close();
    },
  };
}

const perSecond = (count: number, ms: number) => Math.round((count * 1000) / ms);

async function inProcess(kind: Kind): Promise<Rates> {
  const dir = await mkdtemp(`${tmpdir()}/bql-bus-bench-`);
  const { store, close } = await open(kind, dir);
  try {
    store.subscribe(W, { name: "work", pattern: "work.>", deliverFrom: "beginning" });
    let at = performance.now();
    for (let i = 0; i < messages; i++)
      await store.publish(W, { subject: "work.do", body: { i } });
    const publish = perSecond(messages, performance.now() - at);
    let claimMs = 0;
    let ackMs = 0;
    let done = 0;
    while (done < messages) {
      at = performance.now();
      const batch = await store.claim(W, "work", "bench", 100);
      claimMs += performance.now() - at;
      if (batch.length === 0) throw new Error(`ran dry at ${done}`);
      at = performance.now();
      for (const envelope of batch)
        await store.ack(W, envelope.delivery.id, "bench", envelope.delivery.generation);
      ackMs += performance.now() - at;
      done += batch.length;
    }
    return { publish, claim: perSecond(done, claimMs), ack: perSecond(done, ackMs) };
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function overHttp(kind: Kind): Promise<Rates> {
  const dir = await mkdtemp(`${tmpdir()}/bql-bus-bench-`);
  const { store, close } = await open(kind, dir);
  const adminToken = generateKey();
  const server = createServer({
    store,
    signingKey: generateKey(),
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
  });
  const client = new BusClient({ url: `http://127.0.0.1:${server.port}`, token: adminToken });
  try {
    await client.subscribe({ name: "work", pattern: "work.>", deliverFrom: "beginning" });
    let at = performance.now();
    for (let i = 0; i < httpMessages; i++)
      await client.publish({ subject: "work.do", body: { i } });
    const publish = perSecond(httpMessages, performance.now() - at);
    let claimMs = 0;
    let ackMs = 0;
    let done = 0;
    while (done < httpMessages) {
      at = performance.now();
      const batch = await client.claim("work", "bench", 100, 0);
      claimMs += performance.now() - at;
      if (batch.length === 0) throw new Error(`ran dry at ${done}`);
      at = performance.now();
      for (const envelope of batch) await client.ack(envelope.delivery, "bench");
      ackMs += performance.now() - at;
      done += batch.length;
    }
    return { publish, claim: perSecond(done, claimMs), ack: perSecond(done, ackMs) };
  } finally {
    server.stop(true);
    await close();
    await rm(dir, { recursive: true, force: true });
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

console.log(
  `load ${loadavg().map((n) => n.toFixed(2)).join(" ")}, ${rounds} rounds, ${messages} in-process, ${httpMessages} over HTTP`,
);
const results: Record<string, Rates[]> = {};
for (let round = 0; round < rounds; round++) {
  // Alternate which goes first, so neither always gets the warmer slot.
  const order: Kind[] = round % 2 === 0 ? ["fsync", "local"] : ["local", "fsync"];
  for (const kind of order) {
    for (const [mode, run] of [
      ["in-process", inProcess],
      ["http", overHttp],
    ] as const) {
      const rates = await run(kind);
      (results[`${mode} ${kind}`] ??= []).push(rates);
      console.log(`round ${round + 1} ${mode.padEnd(10)} ${kind.padEnd(5)} ${JSON.stringify(rates)}`);
    }
  }
}

console.log("\nmedians, operations per second");
console.log("| mode | level | publish | claim | ack |");
console.log("|---|---|---|---|---|");
for (const [key, list] of Object.entries(results)) {
  const [mode, kind] = key.split(" ");
  console.log(
    `| ${mode} | ${kind} | ${median(list.map((r) => r.publish))} | ${median(list.map((r) => r.claim))} | ${median(list.map((r) => r.ack))} |`,
  );
}
console.log(`load ${loadavg().map((n) => n.toFixed(2)).join(" ")}`);

// For `bun run bench` in packages/db, which reads this line when BQL_BENCH_JSON=1.
const legs: Record<string, { p50: number; value: number; unit: "rps" }> = {};
for (const [key, list] of Object.entries(results)) {
  for (const op of ["publish", "claim", "ack"] as const) {
    const rate = median(list.map((r) => r[op]));
    legs[`${op}, ${key}`] = { p50: rate, value: rate, unit: "rps" };
  }
}
emit({ bench: "bus", info: { rounds, messages, httpMessages }, legs });
