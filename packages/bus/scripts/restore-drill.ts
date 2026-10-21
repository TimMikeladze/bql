#!/usr/bin/env bun
/**
 * Prove database `bus` can be restored from its bucket with bql.sh's own
 * commands.
 *
 * Publishes messages (one body large enough for `blobs_data`), moves a cursor,
 * stops the bus so it ships what is outstanding, then restores into an empty
 * data directory with `bql serve` + `bql restore bus --from s3://…`, starts the
 * bus there and checks the log, the cursor and the large body.
 *
 *   bun scripts/restore-drill.ts                  # an in-process fake bucket
 *   BQL_S3_URL=s3://bucket/prefix BQL_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… bun scripts/restore-drill.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { FakeS3 } from "../../db/test/storage/fake-s3.ts";
import { generateKey } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(`${tmpdir()}/bql-bus-restore-`);
const data = `${scratch}/data`;
const restored = `${scratch}/restored`;
const signingKey = generateKey();
const adminToken = generateKey();
const bqlAdminKey = generateKey();

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
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

// The bucket: the caller's, or a fake one in this process.
const fake = process.env.BQL_S3_URL ? null : await FakeS3.start({ bucket: "bql-bus-drill" });
const bucketUrl =
  process.env.BQL_S3_URL ?? `s3://bql-bus-drill/drill-${Date.now().toString(36)}`;
const s3Env: Record<string, string> = fake
  ? {
      BQL_S3_URL: bucketUrl,
      BQL_S3_ENDPOINT: fake.storeOptions.endpoint,
      BQL_S3_REGION: fake.storeOptions.region,
      BQL_S3_ACCESS_KEY_ID: fake.storeOptions.accessKeyId,
      BQL_S3_SECRET_ACCESS_KEY: fake.storeOptions.secretAccessKey,
    }
  : {};

// `bql …`: the compiled binary when `BQL_BUS_BIN` names one, else the source.
const binary = process.env.BQL_BUS_BIN;
const children: ReturnType<typeof Bun.spawn>[] = [];
const bql = (args: string[], env: Record<string, string> = {}) =>
  track(Bun.spawn(binary ? [binary, ...args] : [process.execPath, "../db/src/cli.ts", ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...s3Env,
      BUS_SIGNING_KEY: signingKey,
      BUS_ADMIN_TOKEN: adminToken,
      ...env,
    },
    stdout: "pipe",
    stderr: "inherit",
  }));

function track<T extends ReturnType<typeof Bun.spawn>>(child: T): T {
  children.push(child);
  return child;
}

async function waitFor(url: string, child: ReturnType<typeof bql>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`${url} exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return child;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`${url} never came up`);
}

const port = await freePort(4820);
const url = `http://127.0.0.1:${port}`;

const serveBus = (dir: string, env: Record<string, string> = {}) =>
  waitFor(
    `${url}/health`,
    bql(["bus", "serve", "--data", dir, "--port", String(port), "--log-level", "error"], env),
  );

try {
  let bus = await serveBus(data);
  const admin = new BusClient({ url, token: adminToken });

  await admin.subscribe({
    name: "drill",
    pattern: "drill.>",
    deliverFrom: "beginning",
    backoff: { baseMs: 0 },
  });
  // One body far over the inline limit, so it lives in `blobs_data`.
  const big = "x".repeat(200_000);
  for (let index = 0; index < 20; index++)
    await admin.publish({
      subject: "drill.work",
      body: index === 7 ? { big } : { index },
    });
  // Move a cursor, so "the cursors survived" is a claim with content.
  const claimed = await admin.claim("drill", "drill-1", 5);
  for (const envelope of claimed) await admin.ack(envelope.delivery, "drill-1");

  const before = {
    stats: await admin.stats(),
    log: await admin.log(0, 100),
  };

  // SIGTERM closes the engine, which ships everything outstanding first.
  bus.kill("SIGTERM");
  await bus.exited;

  // An empty node that reads the bucket and does not ship to it.
  const bqlPort = await freePort(port + 1);
  const server = await waitFor(
    `http://127.0.0.1:${bqlPort}/healthz`,
    bql(
      ["serve", "--dir", restored, "--port", String(bqlPort), "--admin-key", bqlAdminKey],
      { BQL_S3_ENABLED: "false" },
    ),
  );
  const restore = bql([
    "restore",
    "bus",
    "--from",
    bucketUrl,
    "--into",
    "bus",
    "--url",
    `http://127.0.0.1:${bqlPort}`,
    "--token",
    bqlAdminKey,
  ]);
  const restoreOut = await new Response(restore.stdout).text();
  check("bql restore read the bucket", (await restore.exited) === 0, restoreOut.trim());
  server.kill("SIGTERM");
  await server.exited;

  bus = await serveBus(restored, { BQL_S3_ENABLED: "false" });
  const after = {
    stats: await admin.stats(),
    log: await admin.log(0, 100),
  };

  check(
    "the log came back identical",
    JSON.stringify(after.log) === JSON.stringify(before.log),
    `${after.log.length} of ${before.log.length} messages`,
  );
  const blobbed = after.log.find((message) => message.seq === before.log[7]!.seq);
  check(
    "the large body came back",
    typeof blobbed?.body === "object" &&
      blobbed !== null &&
      (blobbed.body as { big?: string }).big === big,
    `${((blobbed?.body as { big?: string })?.big ?? "").length} bytes`,
  );
  const cursorBefore = before.stats.subscriptions[0]!;
  const cursorAfter = after.stats.subscriptions[0]!;
  check(
    "the subscription cursor came back",
    cursorAfter.cursorSeq === cursorBefore.cursorSeq,
    `${cursorAfter.cursorSeq} vs ${cursorBefore.cursorSeq}`,
  );
  check(
    "acked deliveries were not resurrected",
    cursorAfter.acked === cursorBefore.acked,
    `${cursorAfter.acked} vs ${cursorBefore.acked}`,
  );

  bus.kill("SIGTERM");
  await bus.exited;
} finally {
  // A check that threw leaves a server running; nothing else should.
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  fake?.stop();
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nrestore drill passed");
