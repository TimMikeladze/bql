/**
 * End-to-end proof, with real processes and no mocks.
 *
 * Starts the engine host and two worker processes, runs a workflow whose steps
 * execute remotely, kills the worker holding a step mid-flight, and checks that
 * a different machine finishes the work and the run still settles. Then drives
 * the human gate over HTTP.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKey, mint } from "../src/broker";

const scratch = await mkdtemp(`${tmpdir()}/agenticbus-e2e-`);
const signingKey = generateKey();
const adminToken = generateKey();
/** Take a free port rather than gambling on a random one. */
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

const brokerPort = await freePort(4400);
const enginePort = await freePort(brokerPort + 1);
const brokerUrl = `http://127.0.0.1:${brokerPort}`;
const engineUrl = `http://127.0.0.1:${enginePort}`;

const children: ReturnType<typeof Bun.spawn>[] = [];
const env = {
  ...process.env,
  BUS_SIGNING_KEY: signingKey,
  BUS_ADMIN_TOKEN: adminToken,
};
const spawn = (args: string[], extra: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, ...args], {
    env: { ...env, ...extra },
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

const api = async (
  base: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> => {
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

const workerToken = (id: string) =>
  mint(
    {
      sub: id,
      scope: "worker",
      runtimes: ["bun"],
      labels: { pool: "general" },
      exp: 0,
    },
    signingKey,
  );

const workers = new Map<string, ReturnType<typeof Bun.spawn>>();
const startWorker = (id: string) => {
  const child = spawn(
    [
      "src/cli/index.ts",
      "worker",
      "--id",
      id,
      "--broker",
      brokerUrl,
      "--runtimes",
      "bun",
      "--labels",
      "pool=general",
      "--jobs",
      "./tests/fixtures/jobs",
      "--spool",
      `${scratch}/outbox-${id}`,
    ],
    { BUS_TOKEN: workerToken(id) },
  );
  workers.set(id, child);
  return child;
};

try {
  spawn([
    "src/cli/index.ts",
    "serve",
    "--state",
    scratch,
    "--port",
    String(brokerPort),
    "--engine-port",
    String(enginePort),
    "--workflows",
    "./tests/fixtures/workflows",
    "--lease-ms",
    "2500",
    "--engine-db",
    `${scratch}/dagr.db`,
    "--broker-db",
    `${scratch}/bus.db`,
  ]);

  await waitFor("the host to listen", async () =>
    (await fetch(`${brokerUrl}/health`)).ok ? true : null,
  );
  await waitFor("the control plane to listen", async () =>
    (await fetch(`${engineUrl}/health`)).ok ? true : null,
  );
  check("engine host and broker are up", true);

  startWorker("worker-a");
  startWorker("worker-b");
  const fleet = await waitFor("both workers to register", async () => {
    const snapshot = (await api(brokerUrl, "/api/snapshot")) as {
      workers: { id: string }[];
    };
    return snapshot.workers.length === 2 ? snapshot.workers : null;
  });
  check("two independent worker processes registered", fleet.length === 2);

  const run = await api(engineUrl, "/runs", {
    workflow: "e2e",
    // Long enough that the worker is genuinely mid-step when it is killed.
    input: { text: "Crème brûlée", ms: 8000 },
    idempotencyKey: `e2e-${Date.now()}`,
  });
  const runId = String(run.id);

  // Kill whichever worker takes the first step, mid-flight.
  const firstTask = await waitFor("a worker to claim the first step", async () => {
    const snapshot = (await api(brokerUrl, "/api/snapshot")) as {
      tasks: { id: string; status: string; workerId: string | null; stepKey: string }[];
    };
    return (
      snapshot.tasks.find(
        (task) => task.status === "running" && task.workerId !== null,
      ) ?? null
    );
  });
  const victim = workers.get(firstTask.workerId ?? "");
  victim?.kill("SIGKILL");
  check(
    `killed ${firstTask.workerId} while it held ${firstTask.stepKey}`,
    victim !== undefined,
  );

  const recovered = await waitFor(
    "the lease to expire and another worker to finish the step",
    async () => {
      const snapshot = (await api(brokerUrl, "/api/snapshot")) as {
        tasks: { id: string; status: string; workerId: string | null; attempt: number }[];
        events: { type: string }[];
      };
      const task = snapshot.tasks.find((entry) => entry.id === firstTask.id);
      return task?.status === "succeeded" && task.workerId !== firstTask.workerId
        ? { task, events: snapshot.events }
        : null;
    },
  );
  check(
    "a surviving worker recovered the expired lease",
    recovered.task.attempt >= 2,
    `attempt ${recovered.task.attempt}, now on ${recovered.task.workerId}`,
  );
  check(
    "the journal recorded the lease expiry",
    recovered.events.some((event) => event.type.includes("lease_expired")),
  );

  // The workflow's gate is a dagr approval step: the run parks until signalled.
  await waitFor("the run to reach its human gate", async () => {
    const steps = (await api(engineUrl, `/runs/${runId}/steps`)) as {
      steps?: { stepKey: string; status: string }[];
    };
    const gate = steps.steps?.find((step) => step.stepKey === "gate");
    return gate && ["waiting", "parked", "running"].includes(gate.status)
      ? gate
      : null;
  });
  check("the run parked on its approval gate", true);

  await api(engineUrl, "/signals", {
    name: "e2e.approved",
    correlation: runId,
    payload: { approvedBy: "e2e" },
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
    "the run succeeded end to end",
    settled.status === "succeeded",
    String(settled.status),
  );
  check(
    "the workflow output carries the remote result",
    JSON.stringify(settled.output ?? {}).includes("creme-brulee"),
    JSON.stringify(settled.output ?? null),
  );

  const steps = (await api(engineUrl, `/runs/${runId}/steps`)) as {
    steps?: { stepKey: string; status: string; result?: unknown }[];
  };
  const slug = steps.steps?.find((step) => step.stepKey === "slow");
  check(
    "the remote handler produced the expected artifact",
    JSON.stringify(slug?.result ?? {}).includes("creme-brulee"),
    JSON.stringify(slug?.result ?? null),
  );

  const redispatch = await api(brokerUrl, "/api/tasks", {
    idempotencyKey: `${runId}:slow`,
    runtime: "bun",
    selector: { pool: "general" },
    input: {},
    runId,
    stepKey: "slow",
    attempt: 9,
    maxAttempts: 3,
    deadlineAt: null,
    provider: null,
    workspace: "default",
  });
  check(
    "re-dispatching a finished key reattaches instead of duplicating",
    redispatch.id === firstTask.id || redispatch.status === "succeeded",
  );
} catch (error) {
  check("e2e completed without an unexpected error", false, String(error));
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
console.log("\nall end-to-end checks passed");
