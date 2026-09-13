/**
 * Pre-merge gate: start a dagr workflow whose steps run on the fleet, stream
 * what happens to the CI log, and exit with a status CI can branch on.
 *
 *   ENGINE_URL=https://bus.internal:4318 BUS_ADMIN_TOKEN=… \
 *     bun examples/ci-gate.ts --workflow review --input '{"sha":"abc123"}'
 *
 * Exit codes: 0 succeeded, 1 failed or cancelled, 2 waiting on a person,
 * 3 timed out.
 */
const flag = (name: string, fallback = "") => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
};

const state = process.env.BUS_STATE ?? ".agenticbus";
const token =
  process.env.BUS_ADMIN_TOKEN ??
  (await Bun.file(`${state}/admin-token`).text()).trim();
const base = (process.env.ENGINE_URL ?? "http://127.0.0.1:4318").replace(
  /\/$/,
  "",
);

const call = async (path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-dagr-workspace": flag("workspace", "default"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${path} -> HTTP ${response.status} ${JSON.stringify(payload)}`);
  return payload as Record<string, unknown>;
};

// The commit SHA is the idempotency key, so re-running the same CI job reuses
// the run rather than paying for a second set of remote steps.
const sha =
  flag("key") ||
  (await Bun.$`git rev-parse HEAD`.quiet().nothrow()).stdout.toString().trim() ||
  crypto.randomUUID();
const deadline = Date.now() + Number(flag("timeout", "900")) * 1000;

const started = await call("/runs", {
  workflow: flag("workflow", "remote-slug"),
  input: JSON.parse(flag("input", "{}")),
  idempotencyKey: sha,
});
const runId = String(started.id);
console.log(`run ${runId} key=${sha.slice(0, 12)}`);

const seen = new Set<string>();
for (;;) {
  const detail = (await call(`/runs/${runId}/steps`)) as {
    steps?: {
      stepKey: string;
      status: string;
      waitEvent: string | null;
      error?: { message?: string } | null;
    }[];
  };
  for (const step of detail.steps ?? []) {
    const line = `${step.stepKey}:${step.status}`;
    if (seen.has(line)) continue;
    seen.add(line);
    console.log(
      `  ${step.status.padEnd(11)} ${step.stepKey}${
        step.error?.message ? ` — ${step.error.message}` : ""
      }`,
    );
  }

  const current = (await call(`/runs/${runId}`)) as {
    run?: { status?: string; output?: unknown };
  };
  const status = String(current.run?.status ?? "running");

  if (!["running", "queued", "pending"].includes(status)) {
    if (current.run?.output != null)
      console.log(`output ${JSON.stringify(current.run.output)}`);
    console.log(`run ${status}`);
    process.exit(status === "succeeded" ? 0 : 1);
  }

  // A parked human gate is not a failure; it is a different answer, and CI
  // should say "waiting on a person" rather than "broken".
  const gate = detail.steps?.find(
    (step) => step.status === "waiting" && step.waitEvent,
  );
  if (gate && !process.argv.includes("--wait-for-approval")) {
    console.log(`waiting on approval: ${gate.waitEvent}`);
    process.exit(2);
  }

  if (Date.now() > deadline) {
    console.error("timed out waiting for the run to settle");
    process.exit(3);
  }
  await Bun.sleep(2000);
}

export {};
