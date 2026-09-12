import { test, expect } from "bun:test";
import { execute } from "../src/worker/executors";
import type { Claim } from "../src/shared/protocol";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
const claim: Claim = {
  run: {
    id: "r",
    title: "slug",
    brief: "slugify",
    mode: "demo",
    status: "running",
    requestKey: "k",
    createdAt: 0,
    updatedAt: 0,
  },
  task: {
    id: "t",
    runId: "r",
    role: "creator",
    status: "running",
    workerId: "w",
    generation: 1,
    leaseUntil: 100000,
    attempt: 1,
    inputArtifactId: null,
    outputArtifactId: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  },
  artifact: null,
};
test("demo code passes real subprocess tests and broken code fails", async () => {
  const result = await execute(
    claim,
    () => Promise.resolve(),
    new AbortController().signal,
    0,
  );
  expect(result.ok).toBe(true);
  const tester: Claim = {
    ...claim,
    task: { ...claim.task, role: "tester" },
    artifact: {
      id: "a",
      runId: "r",
      taskId: "t",
      name: result.name,
      mediaType: result.mediaType,
      content: result.content,
      digest: "hash",
      createdAt: 0,
    },
  };
  const good = await execute(
    tester,
    () => Promise.resolve(),
    new AbortController().signal,
    0,
  );
  expect(good.ok).toBe(true);
  expect(good.content).toContain("6 pass");
  tester.artifact!.content =
    "export function slugify(input: string) { return input; }";
  const bad = await execute(
    tester,
    () => Promise.resolve(),
    new AbortController().signal,
    0,
  );
  expect(bad.ok).toBe(false);
  expect(bad.content).toContain("fail");
});
test("successful artifact survives an unavailable observation endpoint", async () => {
  const result = await execute(
    claim,
    () => Promise.reject(new Error("Network unavailable")),
    new AbortController().signal,
    0,
  );
  expect(result.ok).toBe(true);
  expect(result.content).toContain("export function slugify");
});
test("cancelling a provider terminates its process group and settles execution", async () => {
  const dir = await mkdtemp(`${tmpdir()}/agenticbus-cancel-test-`);
  const old = process.env.CLAUDE_BIN;
  const script = `${dir}/provider.sh`;
  await Bun.write(
    script,
    `#!/bin/sh\nsleep 60 &\necho $! > '${dir}/child.pid'\nwait\n`,
  );
  await chmod(script, 0o700);
  process.env.CLAUDE_BIN = script;
  const control = new AbortController();
  const pending = execute(
    { ...claim, run: { ...claim.run, mode: "live" } },
    () => Promise.resolve(),
    control.signal,
    0,
  ).then(
    () => "finished",
    () => "cancelled",
  );
  try {
    for (
      let i = 0;
      i < 100 && !(await Bun.file(`${dir}/child.pid`).exists());
      i++
    )
      await Bun.sleep(10);
    const pid = Number(await Bun.file(`${dir}/child.pid`).text());
    control.abort("Operator cancelled");
    const outcome = await Promise.race([
      pending,
      Bun.sleep(2500).then(() => "stuck"),
    ]);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, "SIGKILL");
    expect(outcome).toBe("cancelled");
    expect(alive).toBe(false);
  } finally {
    if (old === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = old;
    await rm(dir, { recursive: true, force: true });
  }
});
