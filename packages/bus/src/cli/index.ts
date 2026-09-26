#!/usr/bin/env bun
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileBlobs } from "../bus/blobs";
import { createLogger, isLogLevel, type LogLevel } from "../bus/log";
import { prometheusMetrics } from "../bus/metrics";
import { createServer } from "../bus/server";
import { BusStore } from "../bus/store";
import { fenceWatcher, fileLease, follow, promote } from "../bus/replication";
import { generateKey, type Keyring, keyring, mint, singleKey } from "../bus/tokens";
import { otlpExporter } from "../bus/trace";
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

// One data directory: signing key, admin token, database, WAL and blobs. A
// binary plus a directory is the whole deployment, and a container can
// relocate all of it onto its volume with one flag. `--state` is the older
// spelling of the same thing and still works.
const stateDir = flag(
  "data",
  flag(
    "state",
    process.env.BUS_DATA ?? process.env.BUS_STATE ?? ".bql-bus",
  ),
) as string;
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
interface KeyringFile {
  active: string;
  keys: Record<string, string>;
}

/**
 * The signing keyring.
 *
 * Two keys live at once during a rotation, which is what makes rotating
 * possible without invalidating every token in the fleet at the same moment.
 * A bus that has only ever had one key adopts it as `k1` rather than being
 * told its existing tokens are now invalid.
 */
async function keyringFor(): Promise<Keyring> {
  // An explicit environment key means the operator is managing keys
  // themselves; rotation is theirs to do, so there is one and no file.
  if (process.env.BUS_SIGNING_KEY) return singleKey(process.env.BUS_SIGNING_KEY);
  const path = `${stateDir}/keys.json`;
  const file = Bun.file(path);
  if (await file.exists()) {
    const parsed = JSON.parse(await file.text()) as KeyringFile;
    return keyring(parsed.keys, parsed.active);
  }
  const legacy = await loadOrCreate(`${stateDir}/signing-key`);
  await writeKeyring(path, { active: "k1", keys: { k1: legacy } });
  return keyring({ k1: legacy }, "k1");
}

async function writeKeyring(path: string, value: KeyringFile) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
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
    const { adminToken } = await secrets();
    const keys = await keyringFor();
    const db = flag("db", `${stateDir}/bus.db`) as string;
    await mkdir(dirname(resolve(db)), { recursive: true });
    const metrics = prometheusMetrics();
    const store = new BusStore(db, {
      blobs: fileBlobs(flag("blobs", `${stateDir}/blobs`) as string),
      metrics,
      ...(has("retention-ms")
        ? { retentionMs: Number(flag("retention-ms")) }
        : {}),
      ...(flag("synchronous")?.toUpperCase() === "NORMAL"
        ? { synchronous: "NORMAL" as const }
        : {}),
      ...(has("min-free-bytes")
        ? { minFreeBytes: Number(flag("min-free-bytes")) }
        : {}),
      ...(has("wal-checkpoint-bytes")
        ? { walCheckpointBytes: Number(flag("wal-checkpoint-bytes")) }
        : {}),
      // Spans go out over `fetch` as OTLP/HTTP JSON. Without an endpoint the
      // trace context still travels in message headers — the part a consumer
      // needs — and nothing is exported.
      ...(has("otlp-endpoint")
        ? {
            tracer: otlpExporter({
              endpoint: flag("otlp-endpoint") as string,
              serviceName: flag("otlp-service", "bql-bus") as string,
              onError: (error) =>
                logger.warn("the span exporter could not reach its collector", {
                  error: String(error),
                }),
            }),
          }
        : {}),
    });
    // The reverse of the orphan sweep, and the right moment for it: a crash
    // between writing a blob and committing the row that names it shows up
    // here, once, instead of as a subscription that has quietly stalled.
    const reconciled = await store.reconcileBlobs();
    if (reconciled.missing > 0)
      logger.warn("messages reference blobs that are gone", reconciled);
    const server = createServer({
      store,
      signingKey: keys,
      adminToken,
      metrics,
      logger,
      ...(has("publish-rate")
        ? {
            publishRate: {
              perSecond: Number(flag("publish-rate")),
              burst: Number(flag("publish-burst", flag("publish-rate"))),
            },
          }
        : {}),
      ...(has("claim-rate")
        ? {
            claimRate: {
              perSecond: Number(flag("claim-rate")),
              burst: Number(flag("claim-burst", flag("claim-rate"))),
            },
          }
        : {}),
      ...(has("max-polls")
        ? { maxParkedPerToken: Number(flag("max-polls")) }
        : {}),
      port: Number(flag("port", process.env.PORT ?? "4317")),
      // Loopback by default. A container has to bind 0.0.0.0 to receive
      // anything, so that is an explicit choice its environment makes rather
      // than a default everyone inherits.
      hostname: flag("host", process.env.BUS_HOST ?? "127.0.0.1") as string,
      ...(has("assets")
        ? { assets: flag("assets") as string }
        : { assets: "dist/dashboard" }),
    });
    // The other half of the promotion fence: a leader that has been
    // superseded stops writing. Without this, the epoch is a number nobody
    // acts on.
    const fence = has("lease")
      ? fenceWatcher({
          store,
          lease: fileLease(flag("lease") as string),
          logger,
        })
      : null;
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
    console.log(`bql bus http://${server.hostname}:${server.port}`);
    console.log(`admin token  ${stateDir}/admin-token`);
    shutdown(async () => {
      fence?.stop();
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
    if (!target) throw new Error("backup wants a directory: bql bus backup <dir>");
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

  /**
   * The other half of `backup`, and the reason it is worth anything.
   *
   * A backup nobody has restored is a file, not a backup. This copies the
   * `VACUUM INTO` snapshot and the blob directory into a data directory, then
   * *opens* the result — so a snapshot that cannot be migrated, or a blob
   * directory that did not come along, fails here rather than during an
   * incident.
   */
  case "restore": {
    const source = flag("from", argv[1]);
    if (!source)
      throw new Error("restore wants a directory: bql bus restore <dir> --data <dir>");
    const from = resolve(source);
    if (!(await Bun.file(`${from}/bus.db`).exists()))
      throw new Error(`${from}/bus.db does not exist`);
    const db = flag("db", `${stateDir}/bus.db`) as string;
    const blobs = flag("blobs", `${stateDir}/blobs`) as string;
    if ((await Bun.file(db).exists()) && !has("force"))
      throw new Error(
        `${db} already exists — restoring over a live database is how two histories become one, so pass --force if that is really what you want`,
      );
    await mkdir(dirname(resolve(db)), { recursive: true });
    await cp(`${from}/bus.db`, db);
    // A snapshot is self-contained, so any WAL left beside the target belongs
    // to the database that was just replaced and would be replayed onto the
    // new one.
    await rm(`${db}-wal`, { force: true });
    await rm(`${db}-shm`, { force: true });
    await rm(blobs, { recursive: true, force: true });
    await cp(`${from}/blobs`, blobs, { recursive: true }).catch(() => {});
    const store = new BusStore(db, { blobs: fileBlobs(blobs) });
    // Point-in-time: restore the snapshot, then cut the log off just before
    // whatever went wrong. `--until-time` takes anything `Date.parse` accepts.
    let truncated: { removed: number; lastSeq: number } | null = null;
    if (has("until-seq") || has("until-time")) {
      const until = has("until-seq")
        ? Number(flag("until-seq"))
        : store.seqAt(Date.parse(flag("until-time") as string));
      if (!Number.isInteger(until) || until < 0)
        throw new Error("--until-seq wants a sequence number, --until-time a date");
      truncated = store.truncateAfter(until);
    }
    const missing = await store.reconcileBlobs();
    const stats = store.stats(workspace);
    store.close();
    console.log(
      JSON.stringify({
        data: resolve(stateDir),
        lastSeq: stats.lastSeq,
        messages: stats.messages,
        subscriptions: stats.subscriptions.length,
        blobsMissing: missing.missing,
        ...(truncated ? { truncated: truncated.removed } : {}),
      }),
    );
    if (missing.missing > 0) process.exit(1);
    break;
  }

  case "token": {
    const keys = await keyringFor();
    const claims: TokenClaims = {
      sub: flag("consumer", "anonymous") as string,
      scope: has("reader") ? "reader" : "consumer",
      workspace,
      publish: list("publish"),
      subscribe: list("subscribe"),
      exp: has("ttl") ? Math.floor(Date.now() / 1000) + Number(flag("ttl")) : 0,
    };
    console.log(mint(claims, keys));
    break;
  }

  /**
   * Key rotation with overlap.
   *
   * `rotate` adds a key and makes it active; the old one keeps verifying, so
   * tokens already in the fleet go on working. `retire` is the second step,
   * taken once they have expired — and it is the step that actually withdraws
   * anything, which is why it is separate.
   */
  case "keys": {
    const path = `${stateDir}/keys.json`;
    const file = Bun.file(path);
    const current: KeyringFile = (await file.exists())
      ? (JSON.parse(await file.text()) as KeyringFile)
      : { active: "k1", keys: { k1: await loadOrCreate(`${stateDir}/signing-key`) } };
    const action = argv[1] ?? "list";
    if (action === "rotate") {
      const kid =
        flag("kid", `k${Object.keys(current.keys).length + 1}`) as string;
      if (current.keys[kid]) throw new Error(`key '${kid}' already exists`);
      current.keys[kid] = generateKey();
      current.active = kid;
      await writeKeyring(path, current);
      console.log(JSON.stringify({ active: kid, keys: Object.keys(current.keys) }));
      break;
    }
    if (action === "retire") {
      const kid = flag("kid", argv[2]) as string;
      if (!kid) throw new Error("keys retire wants a key id");
      if (kid === current.active)
        throw new Error(
          `'${kid}' is the active key — rotate to a new one before retiring it`,
        );
      if (!current.keys[kid]) throw new Error(`no key '${kid}'`);
      delete current.keys[kid];
      await writeKeyring(path, current);
      console.log(JSON.stringify({ active: current.active, keys: Object.keys(current.keys) }));
      break;
    }
    console.log(
      JSON.stringify({ active: current.active, keys: Object.keys(current.keys) }),
    );
    break;
  }

  // ------------------------------------------------------------- schemas
  case "schema": {
    const bus = await client();
    const action = argv[1] ?? "list";
    if (action === "register") {
      const name = flag("name", argv[2]) as string;
      const path = flag("file", argv[3]) as string;
      if (!name || !path) throw new Error("schema register wants a name and a file");
      const source = JSON.parse(await Bun.file(path).text()) as Json;
      console.log(
        JSON.stringify(
          await bus.registerSchema(
            name,
            source,
            (flag("compat", "backward") as "backward") ?? "backward",
          ),
        ),
      );
      break;
    }
    if (action === "check") {
      const name = flag("name", argv[2]) as string;
      const path = flag("file", argv[3]) as string;
      const source = JSON.parse(await Bun.file(path).text()) as Json;
      const result = await bus.checkSchema(
        name,
        source,
        (flag("compat", "backward") as "backward") ?? "backward",
      );
      for (const change of result.changes)
        console.log(`${change.direction.padEnd(9)} ${change.pointer || "/"} ${change.detail}`);
      if (result.breaking.length > 0) {
        console.error(
          `\n${result.breaking.length} change(s) break '${flag("compat", "backward")}' against version ${result.against}`,
        );
        process.exit(1);
      }
      console.log(
        result.against === null
          ? "no previous version to compare against"
          : `compatible with version ${result.against}`,
      );
      break;
    }
    if (action === "bind") {
      const pattern = flag("pattern", argv[2]) as string;
      const name = flag("schema", argv[3]) as string;
      if (!pattern || !name) throw new Error("schema bind wants a pattern and a schema name");
      console.log(
        JSON.stringify(
          await bus.bindSchema(
            pattern,
            name,
            (flag("mode", "warn") as "warn") ?? "warn",
          ),
        ),
      );
      break;
    }
    if (action === "unbind") {
      const pattern = flag("pattern", argv[2]) as string;
      console.log(JSON.stringify(await bus.unbindSchema(pattern)));
      break;
    }
    if (action === "bindings") {
      for (const binding of await bus.schemaBindings())
        console.log(
          `${binding.pattern.padEnd(28)} ${binding.schema.padEnd(20)} ${binding.mode}`,
        );
      break;
    }
    const versions = await bus.schemas(flag("name"));
    if (versions.length === 0) {
      console.log("no schemas registered");
      break;
    }
    for (const version of versions)
      console.log(
        `${version.name.padEnd(24)} v${String(version.version).padEnd(4)} ${version.compat.padEnd(9)} ${version.hash.slice(0, 12)}`,
      );
    break;
  }

  // --------------------------------------------------------- tenant safety
  case "revoke": {
    const bus = await client();
    const jti = flag("jti", argv[1]) as string;
    if (!jti) throw new Error("revoke wants a token id (jti)");
    console.log(
      JSON.stringify(
        await bus.revokeToken(jti, Number(flag("not-after", "0"))),
      ),
    );
    break;
  }

  case "quota": {
    const bus = await client();
    if (argv[1] === "set") {
      console.log(
        JSON.stringify(
          await bus.setQuota({
            ...(has("messages") ? { maxMessages: Number(flag("messages")) } : {}),
            ...(has("bytes") ? { maxBytes: Number(flag("bytes")) } : {}),
            ...(has("subscriptions")
              ? { maxSubscriptions: Number(flag("subscriptions")) }
              : {}),
          }),
        ),
      );
      break;
    }
    console.log(JSON.stringify(await bus.quota()));
    break;
  }

  case "audit": {
    const bus = await client();
    for (const entry of await bus.auditLog(Number(flag("limit", "50"))))
      console.log(
        `${new Date(entry.at).toISOString()} ${entry.actor.padEnd(20)} ${entry.action.padEnd(24)} ${entry.target ?? ""}`,
      );
    break;
  }

  // ---------------------------------------------------------- continuity
  /**
   * Follow an upstream bus, applying its log and cursors.
   *
   * What is replicated is the *bus log*, not the SQLite WAL: the bus already is
   * a log with a monotonic sequence number, so this survives a schema change
   * and needs no frame parsing. Leases are deliberately not replicated — a
   * promoted follower re-materializes deliveries from cursors, through the same
   * code path a cold start already uses.
   */
  case "follow": {
    const upstreamUrl = flag("upstream", argv[1]) as string;
    if (!upstreamUrl) throw new Error("follow wants an upstream URL");
    const db = flag("db", `${stateDir}/bus.db`) as string;
    await mkdir(dirname(resolve(db)), { recursive: true });
    const metrics = prometheusMetrics();
    const store = new BusStore(db, {
      blobs: fileBlobs(flag("blobs", `${stateDir}/blobs`) as string),
      metrics,
    });
    const upstream = new BusClient({
      url: upstreamUrl,
      token: process.env.BUS_TOKEN ?? (await secrets()).adminToken,
      workspace,
      timeoutMs: 30_000,
    });
    const follower = follow({
      store,
      upstream,
      upstreamUrl,
      logger,
      ...(has("idle-ms") ? { idleMs: Number(flag("idle-ms")) } : {}),
      onLag: ({ seqBehind, ms }) => {
        // Replication is asynchronous, so a failover can lose up to this.
        // Publishing it is what makes the RPO a number rather than a hope.
        metrics.gauge("bql-bus.replication.lag_seq", seqBehind);
        metrics.gauge("bql-bus.replication.lag_ms", ms);
      },
    });
    // A follower serves reads. The store refuses writes on its own — being a
    // follower is recorded in the database, not in a flag that can disagree
    // with it — so this is the same server, not a second one.
    const replica = has("port")
      ? createServer({
          store,
          signingKey: await keyringFor(),
          adminToken: (await secrets()).adminToken,
          metrics,
          logger,
          port: Number(flag("port")),
          hostname: flag("host", process.env.BUS_HOST ?? "127.0.0.1") as string,
        })
      : null;
    logger.info("following", {
      upstream: upstreamUrl,
      data: resolve(stateDir),
      ...(replica ? { url: `http://${replica.hostname}:${replica.port}` } : {}),
    });
    console.log(
      `following ${upstreamUrl} into ${resolve(stateDir)}${
        replica ? ` — reads on http://${replica.hostname}:${replica.port}` : ""
      }`,
    );
    shutdown(async () => {
      await follower.stop();
      if (replica) await replica.shutdown();
      store.close();
    });
    await follower.done;
    break;
  }

  /**
   * Take the leader role, fenced by a lease in shared storage.
   *
   * The lease is acquired first and the epoch it grants is what gets stamped
   * into the database — recording a new epoch locally and then losing the race
   * would leave a node that believes it is the leader. The old leader, if it is
   * still running with `--lease`, sees the epoch move and stops writing.
   */
  case "promote": {
    const leasePath = flag("lease");
    if (!leasePath)
      throw new Error(
        "promote wants --lease <path> in storage both nodes can see: the fence is the point",
      );
    const db = flag("db", `${stateDir}/bus.db`) as string;
    const store = new BusStore(db, {
      blobs: fileBlobs(flag("blobs", `${stateDir}/blobs`) as string),
    });
    const holder = flag("holder", hostname()) as string;
    const won = await promote(store, fileLease(leasePath), holder);
    const state = store.cluster();
    store.close();
    console.log(JSON.stringify({ ...won, ...state }));
    break;
  }

  case "cluster": {
    const store = new BusStore(flag("db", `${stateDir}/bus.db`) as string);
    console.log(JSON.stringify(store.cluster()));
    store.close();
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
      ...(has("priority") ? { priority: Number(flag("priority")) } : {}),
      ...(has("delay") ? { delayMs: Number(flag("delay")) } : {}),
      ...(has("at") ? { deliverAt: Date.parse(flag("at") as string) } : {}),
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
          ...(has("backoff-base") ||
          has("backoff-max") ||
          has("backoff-factor") ||
          has("no-jitter")
            ? {
                backoff: {
                  ...(has("backoff-base")
                    ? { baseMs: Number(flag("backoff-base")) }
                    : {}),
                  ...(has("backoff-max")
                    ? { maxMs: Number(flag("backoff-max")) }
                    : {}),
                  ...(has("backoff-factor")
                    ? { factor: Number(flag("backoff-factor")) }
                    : {}),
                  ...(has("no-jitter") ? { jitter: "none" as const } : {}),
                },
              }
            : {}),
          ...(has("on-failure")
            ? {
                onFailure:
                  flag("on-failure") === "skip"
                    ? ("skip" as const)
                    : ("block" as const),
              }
            : {}),
          ...(has("max-in-flight")
            ? { maxInFlight: Number(flag("max-in-flight")) }
            : {}),
          ...(has("quarantine-rate")
            ? {
                quarantine: {
                  deadRate: Number(flag("quarantine-rate")),
                  ...(has("quarantine-window")
                    ? { windowMs: Number(flag("quarantine-window")) }
                    : {}),
                  ...(has("quarantine-min")
                    ? { minDead: Number(flag("quarantine-min")) }
                    : {}),
                },
              }
            : {}),
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
    console.log(`\nrequeue with: bql bus dlq requeue <seq>`);
    break;
  }

  // Ordered subscriptions stall a key whose message dead-lettered rather than
  // letting the next one overtake it. These are the two things an operator can
  // do about that: look, and decide.
  case "blocked": {
    const bus = await client();
    const subscription = flag("subscription", argv[1]) as string;
    if (!subscription) throw new Error("blocked wants a subscription name");
    const keys = await bus.blockedKeys(subscription);
    if (keys.length === 0) {
      console.log(`no blocked keys on '${subscription}'`);
      break;
    }
    for (const blocked of keys)
      console.log(
        `${blocked.key.padEnd(24)} seq=${String(blocked.messageSeq).padEnd(8)} ${blocked.reason.slice(0, 80)}`,
      );
    console.log(
      `\nrequeue the dead letter to release a key, or: bql bus unblock ${subscription} <key>`,
    );
    break;
  }

  case "unblock": {
    const bus = await client();
    const subscription = flag("subscription", argv[1]) as string;
    const key = flag("key", argv[2]) as string;
    if (!subscription || !key)
      throw new Error("unblock wants a subscription and a key");
    console.log(JSON.stringify(await bus.unblock(subscription, key)));
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
    console.log(`bql bus — a durable message bus for agents and ordinary work

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
  blocked     <subscription>              keys an ordered subscription is stalled on
  unblock     <subscription> <key>        let one blocked key move again
  schema      register <name> <file>      register a JSON Schema version
              check <name> <file>          dry-run the compatibility check
              bind <pattern> <name>        bind a subject pattern, --mode enforce|warn|off
              list · bindings              what is registered, and what is bound
  keys        rotate · retire <kid>       signing keys, with an overlap window
  revoke      <jti>                       revoke one token by its id
  quota       [set --messages --bytes]    per-workspace ceilings
  audit       who did what, most recent first
  follow      <upstream>                  replicate the log into --data
  promote     --lease <path>              take the leader role, fenced by an epoch
  cluster     role, epoch and replication lag
  backup      <dir>                       consistent copy of the database and blobs
  restore     <dir> --data <dir>          restore that copy, and prove it opens
              --until-seq N | --until-time  point-in-time: cut the log off there
  tail        follow the log
  stats       subscriptions, consumers, lag

Common flags:
  --url <url>          bus base URL (BUS_URL)
  --state <dir>        signing key and admin token (default .bql-bus)
  --workspace <name>   tenancy (default "default")
  --port --host --db --blobs           serve
  --log-level <level>  debug|info|warn|error|silent (BUS_LOG_LEVEL)
  --log-format <fmt>   text|json (BUS_LOG_FORMAT)
  --publish a.b,c.>    token: subject patterns it may publish to
  --subscribe name     token: subscriptions it may claim from
  --data <dir>         one directory: keys, database, WAL and blobs
  --lease <path>       serve: stop writing once another node wins this lease
  --otlp-endpoint <u>  serve: export spans as OTLP/HTTP
  --publish-rate <n>   serve: publishes per token per second (0 is off)
  --claim-rate <n>     serve: claims per token per second (0 is off)
  --max-polls <n>      serve: concurrent long polls one token may hold
  --min-free-bytes <n> serve: refuse publishes (507) below this much free disk
  --wal-checkpoint-bytes <n>  serve: truncate the WAL once it passes this
  --synchronous <mode> serve: FULL (default) or NORMAL — see the soak note

Examples:
  bql bus subscribe work 'work.>' --ordered
  bql bus consume work --exec ./handle.sh --prefetch 4
  bql bus publish work.resize '{"src":"a.png"}' --key a.png`);
    if (command !== "help" && command !== "--help") process.exit(1);
}

export {};
