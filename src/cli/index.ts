#!/usr/bin/env bun
import { cp, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileBlobs } from "../bus/blobs";
import { createLogger, isLogLevel, type LogLevel } from "../bus/log";
import { prometheusMetrics } from "../bus/metrics";
import { createServer } from "../bus/server";
import { BusStore } from "../bus/store";
import { generateKey, mint } from "../bus/tokens";
import { BusClient, BusConsumer } from "../client/bus";
import type { Json, TokenClaims } from "../shared/protocol";
import { DEFAULT_WORKSPACE } from "../shared/protocol";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";

function flag(name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`--${name} needs a value`);
  return value;
}
const has = (name: string) => argv.includes(`--${name}`);
function list(name: string): string[] {
  const value = flag(name);
  return value
    ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];
}
function pairs(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of list(name)) {
    const at = entry.indexOf("=");
    if (at < 1) throw new Error(`--${name} wants key=value, got '${entry}'`);
    out[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return out;
}

const stateDir = flag("state", ".agenticbus") as string;
const workspace = flag("workspace", DEFAULT_WORKSPACE) as string;

const level = flag("log-level", process.env.BUS_LOG_LEVEL ?? "info") as string;
if (!isLogLevel(level))
  throw new Error(`--log-level wants debug, info, warn, error or silent`);
const logger = createLogger({
  level: level as LogLevel,
  format: (flag("log-format", process.env.BUS_LOG_FORMAT ?? "text") === "json"
    ? "json"
    : "text") as "json" | "text",
});

/** Secrets live in a 0600 file, not in argv where `ps` would show them. */
async function loadOrCreate(path: string): Promise<string> {
  const file = Bun.file(path);
  if (await file.exists()) return (await file.text()).trim();
  const value = generateKey();
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, value, { mode: 0o600 });
  return value;
}
async function secrets() {
  return {
    signingKey:
      process.env.BUS_SIGNING_KEY ??
      (await loadOrCreate(`${stateDir}/signing-key`)),
    adminToken:
      process.env.BUS_ADMIN_TOKEN ??
      (await loadOrCreate(`${stateDir}/admin-token`)),
  };
}

async function client(): Promise<BusClient> {
  const token = process.env.BUS_TOKEN ?? (await secrets()).adminToken;
  return new BusClient({
    url: flag("url", process.env.BUS_URL ?? "http://127.0.0.1:4317") as string,
    token,
    workspace,
  });
}

function shutdown(stop: () => void | Promise<void>) {
  let closing = false;
  const handler = () => {
    if (closing) return;
    closing = true;
    void Promise.resolve(stop()).finally(() => process.exit(0));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

switch (command) {
  case "serve": {
    const { signingKey, adminToken } = await secrets();
    const db = flag("db", `${stateDir}/bus.db`) as string;
    await mkdir(dirname(resolve(db)), { recursive: true });
    const metrics = prometheusMetrics();
    const store = new BusStore(db, {
      blobs: fileBlobs(flag("blobs", `${stateDir}/blobs`) as string),
      metrics,
      ...(has("retention-ms")
        ? { retentionMs: Number(flag("retention-ms")) }
        : {}),
    });
    const server = createServer({
      store,
      signingKey,
      adminToken,
      metrics,
      logger,
      port: Number(flag("port", process.env.PORT ?? "4317")),
      // Loopback by default. A container has to bind 0.0.0.0 to receive
      // anything, so that is an explicit choice its environment makes rather
      // than a default everyone inherits.
      hostname: flag("host", process.env.BUS_HOST ?? "127.0.0.1") as string,
      ...(has("assets")
        ? { assets: flag("assets") as string }
        : { assets: "dist/dashboard" }),
    });
    const sweep = setInterval(() => store.sweep(), 1000);
    // Blob collection touches a filesystem, so it runs on its own slower
    // interval rather than on the path every claim shares.
    const collect = setInterval(() => {
      void store.collectBlobs().catch((error: unknown) => {
        logger.warn("blob collection failed", { error: String(error) });
      });
    }, 60_000);
    logger.info("listening", {
      url: `http://${server.hostname}:${server.port}`,
      db,
      adminToken: `${stateDir}/admin-token`,
    });
    console.log(`agenticbus http://${server.hostname}:${server.port}`);
    console.log(`admin token  ${stateDir}/admin-token`);
    shutdown(async () => {
      clearInterval(sweep);
      clearInterval(collect);
      // Drain before closing: a consumer's long poll should return empty, not
      // be cut off, and the store must outlive the requests still using it.
      await server.shutdown();
      store.close();
    });
    break;
  }

  // A backup is `VACUUM INTO` plus the blob directory, taken from a *second*
  // connection to the same file while the bus keeps serving. Copying `bus.db`
  // on its own is the classic way to restore a database missing its last few
  // minutes, because the WAL holds them.
  case "backup": {
    const target = flag("into", argv[1]);
    if (!target) throw new Error("backup wants a directory: agenticbus backup <dir>");
    const into = resolve(target);
    await mkdir(into, { recursive: true });
    const store = new BusStore(flag("db", `${stateDir}/bus.db`) as string);
    store.backup(`${into}/bus.db`);
    store.close();
    const blobs = flag("blobs", `${stateDir}/blobs`) as string;
    await cp(blobs, `${into}/blobs`, { recursive: true }).catch(() => {});
    console.log(into);
    break;
  }

  case "token": {
    const { signingKey } = await secrets();
    const claims: TokenClaims = {
      sub: flag("consumer", "anonymous") as string,
      scope: has("reader") ? "reader" : "consumer",
      workspace,
      publish: list("publish"),
      subscribe: list("subscribe"),
      exp: has("ttl") ? Math.floor(Date.now() / 1000) + Number(flag("ttl")) : 0,
    };
    console.log(mint(claims, signingKey));
    break;
  }

  case "publish": {
    const bus = await client();
    const positional = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
    const result = await bus.publish({
      subject: flag("subject", argv[1]) as string,
      body: JSON.parse(flag("body", positional ?? "null") as string) as Json,
      ...(has("key") ? { key: flag("key") as string } : {}),
      ...(has("dedupe") ? { dedupeKey: flag("dedupe") as string } : {}),
      headers: pairs("headers"),
    });
    console.log(JSON.stringify(result));
    break;
  }

  case "request": {
    const bus = await client();
    const positional = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
    const result = await bus.request({
      subject: flag("subject", argv[1]) as string,
      body: JSON.parse(flag("body", positional ?? "null") as string) as Json,
      waitMs: Number(flag("wait", "30000")),
    });
    console.log(JSON.stringify(result.response?.body ?? null));
    if (!result.response) process.exit(2);
    break;
  }

  case "subscribe": {
    const bus = await client();
    const from = flag("from");
    console.log(
      JSON.stringify(
        await bus.subscribe({
          name: flag("name", argv[1]) as string,
          pattern: flag("pattern", argv[2]) as string,
          ...(has("ack-wait") ? { ackWaitMs: Number(flag("ack-wait")) } : {}),
          ...(has("max-attempts")
            ? { maxAttempts: Number(flag("max-attempts")) }
            : {}),
          ...(has("ordered") ? { ordered: true } : {}),
          ...(from
            ? {
                deliverFrom:
                  from === "beginning"
                    ? "beginning"
                    : from === "new"
                      ? "new"
                      : Number(from),
              }
            : {}),
        }),
      ),
    );
    break;
  }

  case "consume": {
    const bus = await client();
    const subscription = flag("subscription", argv[1]) as string;
    const exec = flag("exec");
    const id = flag("id", `${hostname()}-${subscription}`) as string;
    const consumer = new BusConsumer({
      client: bus,
      id,
      subscription,
      name: flag("name", id) as string,
      host: hostname(),
      prefetch: Number(flag("prefetch", "1")),
      labels: pairs("labels"),
      ...(has("exec-timeout")
        ? { handlerTimeoutMs: Number(flag("exec-timeout")) }
        : {}),
      log: (message) => console.error(message),
      // Without --exec the message is printed. With it, the message goes to the
      // command's stdin and its stdout becomes the reply — which is the whole
      // integration story for a language the bus has no SDK for.
      handle: async ({ message }, api) => {
        if (!exec) {
          console.log(JSON.stringify(message));
          return undefined;
        }
        const child = Bun.spawn(["/bin/sh", "-c", exec], {
          stdin: new Blob([JSON.stringify(message)]),
          stdout: "pipe",
          stderr: "inherit",
          env: {
            ...process.env,
            BUS_SUBJECT: message.subject,
            BUS_SEQ: String(message.seq),
          },
        });
        // Cancellation and the handler timeout both arrive as an abort, and
        // neither means anything if the child keeps running: kill it, and let
        // the consume loop decide what to tell the bus.
        const kill = () => {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, 2000).unref?.();
        };
        if (api.signal.aborted) kill();
        else api.signal.addEventListener("abort", kill, { once: true });

        const output = await new Response(child.stdout).text();
        const code = await child.exited;
        api.signal.removeEventListener("abort", kill);
        api.signal.throwIfAborted();
        if (code !== 0) throw new Error(`handler exited ${code}`);
        const trimmed = output.trim();
        if (trimmed.length === 0) return undefined;
        try {
          return JSON.parse(trimmed) as Json;
        } catch {
          return trimmed;
        }
      },
    });
    shutdown(() => consumer.stop());
    await consumer.start();
    break;
  }

  case "cancel": {
    const bus = await client();
    const seq = Number(flag("seq", argv[1]));
    if (!Number.isInteger(seq))
      throw new Error("cancel wants a message sequence number");
    console.log(JSON.stringify(await bus.cancelMessage(seq)));
    break;
  }

  // `dlq <subscription>` lists; `dlq requeue <seq…>` republishes onto the
  // subject each message originally failed on. A DLQ is an ordinary
  // subscription over an ordinary subject, so this is a filtered log read and
  // a publish — no special storage, and nothing to keep in sync.
  case "dlq": {
    const bus = await client();
    if (argv[1] === "requeue") {
      const seqs = argv.slice(2).filter((entry) => /^\d+$/.test(entry));
      if (seqs.length === 0)
        throw new Error("dlq requeue wants one or more message sequence numbers");
      for (const seq of seqs) {
        const result = await bus.requeue(Number(seq));
        console.log(`${seq} → ${result.seq}`);
      }
      break;
    }
    const subscription = flag("subscription", argv[1]) as string;
    if (!subscription) throw new Error("dlq wants a subscription name");
    const dead = await bus.deadLetters(
      subscription,
      Number(flag("limit", "50")),
    );
    if (dead.length === 0) {
      console.log(`no dead letters for '${subscription}'`);
      break;
    }
    for (const message of dead)
      console.log(
        `${String(message.seq).padStart(6)}  ${(
          message.headers["dlq-subject"] ?? message.subject
        ).padEnd(24)} ${(message.headers["dlq-reason"] ?? "").slice(0, 60).padEnd(60)} ${JSON.stringify(
          message.body,
        ).slice(0, 60)}`,
      );
    console.log(`\nrequeue with: agenticbus dlq requeue <seq>`);
    break;
  }

  case "tail": {
    const bus = await client();
    let after = has("after")
      ? Number(flag("after"))
      : (await bus.stats()).lastSeq;
    for (;;) {
      for (const message of await bus.log(after, 100)) {
        after = message.seq;
        console.log(
          `${String(message.seq).padStart(6)}  ${message.subject.padEnd(28)} ${JSON.stringify(
            message.body,
          ).slice(0, 160)}`,
        );
      }
      await Bun.sleep(500);
    }
  }

  case "stats": {
    const bus = await client();
    const stats = await bus.stats();
    console.log(`messages ${stats.messages}  lastSeq ${stats.lastSeq}`);
    console.log("subscriptions");
    for (const subscription of stats.subscriptions)
      console.log(
        `  ${subscription.name.padEnd(18)} ${subscription.pattern.padEnd(22)} pending=${subscription.pending} leased=${subscription.leased} dead=${subscription.dead} lag=${subscription.lag}${
          subscription.paused ? " (paused)" : ""
        }`,
      );
    if (stats.subscriptions.length === 0) console.log("  (none)");
    console.log("consumers");
    for (const consumer of stats.consumers)
      console.log(
        `  ${consumer.id.padEnd(24)} ${consumer.subscriptions.join(",").padEnd(18)} ${Math.round(
          (stats.now - consumer.lastSeen) / 1000,
        )}s ago${consumer.paused ? " (paused)" : ""}`,
      );
    if (stats.consumers.length === 0) console.log("  (none)");
    break;
  }

  default:
    console.log(`agenticbus — a durable message bus for agents and ordinary work

  serve       run the bus
  token       mint a scoped token
  publish     <subject> <json>            publish one message
  request     <subject> <json>            publish and wait for a reply
  subscribe   <name> <pattern>            create a durable subscription
  consume     <subscription> --exec CMD   consume; message is stdin, stdout is the reply
              --exec-timeout <ms>          abort and nack a handler that hangs
  cancel      <seq>                       stop a message: in-flight handlers abort
  dlq         <subscription>              list dead letters
  dlq requeue <seq...>                    republish onto the original subject
  backup      <dir>                       consistent copy of the database and blobs
  tail        follow the log
  stats       subscriptions, consumers, lag

Common flags:
  --url <url>          bus base URL (BUS_URL)
  --state <dir>        signing key and admin token (default .agenticbus)
  --workspace <name>   tenancy (default "default")
  --port --host --db --blobs           serve
  --log-level <level>  debug|info|warn|error|silent (BUS_LOG_LEVEL)
  --log-format <fmt>   text|json (BUS_LOG_FORMAT)
  --publish a.b,c.>    token: subject patterns it may publish to
  --subscribe name     token: subscriptions it may claim from

Examples:
  agenticbus subscribe work 'work.>' --ordered
  agenticbus consume work --exec ./handle.sh --prefetch 4
  agenticbus publish work.resize '{"src":"a.png"}' --key a.png`);
    if (command !== "help" && command !== "--help") process.exit(1);
}

export {};
