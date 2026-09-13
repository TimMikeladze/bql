#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { BrokerStore, createBroker, generateKey, mint } from "../broker";
import { remoteExecutor } from "../executor/remote";
import { startHost } from "../host/serve";
import { RemoteWorker, buildExecutors, workerSecrets } from "../worker";
import { ANY } from "../shared/protocol";

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
function list(name: string): string[] {
  const value = flag(name);
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
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
const has = (name: string) => argv.includes(`--${name}`);

/**
 * Secrets live in a file with 0600 permissions rather than in argv, where every
 * other process on the box can read them out of `ps`.
 */
async function loadOrCreate(path: string): Promise<string> {
  const file = Bun.file(path);
  if (await file.exists()) return (await file.text()).trim();
  const value = generateKey();
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, value, { mode: 0o600 });
  return value;
}

const stateDir = flag("state", ".agenticbus") as string;

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
    const host = await startHost({
      workflows: flag("workflows", "./workflows") as string,
      engineDb: flag("engine-db", `${stateDir}/dagr.db`) as string,
      ...(has("broker-url")
        ? { brokerUrl: flag("broker-url") as string }
        : { brokerDb: flag("broker-db", `${stateDir}/bus.db`) as string }),
      signingKey,
      adminToken,
      port: Number(flag("port", process.env.PORT ?? "4317")),
      hostname: flag("host", "127.0.0.1") as string,
      ...(has("engine-port") ? { enginePort: Number(flag("engine-port")) } : {}),
      httpAllow: list("http-allow"),
      ...(has("assets") ? { assets: flag("assets") as string } : { assets: "dist" }),
      ...(has("concurrency")
        ? { concurrency: Number(flag("concurrency")) }
        : {}),
      ...(has("lease-ms") ? { leaseMs: Number(flag("lease-ms")) } : {}),
    });
    console.log(
      `agenticbus broker   ${host.brokerUrl}${host.broker ? "" : "  (external)"}`,
    );
    console.log(
      `agenticbus engine   http://${host.control.hostname}:${host.control.port} (dagr control plane)`,
    );
    console.log(`admin token         ${stateDir}/admin-token`);
    shutdown(() => host.stop());
    break;
  }

  case "broker": {
    const { signingKey, adminToken } = await secrets();
    const store = new BrokerStore(flag("db", `${stateDir}/bus.db`) as string, {
      ...(has("lease-ms") ? { leaseMs: Number(flag("lease-ms")) } : {}),
    });
    const server = createBroker({
      store,
      signingKey,
      adminToken,
      port: Number(flag("port", process.env.PORT ?? "4317")),
      hostname: flag("host", "127.0.0.1") as string,
      ...(has("assets") ? { assets: flag("assets") as string } : {}),
    });
    const sweep = setInterval(() => store.sweep(), 1000);
    console.log(`broker http://${server.hostname}:${server.port}`);
    shutdown(() => {
      clearInterval(sweep);
      server.stop(true);
      store.close();
    });
    break;
  }

  case "worker": {
    const runtimes = list("runtimes");
    if (runtimes.length === 0)
      throw new Error(
        "--runtimes is required, e.g. --runtimes bun,shell (default-deny)",
      );
    const token = process.env.BUS_TOKEN;
    if (!token)
      throw new Error(
        "BUS_TOKEN is required. Mint one with: agenticbus token --worker <id>",
      );
    const id = flag("id", `${hostname()}-${runtimes.join("-")}`) as string;
    const worker = new RemoteWorker({
      id,
      ...(has("name") ? { name: flag("name") as string } : {}),
      broker: (flag("broker", process.env.BUS_URL ?? "http://127.0.0.1:4317") as string).replace(
        /\/$/,
        "",
      ),
      token,
      labels: pairs("labels"),
      executors: buildExecutors(runtimes, {
        shellAllow: list("shell-allow"),
        httpAllow: list("http-allow"),
        jobsDir: flag("jobs", "./jobs") as string,
        agentCwd: flag("agent-cwd", "./work") as string,
        agentCwdAllowlist: list("agent-cwd-allow"),
        agentPermissionModes: list("agent-permission-modes"),
        agentModelAllowlist: list("agent-models"),
        ...(has("prompt-model")
          ? { promptModel: flag("prompt-model") as string }
          : {}),
        ...(has("env-allow") ? { envAllowlist: list("env-allow") } : {}),
      }),
      secrets: workerSecrets(list("secrets")),
      ...(has("spool") ? { spool: flag("spool") as string } : {}),
    });
    shutdown(() => worker.stop());
    await worker.start();
    break;
  }

  case "token": {
    const { signingKey } = await secrets();
    const workerId = flag("worker");
    if (!workerId) throw new Error("--worker <id> is required");
    const ttl = Number(flag("ttl", "0"));
    const token = mint(
      {
        sub: workerId,
        scope: "worker",
        runtimes: list("runtimes").length > 0 ? list("runtimes") : [ANY],
        labels: pairs("labels"),
        exp: ttl === 0 ? 0 : Math.floor(Date.now() / 1000) + ttl,
      },
      signingKey,
    );
    console.log(token);
    break;
  }

  case "status": {
    const { adminToken } = await secrets();
    const base = flag("broker", process.env.BUS_URL ?? "http://127.0.0.1:4317");
    const response = await fetch(`${base}/api/snapshot`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!response.ok) throw new Error(`broker returned HTTP ${response.status}`);
    const snapshot = (await response.json()) as {
      workers: { id: string; runtimes: string[]; labels: Record<string, string>; lastSeen: number; paused: boolean }[];
      tasks: { id: string; runtime: string; status: string; stepKey: string }[];
      queueDepth: Record<string, number>;
      now: number;
    };
    console.log("workers");
    for (const worker of snapshot.workers)
      console.log(
        `  ${worker.id}  ${worker.runtimes.join(",")}  ${Object.entries(worker.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}  ${Math.round((snapshot.now - worker.lastSeen) / 1000)}s ago${
          worker.paused ? "  (paused)" : ""
        }`,
      );
    if (snapshot.workers.length === 0) console.log("  (none registered)");
    const depth = Object.entries(snapshot.queueDepth);
    console.log(
      `queue: ${depth.length === 0 ? "empty" : depth.map(([r, n]) => `${r}=${n}`).join(" ")}`,
    );
    for (const task of snapshot.tasks.slice(0, 15))
      console.log(`  ${task.status.padEnd(10)} ${task.runtime.padEnd(8)} ${task.stepKey}`);
    break;
  }

  default:
    console.log(`agenticbus — distributed execution for dagr workflows

  serve    dagr engine + broker in one process, or --broker-url for a split one
  broker   the broker alone (workers and the engine connect over HTTP)
  worker   a remote worker hosting dagr's runtimes
  token    mint a per-worker capability token
  status   fleet and queue readout

Common flags:
  --state <dir>        where the signing key and admin token live (default .agenticbus)
  --broker <url>       broker base URL (BUS_URL)
  --port, --host       listener
  --broker-url <url>   serve: dispatch into an external broker instead of embedding one
  --runtimes a,b       worker: which runtimes to host (default-deny, required)
  --labels k=v,k=v     worker: labels a step selector matches against
  --shell-allow, --http-allow, --agent-models, --secrets   per-runtime allowlists

Full documentation: README.md`);
    if (command !== "help" && command !== "--help") process.exit(1);
}

export {};
