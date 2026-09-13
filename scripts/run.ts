/**
 * Start a workflow and watch it settle — the CLI face of dagr's control plane,
 * which `agenticbus serve` mounts behind the admin token.
 *
 *   bun scripts/run.ts remote-slug '{"text":"Crème brûlée"}'
 */
const [workflow, rawInput] = process.argv.slice(2);
if (!workflow) {
  console.error('usage: bun scripts/run.ts <workflow> [json-input]');
  process.exit(2);
}

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
      "x-dagr-workspace": "default",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${path} -> HTTP ${response.status} ${JSON.stringify(payload)}`,
    );
  return payload as Record<string, unknown>;
};

const run = await call("/runs", {
  workflow,
  input: rawInput ? JSON.parse(rawInput) : {},
  idempotencyKey: `cli-${Date.now()}`,
});
const runId = String(run.id);
console.log(`run ${runId}`);

const seen = new Set<string>();
for (;;) {
  const detail = (await call(`/runs/${runId}/steps`)) as {
    steps?: {
      stepKey: string;
      status: string;
      waitEvent: string | null;
      correlation: string | null;
      error?: unknown;
    }[];
  };
  for (const step of detail.steps ?? []) {
    const line = `${step.stepKey}:${step.status}`;
    if (seen.has(line)) continue;
    seen.add(line);
    console.log(`  ${step.status.padEnd(12)} ${step.stepKey}`);
    // A parked gate needs a person. Print the exact command rather than making
    // them go and find it.
    if (step.status === "waiting" && step.waitEvent)
      console.log(
        `    approve with: curl -sX POST ${base}/signals ` +
          `-H "authorization: Bearer $ADMIN" -H "x-dagr-workspace: default" ` +
          `-H 'content-type: application/json' ` +
          `-d '${JSON.stringify({ name: step.waitEvent, correlation: step.correlation })}'`,
      );
  }
  const current = (await call(`/runs/${runId}`)) as {
    run?: { status?: string; output?: unknown };
  };
  const status = String(current.run?.status ?? "running");
  if (!["running", "queued", "pending"].includes(status)) {
    if (current.run?.output !== undefined && current.run.output !== null)
      console.log(`output ${JSON.stringify(current.run.output)}`);
    console.log(`run ${status}`);
    process.exit(status === "succeeded" ? 0 : 1);
  }
  await Bun.sleep(1000);
}

export {};
