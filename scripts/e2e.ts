import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BusStore } from "../src/server/store";
import { createServer } from "../src/server/server";
import { DEFAULT_BRIEF, type Snapshot } from "../src/shared/protocol";
import assert from "node:assert/strict";

const dir = await mkdtemp(`${tmpdir()}/agenticbus-e2e-`),
  token = crypto.randomUUID();
let store = new BusStore(`${dir}/bus.sqlite`, Date.now, 1000);
let server = createServer({ store, port: 0, token });
const port = server.port!;
const base = `http://127.0.0.1:${port}`;
const children: ReturnType<typeof Bun.spawn>[] = [];
const spawn = (role: string, id: string, delay = "0") => {
  const p = Bun.spawn(
    [
      process.execPath,
      "src/worker/runner.ts",
      "--role",
      role,
      "--mode",
      "demo",
      "--id",
      id,
    ],
    {
      env: {
        ...process.env,
        BUS_URL: base,
        BUS_TOKEN: token,
        BUS_SPOOL: `${dir}/spool`,
        DEMO_DELAY_MS: delay,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(p);
  return p;
};
async function post(path: string, data: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  const body = await r.json();
  assert.ok(r.ok, JSON.stringify(body));
  return body;
}
async function until(predicate: (s: Snapshot) => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    store.recover();
    const s = (await (await fetch(`${base}/api/snapshot`)).json()) as Snapshot;
    if (predicate(s)) return s;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const run = await post("/api/runs", {
    title: "End-to-end recovery check",
    brief: DEFAULT_BRIEF,
    mode: "demo",
    requestKey: "e2e-request",
  });
  const dying = spawn("creator", "creator-interrupted", "5000");
  await until(
    (s) => s.tasks.some((t) => t.role === "creator" && t.status === "running"),
    "creator claim",
  );
  dying.kill("SIGKILL");
  await dying.exited;
  console.log("PASS: creator claimed via HTTP, then process was killed");
  spawn("creator", "creator-replacement");
  spawn("reviewer", "reviewer-e2e");
  spawn("tester", "tester-e2e");
  const ready = await until(
    (s) => s.runs.find((r) => r.id === run.id)?.status === "waiting_approval",
    "review/test join",
  );
  const tasks = ready.tasks.filter((t) => t.runId === run.id);
  assert.ok(tasks.every((t) => t.status === "succeeded"));
  assert.equal(tasks.find((t) => t.role === "creator")!.attempt, 2);
  assert.equal(
    tasks.find((t) => t.role === "reviewer")!.inputArtifactId,
    tasks.find((t) => t.role === "tester")!.inputArtifactId,
  );
  const testArtifact = store.artifact(
    tasks.find((t) => t.role === "tester")!.outputArtifactId!,
  );
  assert.match(testArtifact.content, /6 pass/);
  console.log(
    "PASS: lease recovered, replacement finished, review and six executable tests joined on the same artifact",
  );
  const hook = {
    id: "same-observation",
    source: "urn:e2e:hook",
    type: "PostToolUse",
    data: { tool_name: "Bash", tool_result: "ok" },
  };
  await post("/api/hooks", hook);
  const duplicate = await post("/api/hooks", hook);
  assert.equal(duplicate.duplicate, true);
  console.log("PASS: duplicate hook observation deduplicated");
  server.stop(true);
  store.close();
  store = new BusStore(`${dir}/bus.sqlite`);
  server = createServer({ store, port, token });
  const persisted = (await (
    await fetch(`${base}/api/snapshot`)
  ).json()) as Snapshot;
  assert.equal(persisted.runs[0].status, "waiting_approval");
  const accepted = await post(`/api/runs/${run.id}/approve`, {});
  assert.equal(accepted.status, "succeeded");
  console.log(
    "PASS: coordinator reopened persisted state; approval completed over HTTP",
  );
  console.log("End-to-end prototype checks passed.");
} finally {
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(
    children.map(async (p) => {
      await Promise.race([p.exited, Bun.sleep(2500)]);
      if (p.exitCode === null) p.kill("SIGKILL");
      await p.exited;
    }),
  );
  server.stop(true);
  store.close();
  await rm(dir, { recursive: true, force: true });
}
