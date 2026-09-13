/**
 * The split deployment, with real processes: a standalone broker, an engine
 * host that dispatches into it rather than embedding one, and a worker that
 * knows about neither database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKey, mint } from "../src/broker";

const scratch = await mkdtemp(`${tmpdir()}/agenticbus-split-`);
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

const brokerPort = await freePort(4700);
const hostPort = await freePort(brokerPort + 1);
const enginePort = await freePort(hostPort + 1);
const brokerUrl = `http://127.0.0.1:${brokerPort}`;
const engineUrl = `http://127.0.0.1:${enginePort}`;

const children: ReturnType<typeof Bun.spawn>[] = [];
const spawn = (args: string[], extra: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, ...args], {
    env: {
      ...process.env,
      BUS_SIGNING_KEY: signingKey,
      BUS_ADMIN_TOKEN: adminToken,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
};

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const api = async (base: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "x-dagr-workspace": "default",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${path} -> HTTP ${response.status} ${JSON.stringify(payload)}`);
  return payload as Record<string, unknown>;
};

async function waitFor<T>(
  label: string,
  read: () => Promise<T | null>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(250);
  }
}

try {
  spawn([
    "src/cli/index.ts",
    "broker",
    "--state",
    scratch,
    "--db",
    `${scratch}/bus.db`,
    "--port",
    String(brokerPort),
  ]);
  await waitFor("the standalone broker", async () =>
    (await fetch(`${brokerUrl}/health`)).ok ? true : null,
  );

  spawn([
    "src/cli/index.ts",
    "serve",
    "--state",
    scratch,
    "--broker-url",
    brokerUrl,
    "--port",
    String(hostPort),
    "--engine-port",
    String(enginePort),
    "--workflows",
    "./tests/fixtures/workflows",
    "--engine-db",
    `${scratch}/dagr.db`,
  ]);
  await waitFor("the engine host", async () =>
    (await fetch(`${engineUrl}/health`)).ok ? true : null,
  );
  check("a broker and an engine host started as separate processes", true);

  // The broker has no worker yet, so readiness must say so rather than lie.
  const notReady = await fetch(`${brokerUrl}/ready`);
  check("readiness fails while no worker has checked in", notReady.status === 503);

  spawn(
    [
      "src/cli/index.ts",
      "worker",
      "--id",
      "split-1",
      "--broker",
      brokerUrl,
      "--runtimes",
      "bun",
      "--labels",
      "pool=general",
      "--jobs",
      "./tests/fixtures/jobs",
      "--spool",
      `${scratch}/outbox`,
    ],
    {
      BUS_TOKEN: mint(
        {
          sub: "split-1",
          scope: "worker",
          runtimes: ["bun"],
          labels: { pool: "general" },
          exp: 0,
        },
        signingKey,
      ),
    },
  );
  await waitFor("the worker to reach the standalone broker", async () => {
    const snapshot = (await api(brokerUrl, "/api/snapshot")) as {
      workers: { id: string }[];
    };
    return snapshot.workers.length === 1 ? true : null;
  });
  check("the worker registered with the broker, not the engine host", true);
  check(
    "readiness passes once a worker is live",
    (await fetch(`${brokerUrl}/ready`)).ok,
  );

  const run = await api(engineUrl, "/runs", {
    workflow: "e2e",
    input: { text: "Split Deployment", ms: 100 },
    idempotencyKey: `split-${Date.now()}`,
  });
  const runId = String(run.id);

  await waitFor("the run to park on its gate", async () => {
    const steps = (await api(engineUrl, `/runs/${runId}/steps`)) as {
      steps?: { stepKey: string; status: string }[];
    };
    const gate = steps.steps?.find((step) => step.stepKey === "gate");
    return gate?.status === "waiting" ? gate : null;
  });
  await api(engineUrl, "/signals", {
    name: "e2e.approved",
    correlation: runId,
    payload: {},
  });

  const settled = await waitFor("the run to settle", async () => {
    const current = (await api(engineUrl, `/runs/${runId}`)) as {
      run?: { status?: string; output?: unknown };
    };
    const status = current.run?.status;
    return status && !["running", "queued", "pending"].includes(String(status))
      ? current.run!
      : null;
  });
  check(
    "the run succeeded across three separate processes",
    settled.status === "succeeded",
    String(settled.status),
  );
  check(
    "the output came back from the remote worker",
    JSON.stringify(settled.output ?? {}).includes("split-deployment"),
    JSON.stringify(settled.output ?? null),
  );
} catch (error) {
  check("split deployment completed without an unexpected error", false, String(error));
} finally {
  for (const child of children) child.kill("SIGTERM");
  await Bun.sleep(600);
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nsplit deployment checks passed");
