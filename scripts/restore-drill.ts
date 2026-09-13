#!/usr/bin/env bun
/**
 * Prove a backup can be restored.
 *
 * `backup` existed and nothing checked it, which is the same as not having
 * one. This publishes real messages — including a body large enough to go to a
 * blob, because a blob directory that did not come along is the failure mode a
 * database-only restore hides — takes a backup, wipes the data directory,
 * restores, and asserts the log, the cursors and the blob bytes are identical.
 *
 *   bun scripts/restore-drill.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateKey } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(`${tmpdir()}/agenticbus-restore-`);
const data = `${scratch}/data`;
const backup = `${scratch}/backup`;
const signingKey = generateKey();
const adminToken = generateKey();

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

const binary = process.env.AGENTICBUS_BIN;
const cli = (args: string[]) =>
  Bun.spawn(binary ? [binary, ...args] : [process.execPath, "src/cli/index.ts", ...args], {
    cwd: root,
    env: { ...process.env, BUS_SIGNING_KEY: signingKey, BUS_ADMIN_TOKEN: adminToken },
    stdout: "pipe",
    stderr: "inherit",
  });

const port = await freePort(4820);
const url = `http://127.0.0.1:${port}`;

async function serve() {
  const child = cli([
    "serve",
    "--data",
    data,
    "--port",
    String(port),
    "--log-level",
    "error",
  ]);
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return child;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("the bus never came up");
}

try {
  let bus = await serve();
  const admin = new BusClient({ url, token: adminToken });

  await admin.subscribe({
    name: "drill",
    pattern: "drill.>",
    deliverFrom: "beginning",
    backoff: { baseMs: 0 },
  });
  // One body far over the inline limit, so the restore has to bring the blob
  // directory with it or the bytes come back missing.
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

  const takeBackup = cli(["backup", backup, "--data", data]);
  if ((await takeBackup.exited) !== 0) throw new Error("backup failed");

  bus.kill("SIGTERM");
  await bus.exited;
  // A wipe, not a rename: restoring next to the old files is the one thing
  // this is supposed to prove unnecessary.
  await rm(data, { recursive: true, force: true });

  const restore = cli(["restore", backup, "--data", data]);
  const restoreOut = await new Response(restore.stdout).text();
  check("restore reported a healthy database", (await restore.exited) === 0, restoreOut.trim());

  bus = await serve();
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
    "the blob bytes came back",
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
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nrestore drill passed");
