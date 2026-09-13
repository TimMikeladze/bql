#!/usr/bin/env bun
/**
 * Soak: many consumer processes racing on one subscription, being SIGKILLed.
 *
 * Every other test in this repo drives one writer deterministically, which is
 * the wrong shape for finding the failures that matter here. This spawns real
 * OS processes, pushes thousands of messages through them, kills consumers at
 * random throughout — and optionally kills the bus itself mid-flight — then
 * asserts the properties the bus claims:
 *
 *   · every message was handled at least once      (consumer receipts)
 *   · every message was acked exactly once         (one delivery row per message)
 *   · nothing is left pending or leased
 *   · nothing dead-lettered that was not meant to
 *   · with --ordered, per-key FIFO held under kills
 *   · with --kill-bus, WAL recovery lost nothing
 *
 *   bun scripts/soak.ts
 *   bun scripts/soak.ts --ordered
 *   bun scripts/soak.ts --kill-bus
 *   bun scripts/soak.ts --term-bus
 *   bun scripts/soak.ts --repeat 10
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKey, mint } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(`--${name}`);
const flag = (name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (argv[index + 1] ?? fallback);
};
const num = (name: string, fallback: number) =>
  Number(flag(name, String(fallback)));

interface Options {
  consumers: number;
  messages: number;
  prefetch: number;
  holdMs: number;
  /** Distinct ordering keys. Only meaningful with `ordered`. */
  keys: number;
  /** How many consumer kills to spread across the run. */
  kills: number;
  killEveryMs: number;
  ordered: boolean;
  killBus: boolean;
  /** SIGTERM the bus mid-flight instead of SIGKILLing it: the deploy case. */
  termBus: boolean;
  quiet: boolean;
}

const options: Options = {
  consumers: num("consumers", 8),
  messages: num("messages", 5000),
  prefetch: num("prefetch", 4),
  holdMs: num("hold-ms", 30),
  keys: num("keys", 16),
  kills: num("kills", 12),
  killEveryMs: num("kill-every-ms", 400),
  ordered: has("ordered"),
  killBus: has("kill-bus"),
  termBus: has("term-bus"),
  quiet: has("quiet"),
};

async function freePort(start: number): Promise<number> {
  for (let candidate = start; candidate < start + 400; candidate++) {
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

/** Run every scenario once. Returns the failures it found. */
async function runOnce(label: string, options: Options): Promise<string[]> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failures.push(`${label}: ${name}${detail ? ` — ${detail}` : ""}`);
    if (!options.quiet || !ok)
      console.log(
        `${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`,
      );
  };

  const scratch = await mkdtemp(`${tmpdir()}/agenticbus-soak-`);
  const receipts = `${scratch}/receipts`;
  await mkdir(receipts, { recursive: true });
  const signingKey = generateKey();
  const adminToken = generateKey();
  const port = await freePort(4600);
  const url = `http://127.0.0.1:${port}`;
  const children = new Map<string, ReturnType<typeof Bun.spawn>>();
  let stopping = false;

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
      stdout: "ignore",
      stderr: options.quiet ? "ignore" : "inherit",
    });
    children.set(name, child);
    return child;
  };

  const busArgs = [
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
    "--log-level",
    "error",
  ];

  /** Start the bus and wait for it to answer. Retries a port still in TIME_WAIT. */
  const startBus = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const child = spawn("bus", busArgs);
      for (let tick = 0; tick < 60; tick++) {
        if (child.exitCode !== null) break;
        try {
          if ((await fetch(`${url}/health`)).ok) return;
        } catch {}
        await Bun.sleep(100);
      }
      if (child.exitCode === null) child.kill("SIGKILL");
      await Bun.sleep(250);
    }
    throw new Error("the bus never came up");
  };

  const admin = new BusClient({ url, token: adminToken, timeoutMs: 20_000 });
  const workerId = (index: number) => `soak-${index}`;
  const startWorker = (index: number) =>
    spawn(
      workerId(index),
      [
        "scripts/soak-worker.ts",
        "--id",
        workerId(index),
        "--subscription",
        "soak",
        "--receipts",
        receipts,
        "--prefetch",
        String(options.prefetch),
        "--hold-ms",
        String(options.holdMs),
      ],
      {
        BUS_TOKEN: mint(
          {
            sub: workerId(index),
            scope: "consumer",
            workspace: "default",
            publish: [],
            subscribe: ["soak"],
            exp: 0,
          },
          signingKey,
        ),
      },
    );

  /** The bus may be mid-restart, so every read is allowed to miss. */
  const retry = async <T>(work: () => Promise<T>, tries = 40): Promise<T> => {
    let last: unknown;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await work();
      } catch (error) {
        last = error;
        await Bun.sleep(250);
      }
    }
    throw last;
  };

  try {
    await startBus();
    await admin.subscribe({
      name: "soak",
      pattern: "soak.>",
      // Short enough that a killed consumer's work comes back quickly; a
      // generous attempt budget so a message unlucky enough to be caught by
      // several kills still never dead-letters.
      ackWaitMs: 2000,
      maxAttempts: 40,
      ordered: options.ordered,
      deliverFrom: "beginning",
    });

    for (let index = 0; index < options.consumers; index++) startWorker(index);
    await retry(async () => {
      const stats = await admin.stats();
      if (stats.consumers.length < options.consumers)
        throw new Error(`only ${stats.consumers.length} registered`);
      return true;
    });

    // ---- publish, kill, and (optionally) kill the bus, all at once ----
    const published = new Set<number>();
    const keyOf = (index: number) =>
      options.ordered ? `k${index % options.keys}` : null;

    const publisher = (async () => {
      const inFlight = new Set<Promise<void>>();
      for (let index = 0; index < options.messages; index++) {
        if (inFlight.size >= 24) await Promise.race(inFlight);
        const task = retry(async () => {
          const result = await admin.publish({
            subject: "soak.work",
            body: { index },
            ...(options.ordered ? { key: keyOf(index) } : {}),
          });
          published.add(result.seq);
        })
          .catch((error) => {
            failures.push(`${label}: publishing message ${index} — ${error}`);
          })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      await Promise.allSettled([...inFlight]);
    })();

    const killer = (async () => {
      // Paced by wall-clock, not by the message count: a kill that lands after
      // the run has drained proves nothing, and deriving the spacing from the
      // workload meant most of them did exactly that.
      for (let round = 0; round < options.kills && !stopping; round++) {
        await Bun.sleep(options.killEveryMs);
        if (stopping) break;
        const index = Math.floor(Math.random() * options.consumers);
        const victim = children.get(workerId(index));
        victim?.kill("SIGKILL");
        await Bun.sleep(150);
        // Same id on purpose: the dead process's lease has to expire and be
        // reclaimed, rather than the work quietly moving to a fresh name.
        startWorker(index);
      }
    })();

    const busKiller =
      options.killBus || options.termBus
        ? (async () => {
            await Bun.sleep(1500);
            const bus = children.get("bus");
            if (options.termBus) {
              // The deploy case: SIGTERM drains — long polls return empty,
              // in-flight acks finish — and only then does the process exit.
              bus?.kill("SIGTERM");
              await bus?.exited;
              if (!options.quiet) console.log("     … the bus drained and exited");
            } else {
              bus?.kill("SIGKILL");
              if (!options.quiet) console.log("     … killed the bus");
              await Bun.sleep(400);
            }
            await startBus();
            if (!options.quiet) console.log("     … the bus is back");
          })()
        : Promise.resolve();

    await Promise.all([publisher, busKiller]);

    // ---- drain ----
    const deadline = Date.now() + 180_000;
    let drained = false;
    for (;;) {
      const stats = await retry(() => admin.stats());
      const soak = stats.subscriptions.find((s) => s.name === "soak");
      if (
        soak &&
        soak.pending === 0 &&
        soak.leased === 0 &&
        soak.acked >= published.size
      ) {
        drained = true;
        break;
      }
      if (Date.now() > deadline) {
        check(
          "the subscription drained",
          false,
          soak
            ? `pending=${soak.pending} leased=${soak.leased} acked=${soak.acked}/${published.size} dead=${soak.dead}`
            : "no subscription",
        );
        break;
      }
      await Bun.sleep(400);
    }
    stopping = true;
    await killer;

    const stats = await retry(() => admin.stats());
    const soak = stats.subscriptions.find((s) => s.name === "soak")!;

    if (drained) {
      check(
        "every message was acked exactly once",
        soak.acked === published.size,
        `acked=${soak.acked} published=${published.size}`,
      );
      check(
        "nothing was left pending or leased",
        soak.pending === 0 && soak.leased === 0,
        `pending=${soak.pending} leased=${soak.leased}`,
      );
      check("nothing dead-lettered", soak.dead === 0, `dead=${soak.dead}`);
    }

    // ---- receipts: what the consumers actually ran ----
    interface Receipt {
      seq: number;
      key: string | null;
      attempt: number;
      by: string;
      /** Sub-millisecond and comparable across processes on one machine. */
      at: number;
    }
    const handled: Receipt[] = [];
    for (const file of await readdir(receipts)) {
      const text = await Bun.file(`${receipts}/${file}`).text();
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          handled.push(JSON.parse(line) as Receipt);
        } catch {
          // A SIGKILL can land mid-write, so a torn final line is expected and
          // is not evidence of anything. Anything earlier would have been a
          // complete write(2).
        }
      }
    }
    const seen = new Set(handled.map((receipt) => receipt.seq));
    const missing = [...published].filter((seq) => !seen.has(seq));
    check(
      "every message was handled at least once",
      missing.length === 0,
      missing.length === 0
        ? `${handled.length} handled, ${handled.length - seen.size} redelivered`
        : `${missing.length} never handled, e.g. ${missing.slice(0, 5).join(",")}`,
    );

    if (options.ordered) {
      // Per-key FIFO: a redelivery may repeat a sequence number, but the order
      // a key's messages are handled in may never go backwards.
      const byKey = new Map<string, number[]>();
      // Receipts come from several files, so they have to be put back into the
      // order they actually happened in before order can mean anything.
      for (const receipt of [...handled].sort((a, b) => a.at - b.at)) {
        const key = receipt.key ?? "";
        const list = byKey.get(key);
        if (list) list.push(receipt.seq);
        else byKey.set(key, [receipt.seq]);
      }
      let inversion: string | null = null;
      for (const [key, seqs] of byKey) {
        for (let index = 1; index < seqs.length; index++)
          if (seqs[index]! < seqs[index - 1]!) {
            inversion = `key ${key}: ${seqs[index - 1]} then ${seqs[index]}`;
            break;
          }
        if (inversion) break;
      }
      check(
        "per-key order held under kills",
        inversion === null,
        inversion ?? `${byKey.size} keys`,
      );
    }

    if (options.killBus || options.termBus)
      check(
        options.termBus
          ? "the log survived a SIGTERM and restart"
          : "the log survived the bus being killed",
        stats.messages >= published.size,
        `${stats.messages} messages in the log, ${published.size} published`,
      );

    // ---- the scrape is clean, under load, with real subscriptions ----
    const scrape = await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const text = await scrape.text();
    const malformed = text
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .filter(
        (line) =>
          !/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?(\d+(\.\d+)?([eE][-+]?\d+)?|[+-]?Inf|NaN)$/.test(
            line,
          ),
      );
    // Gauges, not counters: a restarted bus has a fresh registry, and a
    // counter that resets on restart is normal Prometheus. The gauges are
    // computed from the store at scrape time, so they are there either way.
    check(
      "/metrics scrapes clean",
      scrape.status === 200 &&
        malformed.length === 0 &&
        text.includes('agenticbus_subscription_lag{subscription="soak"'),
      malformed.length > 0
        ? `malformed: ${malformed[0]}`
        : scrape.status !== 200
          ? `HTTP ${scrape.status}`
          : `${text.split("\n").length} lines`,
    );
  } catch (error) {
    check("the soak ran without an unexpected error", false, String(error));
  } finally {
    stopping = true;
    for (const child of children.values()) child.kill("SIGTERM");
    await Bun.sleep(500);
    for (const child of children.values())
      if (child.exitCode === null) child.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  }
  return failures;
}

const repeat = num("repeat", 1);
const allFailures: string[] = [];
for (let run = 1; run <= repeat; run++) {
  const label = repeat > 1 ? `run ${run}/${repeat}` : "soak";
  const started = Date.now();
  console.log(
    `\n— ${label}: ${options.consumers} consumers, ${options.messages} messages, ${options.kills} kills${
      options.ordered ? ", ordered" : ""
    }${options.killBus ? ", killing the bus" : ""}${
      options.termBus ? ", SIGTERMing the bus" : ""
    }`,
  );
  allFailures.push(...(await runOnce(label, options)));
  console.log(`   ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (allFailures.length > 0) {
  console.error(
    `\n${allFailures.length} failure(s):\n  ${allFailures.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`\nsoak passed${repeat > 1 ? ` ${repeat} consecutive runs` : ""}`);
