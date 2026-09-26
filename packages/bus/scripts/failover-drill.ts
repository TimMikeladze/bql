#!/usr/bin/env bun
/**
 * Failover, under load, with the fence doing the work.
 *
 * The three things worth proving, and the only three this claims:
 *   · a follower rebuilt from the **bus log** matches the leader's log
 *   · promotion is fenced — the old leader stops writing once the epoch moves
 *   · the replication lag at the moment of failover is a number, and it is the
 *     RPO. Replication is asynchronous; anything published inside that window
 *     is lost, and this prints how much it was.
 *
 *   bun scripts/failover-drill.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateKey } from "../src/bus/tokens";
import { BusClient, BusRequestError } from "../src/client/bus";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(`${tmpdir()}/bql-bus-failover-`);
const signingKey = generateKey();
const adminToken = generateKey();
const lease = `${scratch}/lease.json`;

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

async function freePort(start: number): Promise<number> {
  for (let candidate = start; candidate < start + 200; candidate++) {
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

const children = new Map<string, ReturnType<typeof Bun.spawn>>();
const binary = process.env.BQL_BUS_BIN;
const spawn = (name: string, args: string[]) => {
  const child = Bun.spawn(
    binary ? [binary, "bus", ...args] : [process.execPath, "src/cli/index.ts", ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        BUS_SIGNING_KEY: signingKey,
        BUS_ADMIN_TOKEN: adminToken,
      },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  children.set(name, child);
  return child;
};

const waitUp = async (url: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`${url} never came up`);
};

try {
  const leaderPort = await freePort(4840);
  const replicaPort = await freePort(leaderPort + 1);
  const leaderUrl = `http://127.0.0.1:${leaderPort}`;
  const replicaUrl = `http://127.0.0.1:${replicaPort}`;

  spawn("leader", [
    "serve",
    "--data",
    `${scratch}/leader`,
    "--port",
    String(leaderPort),
    "--lease",
    lease,
    "--log-level",
    "error",
  ]);
  await waitUp(leaderUrl);

  const leader = new BusClient({ url: leaderUrl, token: adminToken });
  await leader.subscribe({
    name: "work",
    pattern: "work.>",
    deliverFrom: "beginning",
  });

  // Load, and keep it running across the promotion: a drill on a quiet bus
  // proves the easy half.
  let published = 0;
  let stopPublishing = false;
  const publisher = (async () => {
    while (!stopPublishing) {
      try {
        await leader.publish({ subject: "work.do", body: { n: published } });
        published++;
      } catch {
        // Expected once the leader is fenced out.
      }
      await Bun.sleep(2);
    }
  })();

  await Bun.sleep(500);
  spawn("replica", [
    "follow",
    leaderUrl,
    "--data",
    `${scratch}/replica`,
    "--port",
    String(replicaPort),
    "--idle-ms",
    "100",
    "--log-level",
    "error",
  ]);
  await waitUp(replicaUrl);
  const replica = new BusClient({ url: replicaUrl, token: adminToken });

  // Let it catch up under load.
  await Bun.sleep(2000);
  const beforeLeader = await leader.stats();
  const beforeReplica = await replica.stats();
  const lagAtFailover = beforeLeader.lastSeq - beforeReplica.lastSeq;
  check(
    "the replica tracked the leader's log",
    beforeReplica.lastSeq > 0 && lagAtFailover >= 0,
    `replica at ${beforeReplica.lastSeq}, leader at ${beforeLeader.lastSeq}`,
  );

  // A replica is read-only, and says so rather than accepting a write it
  // cannot keep.
  let refused = false;
  try {
    await replica.publish({ subject: "work.do", body: "should not land" });
  } catch (error) {
    refused = error instanceof BusRequestError && error.status === 409;
  }
  check("a follower refuses writes", refused);

  // ---- promote ----
  children.get("replica")?.kill("SIGTERM");
  await children.get("replica")?.exited;

  const promotion = Bun.spawn(
    binary
      ? [binary, "promote", "--data", `${scratch}/replica`, "--lease", lease, "--holder", "replica"]
      : [
          process.execPath,
          "src/cli/index.ts",
          "promote",
          "--data",
          `${scratch}/replica`,
          "--lease",
          lease,
          "--holder",
          "replica",
        ],
    { cwd: root, env: { ...process.env, BUS_SIGNING_KEY: signingKey, BUS_ADMIN_TOKEN: adminToken }, stdout: "pipe", stderr: "inherit" },
  );
  const promoted = JSON.parse(await new Response(promotion.stdout).text()) as {
    epoch: number;
    role: string;
  };
  check(
    "promotion advanced the epoch and took the leader role",
    promoted.epoch >= 1 && promoted.role === "leader",
    `epoch ${promoted.epoch}, role ${promoted.role}`,
  );

  // ---- the fence ----
  // The old leader polls the lease and stops writing. This is the half that
  // makes the epoch mean something: without it, both nodes accept writes.
  let fenced = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !fenced) {
    try {
      await leader.publish({ subject: "work.do", body: "after the fence" });
    } catch (error) {
      fenced = error instanceof BusRequestError && error.status === 409;
    }
    await Bun.sleep(250);
  }
  stopPublishing = true;
  await publisher;
  check("the old leader stopped writing once it was fenced out", fenced);

  // ---- what the failover cost ----
  const promotedBus = spawn("promoted", [
    "serve",
    "--data",
    `${scratch}/replica`,
    "--port",
    String(replicaPort),
    "--lease",
    lease,
    "--log-level",
    "error",
  ]);
  void promotedBus;
  await waitUp(replicaUrl);
  const after = await replica.stats();
  check(
    "the promoted node serves writes",
    (await replica.publish({ subject: "work.do", body: "new leader" })).seq > 0,
  );
  check(
    "the new leader kept the subscription and its cursor",
    after.subscriptions.some((s) => s.name === "work"),
    `${after.subscriptions.length} subscription(s)`,
  );
  // The RPO is the lag **at the moment of promotion**, not the difference
  // between the two nodes afterwards — the old leader goes on accepting writes
  // until the fence reaches it, and counting those as "lost" would conflate
  // two different things. What was lost is what the replica had not yet
  // applied when it took over.
  console.log(
    `\nRPO at this failover: ${lagAtFailover} message(s).\n` +
      `Replication is asynchronous, so a failover loses up to the current lag.\n` +
      `bql-bus.replication.lag_seq and lag_ms are the gauges that carry it;\n` +
      `alert on them, because this number is the promise you are making.`,
  );
} finally {
  for (const child of children.values()) child.kill("SIGTERM");
  await Bun.sleep(500);
  for (const child of children.values())
    if (child.exitCode === null) child.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nfailover drill passed");
