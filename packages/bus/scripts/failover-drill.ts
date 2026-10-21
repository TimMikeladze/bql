#!/usr/bin/env bun
/**
 * Failover of a three-node clustered bus, under load.
 *
 * Three `bql bus serve --cluster` processes form one bql.sh Raft group with
 * database `bus` on every node. A producer publishes at `ack: "replica"`
 * through one multi-URL client while two consumers claim and ack. The primary
 * is SIGKILLed, a replica is promoted, and the work carries on. At the end:
 *
 *   · every publish answered 2xx is in the new primary's log (RPO 0 at `replica`)
 *   · every one of them was processed at least once
 *   · the failover time: from the kill to the first publish the new primary
 *     acknowledged, as the producer saw it
 *
 *   bun scripts/failover-drill.ts [--seconds 4]
 *
 * `BQL_BUS_BIN=./dist/bql` runs the compiled binary instead of the source.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateKey } from "../src/bus/tokens";
import { BusClient, BusRequestError } from "../src/client/bus";
import type { Message } from "../src/shared/protocol";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(`${tmpdir()}/bql-bus-cluster-drill-`);
const signingKey = generateKey();
const adminToken = generateKey();
const clusterSecret = generateKey();
/** bql.sh's own admin key, the same on every node, for `GET /v1/cluster` when something fails. */
const bqlAdminKey = generateKey();
const seconds = Number(
  process.argv[process.argv.indexOf("--seconds") + 1] ?? 4,
) || 4;

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

async function freePort(start: number): Promise<number> {
  for (let candidate = start; candidate < start + 500; candidate++) {
    try {
      const probe = Bun.listen({
        hostname: "127.0.0.1",
        port: candidate,
        socket: { data() {} },
      });
      probe.stop(true);
      return candidate;
    } catch {}
  }
  throw new Error(`no free port from ${start}`);
}

const ids = ["n1", "n2", "n3"];
const ports = new Map<string, number>();
let next = 4850;
for (const id of ids) {
  const port = await freePort(next);
  ports.set(id, port);
  next = port + 1;
}
const busUrl = (id: string) => `http://127.0.0.1:${ports.get(id)}/bus`;
const children = new Map<string, ReturnType<typeof Bun.spawn>>();
const binary = process.env.BQL_BUS_BIN;

function spawn(id: string) {
  const args = [
    "serve",
    "--cluster",
    "--node",
    id,
    "--port",
    String(ports.get(id)),
    "--peers",
    ids
      .filter((peer) => peer !== id)
      .map((peer) => `${peer}=ws://127.0.0.1:${ports.get(peer)}`)
      .join(","),
    "--data",
    `${scratch}/${id}`,
    "--ack",
    "replica",
    "--log-level",
    "warn",
  ];
  const child = Bun.spawn(
    binary ? [binary, "bus", ...args] : [process.execPath, "src/cli/index.ts", ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        BUS_SIGNING_KEY: signingKey,
        BUS_ADMIN_TOKEN: adminToken,
        BUS_CLUSTER_SECRET: clusterSecret,
        BQL_ADMIN_KEY: bqlAdminKey,
      },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  children.set(id, child);
}

async function health(id: string): Promise<{ role?: string } | null> {
  try {
    const response = await fetch(`${busUrl(id)}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok ? ((await response.json()) as { role?: string }) : null;
  } catch {
    return null;
  }
}

async function until<T>(what: string, check: () => Promise<T | null | false>, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const primaryId = async (among = ids): Promise<string | null> => {
  for (const id of among) if ((await health(id))?.role === "primary") return id;
  return null;
};

try {
  for (const id of ids) spawn(id);
  await until("three nodes serving the bus", async () =>
    (await Promise.all(ids.map(health))).every((one) => one?.role),
  );
  const first = (await until("a bus primary", () => primaryId())) as string;
  console.log(`nodes  ${ids.map((id) => `${id}=${busUrl(id)}`).join("  ")}`);
  console.log(`primary ${first}`);

  const urls = ids.map(busUrl);
  const client = () => new BusClient({ url: urls, token: adminToken, timeoutMs: 10_000 });
  const producer = client();
  await producer.subscribe({ name: "drill", pattern: "drill.>", deliverFrom: "beginning" });
  // `replica` needs a replica streaming; right after start that can take a moment.
  await until("a replica to ack", async () => {
    try {
      await producer.publish({ subject: "warmup.x", ack: "replica" });
      return true;
    } catch {
      return false;
    }
  });

  /** Message id → the seq its 2xx named. Seqs can be reused after a failover; ids cannot. */
  const acked = new Map<number, number>();
  const refused = new Map<string, number>();
  const processed = new Set<number>();
  let publishing = true;
  let consuming = true;
  let killedAt = 0;
  let firstAfterKill = 0;
  let counter = 0;

  const publishLoop = (async () => {
    while (publishing) {
      const id = ++counter;
      const startedAt = Date.now();
      try {
        const result = await producer.publish({
          subject: "drill.work",
          body: { id },
          ack: "replica",
        });
        acked.set(id, result.seq);
        // Only a publish sent after the kill counts; one in flight across it
        // may have been answered by the old primary.
        if (killedAt && startedAt > killedAt && !firstAfterKill) firstAfterKill = Date.now();
      } catch (error) {
        const code =
          error instanceof BusRequestError
            ? (error.code ?? String(error.status))
            : ((error as { code?: string }).code ?? "error");
        refused.set(code, (refused.get(code) ?? 0) + 1);
        await Bun.sleep(20);
      }
    }
  })();

  const consumeLoop = (name: string) =>
    (async () => {
      const consumer = client();
      while (consuming) {
        try {
          const envelopes = await consumer.claim("drill", name, 25, 500);
          for (const envelope of envelopes) {
            processed.add((envelope.message.body as { id: number }).id);
            await consumer.ack(envelope.delivery, name).catch(() => {});
          }
        } catch {
          await Bun.sleep(100);
        }
      }
    })();
  const consumers = [consumeLoop("c1"), consumeLoop("c2")];

  await Bun.sleep(seconds * 1000);
  const before = acked.size;
  const victim = (await primaryId()) as string;
  killedAt = Date.now();
  children.get(victim)?.kill("SIGKILL");
  console.log(`killed ${victim} (SIGKILL) after ${before} acknowledged publishes`);
  const survivors = ids.filter((id) => id !== victim);
  const promoted = (await until("a survivor to take the primary", () =>
    primaryId(survivors),
  ).catch(async (error) => {
    for (const id of survivors) {
      const view = await fetch(`http://127.0.0.1:${ports.get(id)}/v1/cluster`, {
        headers: { authorization: `Bearer ${bqlAdminKey}` },
      })
        .then((response) => response.text())
        .catch(String);
      console.error(`${id} bus ${JSON.stringify(await health(id))}\n${id} /v1/cluster ${view}`);
    }
    throw error;
  })) as string;
  const promotedAt = Date.now();
  await until("a publish acknowledged after the kill", async () => firstAfterKill > 0, 60_000);
  await Bun.sleep(seconds * 1000);
  publishing = false;
  await publishLoop;

  // Drain: every acknowledged message processed at least once.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && [...acked.keys()].some((id) => !processed.has(id)))
    await Bun.sleep(100);
  consuming = false;
  await Promise.all(consumers);

  // Everything acknowledged is in the new primary's log.
  const reader = new BusClient({ url: busUrl(promoted), token: adminToken });
  const log = new Map<number, Message>();
  for (let after = 0; ; ) {
    const page = await reader.log(after, 1000, { subject: "drill.work" });
    if (page.length === 0) break;
    for (const message of page) log.set(message.seq, message);
    after = page.at(-1)!.seq;
  }
  const lost = [...acked].filter(
    ([id, seq]) => (log.get(seq)?.body as { id?: number } | undefined)?.id !== id,
  );
  const unprocessed = [...acked.keys()].filter((id) => !processed.has(id));

  console.log(`promoted ${promoted}`);
  console.log(
    `failover  ${promotedAt - killedAt} ms to a new primary, ${firstAfterKill - killedAt} ms to the first acknowledged publish`,
  );
  console.log(
    `publishes ${acked.size} acknowledged, ${[...refused].map(([code, n]) => `${n} ${code}`).join(", ") || "none refused"}`,
  );
  console.log(`RPO       ${lost.length} acknowledged publishes lost`);
  check("every acknowledged publish is in the new primary's log", lost.length === 0, `${lost.length} missing`);
  check(
    "every acknowledged publish was processed at least once",
    unprocessed.length === 0,
    `${unprocessed.length} unprocessed`,
  );
  check("work continued after the failover", acked.size > before, `${acked.size - before} after the kill`);

  // The old primary comes back as a replica of the new one and catches up.
  spawn(victim);
  const lastSeq = Math.max(...acked.values());
  const rejoined = await until(
    `${victim} to rejoin as a replica with the whole log`,
    async () => {
      if ((await health(victim))?.role !== "replica") return false;
      try {
        const stats = await new BusClient({ url: busUrl(victim), token: adminToken }).stats();
        return stats.lastSeq >= lastSeq;
      } catch {
        return false;
      }
    },
  ).then(
    () => true,
    () => false,
  );
  check(`${victim} rejoined as a replica and caught up`, rejoined);
  check("the new primary kept the primary", (await health(promoted))?.role === "primary");
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  for (const child of children.values()) child.kill("SIGKILL");
  await Promise.all([...children.values()].map((child) => child.exited));
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nfailover drill passed");
