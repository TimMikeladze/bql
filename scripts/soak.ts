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
  /** A deterministic crash point inside the bus: blob-write, mid-txn, post-ack. */
  fault: string | null;
  faultAfter: number;
  /** `full` or `normal`. See the note where this is reported. */
  sync: string;
  /** Fraction of messages that always fail, to exercise backoff and the DLQ. */
  poison: number;
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
  fault: has("fault") ? flag("fault", "") : null,
  faultAfter: num("fault-after", 50),
  sync: flag("sync", "full"),
  poison: has("poison") ? Number(flag("poison", "0.02")) : 0,
  quiet: has("quiet"),
};
if (options.fault && !["blob-write", "mid-txn", "post-ack"].includes(options.fault))
  throw new Error("--fault wants blob-write, mid-txn or post-ack");

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
    // `AGENTICBUS_BIN` swaps the CLI for a compiled binary, so the same
  // end-to-end checks run against the artefact that actually ships. A binary
  // nobody executed in CI is not a release artefact.
  const binary = process.env.AGENTICBUS_BIN;
  const command =
    binary && args[0] === "src/cli/index.ts"
      ? [binary, ...args.slice(1)]
      : [process.execPath, ...args];
  const child = Bun.spawn(command, {
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
    "--synchronous",
    options.sync,
  ];

  /** Start the bus and wait for it to answer. Retries a port still in TIME_WAIT. */
  /**
   * Arm the deterministic crash point on the *first* start only.
   *
   * The restarted bus must come up and stay up, or nothing downstream is
   * measuring recovery — it is measuring a crash loop.
   */
  let faultArmed = options.fault !== null;
  const startBus = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const child = spawn(
        "bus",
        busArgs,
        faultArmed
          ? { BUS_FAULT: options.fault!, BUS_FAULT_AFTER: String(options.faultAfter) }
          : {},
      );
      faultArmed = false;
      for (let tick = 0; tick < 60; tick++) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        try {
          if ((await fetch(`${url}/health`)).ok) return;
        } catch {}
        await Bun.sleep(100);
      }
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
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
      // A poison run needs a small, countable attempt budget — the assertion
      // is "each poison message was handled at most maxAttempts times", and 40
      // would make a hot loop indistinguishable from correct pacing.
      maxAttempts: options.poison > 0 ? 3 : 40,
      ordered: options.ordered,
      deliverFrom: "beginning",
      // Real backoff on a poison run; none otherwise, because the kill tests
      // are about recovery latency and would otherwise spend the run waiting.
      backoff:
        options.poison > 0
          ? { baseMs: 200, maxMs: 2000, factor: 2, jitter: "full" as const }
          : { baseMs: 0 },
      onFailure: "block" as const,
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
    const poisonSeqs = new Set<number>();
    const bulky = options.fault === "blob-write";
    const bulk = bulky ? "x".repeat(80_000) : "";
    const keyOf = (index: number) =>
      options.ordered ? `k${index % options.keys}` : null;
    // Deterministic rather than random, so a failure is reproducible and the
    // expected dead count is exact rather than approximate.
    const poisoned = (index: number) =>
      options.poison > 0 &&
      index > 0 &&
      index % Math.max(2, Math.round(1 / options.poison)) === 0;

    const publisher = (async () => {
      const inFlight = new Set<Promise<void>>();
      for (let index = 0; index < options.messages; index++) {
        if (inFlight.size >= 24) await Promise.race(inFlight);
        const task = retry(async () => {
          const result = await admin.publish({
            subject: "soak.work",
            // `--fault blob-write` only means anything if a blob is written,
            // so that run sends bodies past the 64 KiB inline limit.
            body: poisoned(index)
              ? { index, poison: true, ...(bulky ? { bulk } : {}) }
              : { index, ...(bulky ? { bulk } : {}) },
            // Killing the broker mid-publish can lose the *response* to a
            // request that already committed, and the retry below would then
            // publish a second copy — 5001 messages for 5000 intended, which
            // reads as "acked more than once" when it is nothing of the kind.
            // A dedupe key makes the retry return the original message, which
            // is exactly what dedupe keys are for, and turns the assertion
            // into an exact one rather than an approximate one.
            dedupeKey: `soak-${index}`,
            ...(options.ordered ? { key: keyOf(index) } : {}),
          });
          published.add(result.seq);
          if (poisoned(index)) poisonSeqs.add(result.seq);
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

    // A deterministic fault kills the bus from the inside, so nothing else is
    // watching for it. Without this the run would simply hang at the drain.
    const supervisor = (async () => {
      if (options.fault === null) return;
      while (!stopping) {
        const bus = children.get("bus");
        // A process killed by a signal has a null `exitCode` and a
        // `signalCode` — checking only the former is how a SIGKILLed bus looks
        // exactly like a running one.
        if (bus && (bus.exitCode !== null || bus.signalCode !== null)) {
          if (!options.quiet)
            console.log(`     … the bus died at '${options.fault}'; restarting`);
          await startBus();
        }
        await Bun.sleep(100);
      }
    })();

    await Promise.all([publisher, busKiller]);

    // ---- drain ----
    const deadline = Date.now() + 180_000;
    // With `--ordered --poison` the run is *supposed* to stop short: a dead
    // message blocks its key, and everything behind that key stays pending
    // until an operator acts. So "drained" there means "stopped making
    // progress with keys blocked", not "empty" — treating a stall as a failure
    // would be asserting the opposite of the property under test.
    const orderedPoison = options.ordered && options.poison > 0;
    let drained = false;
    let lastPending = -1;
    let stable = 0;
    for (;;) {
      const stats = await retry(() => admin.stats());
      const soak = stats.subscriptions.find((s) => s.name === "soak");
      if (
        soak &&
        soak.pending === 0 &&
        soak.leased === 0 &&
        soak.acked + soak.dead >= published.size
      ) {
        drained = true;
        break;
      }
      if (orderedPoison && soak && soak.leased === 0) {
        stable = soak.pending === lastPending ? stable + 1 : 0;
        lastPending = soak.pending;
        if (stable >= 6 && soak.acked + soak.dead + soak.pending >= published.size) {
          drained = true;
          break;
        }
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
    await supervisor;

    const stats = await retry(() => admin.stats());
    const soak = stats.subscriptions.find((s) => s.name === "soak")!;

    const blocked = orderedPoison
      ? await retry(() => admin.blockedKeys("soak"))
      : [];

    if (drained && orderedPoison) {
      check(
        "nothing was lost: every message is acked, dead or blocked",
        soak.acked + soak.dead + soak.pending === published.size,
        `acked=${soak.acked} dead=${soak.dead} pending=${soak.pending} published=${published.size}`,
      );
      // One dead letter per blocked key, not one per poison message: once a
      // key is blocked, the *next* poison message on that key is never
      // delivered, which is the whole point of blocking.
      check(
        "one dead letter per blocked key, and no more",
        soak.dead === blocked.length && soak.dead <= poisonSeqs.size,
        `dead=${soak.dead} blocked=${blocked.length} poison=${poisonSeqs.size}`,
      );
      check(
        "the failed keys are blocked, not silently skipped",
        blocked.length > 0 && soak.pending > 0,
        `${blocked.length} keys blocked, ${soak.pending} messages held behind them`,
      );
    } else if (drained) {
      check(
        "every message was acked exactly once",
        soak.acked === published.size - poisonSeqs.size,
        `acked=${soak.acked} published=${published.size} poison=${poisonSeqs.size}`,
      );
      check(
        "nothing was left pending or leased",
        soak.pending === 0 && soak.leased === 0,
        `pending=${soak.pending} leased=${soak.leased}`,
      );
      check(
        options.poison > 0
          ? "exactly the poison messages dead-lettered"
          : "nothing dead-lettered",
        soak.dead === poisonSeqs.size,
        `dead=${soak.dead} expected=${poisonSeqs.size}`,
      );
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
    // A message held behind a blocked key was never handled, and is not
    // supposed to have been.
    const missing = [...published].filter(
      (seq) => !seen.has(seq) && !(orderedPoison && seq > Math.min(...poisonSeqs)),
    );
    check(
      "every message was handled at least once",
      missing.length === 0,
      missing.length === 0
        ? `${handled.length} handled, ${handled.length - seen.size} redelivered`
        : `${missing.length} never handled, e.g. ${missing.slice(0, 5).join(",")}`,
    );

    if (options.poison > 0) {
      // The bug this exists for: `available_at` was never set on a reclaim and
      // `nack` defaulted to no delay, so a poison message burned every attempt
      // it had as fast as consumers could claim it. Two checks, because either
      // alone can pass while the other fails: the budget was respected, and it
      // was not spent in a millisecond.
      const attemptsBySeq = new Map<number, number[]>();
      for (const receipt of handled) {
        if (!poisonSeqs.has(receipt.seq)) continue;
        const times = attemptsBySeq.get(receipt.seq);
        if (times) times.push(receipt.at);
        else attemptsBySeq.set(receipt.seq, [receipt.at]);
      }
      let overrun: string | null = null;
      for (const [seq, times] of attemptsBySeq)
        if (times.length > 3) {
          overrun = `seq ${seq} was handled ${times.length} times for a budget of 3`;
          break;
        }
      check(
        "no poison message exceeded its attempt budget",
        overrun === null,
        overrun ?? `${attemptsBySeq.size} poison messages, ${handled.length} handlings`,
      );

      // Backoff is `baseMs: 200` with full jitter, so successive attempts on
      // one message average 100ms apart. A hot loop puts them microseconds
      // apart; this asserts the median gap is on the right side of that by an
      // order of magnitude rather than pinning a jittered number exactly.
      const gaps: number[] = [];
      for (const times of attemptsBySeq.values()) {
        times.sort((a, b) => a - b);
        for (let index = 1; index < times.length; index++)
          gaps.push(times[index]! - times[index - 1]!);
      }
      gaps.sort((a, b) => a - b);
      const median = gaps.length === 0 ? 0 : gaps[Math.floor(gaps.length / 2)]!;
      check(
        "retries were paced by backoff, not hot-looped",
        gaps.length === 0 || median >= 10,
        `median gap ${median.toFixed(1)}ms across ${gaps.length} retries`,
      );

      if (options.ordered) {
        // `onFailure: block` — the reason `ordered: true` was bought. Once a
        // key's message is dead, nothing else on that key may be handled until
        // an operator acts.
        const deadAt = new Map<string, number>();
        for (const receipt of [...handled].sort((a, b) => a.at - b.at)) {
          if (!poisonSeqs.has(receipt.seq)) continue;
          const key = receipt.key ?? "";
          // The last handling of a poison message is the one that killed it.
          deadAt.set(key, receipt.at);
        }
        let overtook: string | null = null;
        for (const receipt of handled) {
          const key = receipt.key ?? "";
          const died = deadAt.get(key);
          if (died === undefined) continue;
          if (poisonSeqs.has(receipt.seq)) continue;
          const poisonSeq = [...poisonSeqs].find(
            (seq) =>
              handled.find((other) => other.seq === seq)?.key === receipt.key,
          );
          if (poisonSeq !== undefined && receipt.seq > poisonSeq && receipt.at > died)
            overtook = `key ${key}: seq ${receipt.seq} ran after seq ${poisonSeq} was dead`;
          if (overtook) break;
        }
        check(
          "no key overtook its dead predecessor",
          overtook === null,
          overtook ?? `${deadAt.size} keys blocked`,
        );
      }
    }

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
    }${options.fault ? `, fault '${options.fault}' after ${options.faultAfter}` : ""}${
      options.poison > 0 ? `, ${Math.round(options.poison * 100)}% poison` : ""
    }${options.sync !== "full" ? `, synchronous=${options.sync.toUpperCase()}` : ""}`,
  );
  allFailures.push(...(await runOnce(label, options)));
  console.log(`   ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (options.sync.toLowerCase() === "normal") {
  // Said plainly rather than dressed up as a passing durability test. A
  // SIGKILL takes the *process*; the page cache belongs to the kernel and
  // survives it, so `synchronous=NORMAL` loses nothing here. The loss it
  // permits is on machine failure — power loss, a kernel panic, a yanked
  // volume — which this harness cannot simulate. What the run does show is the
  // cost of the default, and that the cost is real is why the default is worth
  // stating.
  console.log(
    "\nnote: synchronous=NORMAL survived this run, and that is expected.\n" +
      "A process kill cannot demonstrate the loss it permits — only machine\n" +
      "failure can, because the page cache outlives the process. Compare the\n" +
      "elapsed time above against a --sync full run: that difference is what\n" +
      "synchronous=FULL costs, and machine-failure durability is what it buys.",
  );
}

if (allFailures.length > 0) {
  console.error(
    `\n${allFailures.length} failure(s):\n  ${allFailures.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`\nsoak passed${repeat > 1 ? ` ${repeat} consecutive runs` : ""}`);
