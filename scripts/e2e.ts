/**
 * End-to-end, with real processes and no mocks.
 *
 * Starts the bus and two consumer processes, then checks the properties that
 * only show up across a network: competing consumers do not double-handle,
 * fan-out reaches every subscription, a consumer killed mid-message loses its
 * lease to another machine, a poison message dead-letters onto an ordinary
 * subject, and a request gets its reply back through the bus.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKey, mint } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";

const scratch = await mkdtemp(`${tmpdir()}/agenticbus-e2e-`);
const signingKey = generateKey();
const adminToken = generateKey();

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
const port = await freePort(4400);
const url = `http://127.0.0.1:${port}`;

const children = new Map<string, ReturnType<typeof Bun.spawn>>();
const spawn = (
  name: string,
  args: string[],
  extra: Record<string, string> = {},
) => {
  const child = Bun.spawn([process.execPath, ...args], {
    env: {
      ...process.env,
      BUS_SIGNING_KEY: signingKey,
      BUS_ADMIN_TOKEN: adminToken,
      BUS_URL: url,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.set(name, child);
  return child;
};

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

async function waitFor<T>(
  label: string,
  read: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(200);
  }
}

const admin = new BusClient({ url, token: adminToken });
const consumerToken = (id: string, subscription: string) =>
  mint(
    {
      sub: id,
      scope: "consumer",
      workspace: "default",
      publish: ["reply", "results.>"],
      subscribe: [subscription],
      exp: 0,
    },
    signingKey,
  );

try {
  spawn("bus", [
    "src/cli/index.ts",
    "serve",
    "--state",
    scratch,
    "--db",
    `${scratch}/bus.db`,
    "--blobs",
    `${scratch}/blobs`,
    "--port",
    String(port),
  ]);
  await waitFor("the bus to listen", async () =>
    (await fetch(`${url}/health`)).ok ? true : null,
  );
  check("the bus is up", true);

  await admin.subscribe({
    name: "work",
    pattern: "work.>",
    // Short enough that a killed consumer's lease expires quickly, with more
    // than one attempt left afterwards — the check is that recovery happens,
    // not that the attempt budget is spent to the last one.
    ackWaitMs: 2500,
    maxAttempts: 4,
  });
  await admin.subscribe({ name: "audit", pattern: ">", ackWaitMs: 10_000 });
  await admin.subscribe({ name: "rpc", pattern: "rpc.>", ackWaitMs: 10_000 });
  await admin.subscribe({ name: "failures", pattern: "dlq.>" });

  for (const [id, subscription] of [
    ["worker-a", "work"],
    ["worker-b", "work"],
    ["responder", "rpc"],
  ] as const)
    spawn(
      id,
      ["examples/consumer.ts", "--id", id, "--subscription", subscription],
      { BUS_TOKEN: consumerToken(id, subscription) },
    );

  await waitFor("consumers to register", async () => {
    const stats = await admin.stats();
    return stats.consumers.length === 3 ? true : null;
  });
  check("three consumer processes registered", true);

  // ---- competing consumers: eight messages, each handled exactly once ----
  for (let index = 0; index < 8; index++)
    await admin.publish({ subject: "work.echo", body: { index } });

  await waitFor("the work subscription to drain", async () => {
    const stats = await admin.stats();
    const work = stats.subscriptions.find((s) => s.name === "work")!;
    return work.pending === 0 && work.leased === 0 ? true : null;
  });
  const drained = await admin.stats();
  const work = drained.subscriptions.find((s) => s.name === "work")!;
  check(
    "eight messages were handled with none left pending or dead",
    work.pending === 0 && work.dead === 0,
    `pending=${work.pending} dead=${work.dead}`,
  );

  // ---- fan-out: audit saw the same messages, on its own cursor ----
  const audited = await admin.claim("audit", "auditor", 20, 2000);
  check(
    "a second subscription received the same messages independently",
    audited.filter((e) => e.message.subject === "work.echo").length === 8,
    `${audited.length} envelopes`,
  );
  for (const envelope of audited) await admin.ack(envelope.delivery, "auditor");

  // ---- a killed consumer loses its lease to another machine ----
  await admin.publish({ subject: "work.slow", body: { ms: 8000 } });
  const holder = await waitFor("a consumer to take the slow message", async () => {
    const deliveries = (await admin.call("/api/deliveries")) as {
      subscription: string;
      status: string;
      consumerId: string | null;
      messageSeq: number;
    }[];
    return (
      deliveries.find(
        (d) => d.subscription === "work" && d.status === "leased" && d.consumerId,
      ) ?? null
    );
  });
  children.get(holder.consumerId!)?.kill("SIGKILL");
  check(`killed ${holder.consumerId} while it held the slow message`, true);

  const recovered = await waitFor(
    "the lease to expire and another consumer to finish it",
    async () => {
      const deliveries = (await admin.call("/api/deliveries")) as {
        messageSeq: number;
        status: string;
        consumerId: string | null;
        attempt: number;
      }[];
      const same = deliveries.find((d) => d.messageSeq === holder.messageSeq);
      return same?.status === "acked" && same.consumerId !== holder.consumerId
        ? same
        : null;
    },
    45_000,
  ).catch(async (error) => {
    const deliveries = (await admin.call("/api/deliveries")) as unknown[];
    const stats = await admin.stats();
    console.error("deliveries:", JSON.stringify(deliveries).slice(0, 900));
    console.error("subs:", JSON.stringify(stats.subscriptions).slice(0, 500));
    throw error;
  });
  check(
    "a surviving consumer recovered the expired lease",
    recovered.attempt >= 2,
    `attempt ${recovered.attempt}, now on ${recovered.consumerId}`,
  );

  // ---- a poison message dead-letters onto an ordinary subject ----
  await admin.publish({ subject: "work.poison", body: { bad: true } });
  const dead = await waitFor("the poison message to dead-letter", async () => {
    const envelopes = await admin.claim("failures", "dlq-reader", 5, 3000);
    return envelopes.length > 0 ? envelopes : null;
  });
  check(
    "the poison message reached the dead-letter subject with its reason",
    dead[0]!.message.headers["dlq-reason"]!.includes("unsupported"),
    dead[0]!.message.headers["dlq-reason"]!,
  );
  check(
    "the dead letter kept the original subject in its headers",
    dead[0]!.message.headers["dlq-subject"]! === "work.poison",
  );

  // ---- request/reply across processes ----
  const answered = await admin.request({
    subject: "rpc.upper",
    body: "hello bus",
    waitMs: 10_000,
  });
  check(
    "a request was answered by a consumer in another process",
    answered.response?.body === "HELLO BUS",
    JSON.stringify(answered.response?.body ?? null),
  );

  // ---- durability: the response survives being collected later ----
  const again = await admin.response(answered.correlation!);
  check("the response is still collectable afterwards", again?.body === "HELLO BUS");

  // ---- dedupe ----
  const first = await admin.publish({
    subject: "work.echo",
    body: 1,
    dedupeKey: "once",
  });
  const second = await admin.publish({
    subject: "work.echo",
    body: 2,
    dedupeKey: "once",
  });
  check(
    "a repeated dedupe key does not publish twice",
    second.seq === first.seq && second.duplicate,
  );
} catch (error) {
  check("e2e completed without an unexpected error", false, String(error));
} finally {
  for (const child of children.values()) child.kill("SIGTERM");
  await Bun.sleep(600);
  for (const child of children.values())
    if (child.exitCode === null) child.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nall end-to-end checks passed");
