import { afterAll, expect, test } from "bun:test";
import type { StepContext } from "dagr";
import { BrokerStore } from "../src/broker/store";
import { createBroker } from "../src/broker/server";
import { generateKey } from "../src/broker/tokens";
import { remoteExecutor, RemoteStepError } from "../src/executor/remote";

const adminToken = generateKey();
const store = new BrokerStore(":memory:", { leaseMs: 60_000 });
const server = createBroker({
  store,
  signingKey: generateKey(),
  adminToken,
  port: 0,
  hostname: "127.0.0.1",
});
const executor = remoteExecutor({
  broker: `http://127.0.0.1:${server.port}`,
  token: adminToken,
  pollMs: 10,
});

afterAll(() => {
  server.stop(true);
  store.close();
});

const logged: string[] = [];
function context(overrides: Partial<StepContext> = {}): StepContext {
  return {
    runId: "run-1",
    stepKey: "review",
    stepId: "step-1",
    idempotencyKey: `run-1:${overrides.stepKey ?? "review"}`,
    attempt: 1,
    input: { run: "bun", select: { pool: "general" }, input: { text: "hi" } },
    signal: new AbortController().signal,
    logger: {
      info: (message) => logged.push(message),
      warn: () => {},
      error: () => {},
    },
    secrets: { get: () => undefined },
    heartbeat: () => {},
    setCheckpoint: async () => {},
    ...overrides,
  } as StepContext;
}

const claimAs = async (workerId: string) => {
  store.register({
    id: workerId,
    name: workerId,
    host: "test",
    runtimes: ["bun"],
    labels: { pool: "general" },
  });
  return store.claim(workerId)!;
};

test("a remote step needs an inner runtime", async () => {
  await expect(
    executor.run(context({ input: { select: {} } })),
  ).rejects.toThrow(/needs `with.run`/);
});

test("a remote step cannot dispatch to itself", async () => {
  await expect(
    executor.run(context({ input: { run: "remote" } })),
  ).rejects.toThrow(/cannot dispatch to itself/);
});

test("the step dispatches, waits, and returns the worker's value and usage", async () => {
  const checkpoints: unknown[] = [];
  const running = executor.run(
    context({
      stepKey: "happy",
      idempotencyKey: "run-1:happy",
      setCheckpoint: async (value) => {
        checkpoints.push(value);
      },
    }),
  );

  const claim = await waitFor(() => store.byKey("run-1:happy"));
  const held = await claimAs("worker-a");
  store.complete(held.task.id, {
    workerId: "worker-a",
    generation: held.task.generation,
    ok: true,
    value: { slug: "hi" },
    usage: { costMicros: 250 },
  });

  const result = await running;
  expect(result.value).toEqual({ slug: "hi" });
  expect(result.usage).toEqual({ costMicros: 250 });
  expect(checkpoints).toEqual([{ taskId: claim.id }]);
  expect(logged.some((line) => line.includes("dispatched remote task"))).toBe(
    true,
  );
});

test("a remote failure surfaces as a throw dagr can classify and retry", async () => {
  const running = executor.run(
    context({ stepKey: "sad", idempotencyKey: "run-1:sad" }),
  );
  await waitFor(() => store.byKey("run-1:sad"));
  const held = await claimAs("worker-a");
  store.complete(held.task.id, {
    workerId: "worker-a",
    generation: held.task.generation,
    ok: false,
    error: "handler exploded",
    fatal: true,
  });
  await expect(running).rejects.toThrow(RemoteStepError);
});

test("a reclaimed attempt reattaches instead of dispatching a second copy", async () => {
  // First attempt dispatches and then "crashes" — we simply stop waiting.
  const first = executor.run(
    context({ stepKey: "crash", idempotencyKey: "run-1:crash" }),
  );
  const task = await waitFor(() => store.byKey("run-1:crash"));
  const held = await claimAs("worker-a");

  // The engine restarts and re-runs the step with the checkpoint it kept.
  const second = executor.run(
    context({
      stepKey: "crash",
      idempotencyKey: "run-1:crash",
      attempt: 2,
      checkpoint: { taskId: task.id },
    }),
  );
  store.complete(held.task.id, {
    workerId: "worker-a",
    generation: held.task.generation,
    ok: true,
    value: { resumed: true },
  });

  expect((await second).value).toEqual({ resumed: true });
  expect((await first).value).toEqual({ resumed: true });
  // One task, one remote execution, despite two engine attempts.
  expect(
    store.tasks().filter((t) => t.idempotencyKey === "run-1:crash"),
  ).toHaveLength(1);
});

test("aborting the step asks the broker to cancel the remote task", async () => {
  const abort = new AbortController();
  const running = executor.run(
    context({
      stepKey: "cancel",
      idempotencyKey: "run-1:cancel",
      signal: abort.signal,
    }),
  );
  const task = await waitFor(() => store.byKey("run-1:cancel"));
  abort.abort(new Error("engine cancelled"));
  await expect(running).rejects.toThrow();
  await waitFor(() => (store.task(task.id).cancelRequested ? task : null));
  expect(store.task(task.id).cancelRequested).toBe(true);
});

async function waitFor<T>(read: () => T | null, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for state");
    await Bun.sleep(5);
  }
}
