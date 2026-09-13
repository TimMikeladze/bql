import { expect, test } from "bun:test";
import { BrokerStore, matches } from "../src/broker/store";
import type { DispatchRequest } from "../src/shared/protocol";

let clock = 1_000_000;
const now = () => clock;
const store = () => new BrokerStore(":memory:", { now, leaseMs: 1000 });

const request = (
  overrides: Partial<DispatchRequest> = {},
): DispatchRequest => ({
  idempotencyKey: "run-1:step-a",
  runtime: "bun",
  selector: { pool: "general" },
  input: { text: "hello" },
  runId: "run-1",
  stepKey: "step-a",
  attempt: 1,
  maxAttempts: 3,
  deadlineAt: null,
  provider: null,
  workspace: "default",
  ...overrides,
});

const worker = (
  bus: BrokerStore,
  id = "worker-a",
  runtimes = ["bun"],
  labels = { pool: "general" },
) => bus.register({ id, name: id, host: "test", runtimes, labels });

test("selector entries must all match the worker's labels", () => {
  expect(matches({}, { pool: "general" })).toBe(true);
  expect(matches({ pool: "general" }, { pool: "general", gpu: "1" })).toBe(true);
  expect(matches({ pool: "gpu" }, { pool: "general" })).toBe(false);
  expect(matches({ pool: "gpu" }, {})).toBe(false);
});

test("dispatch is idempotent on the engine's key", () => {
  const bus = store();
  const first = bus.dispatch(request());
  const second = bus.dispatch(request());
  expect(second.id).toBe(first.id);
  expect(bus.tasks()).toHaveLength(1);
  bus.close();
});

test("a claim fences: only one worker gets the task", () => {
  const bus = store();
  bus.dispatch(request());
  worker(bus, "worker-a");
  worker(bus, "worker-b");
  const first = bus.claim("worker-a");
  const second = bus.claim("worker-b");
  expect(first?.task.workerId).toBe("worker-a");
  expect(second).toBeNull();
  bus.close();
});

test("a worker whose labels do not match is not offered the task", () => {
  const bus = store();
  bus.dispatch(request({ selector: { pool: "gpu" } }));
  worker(bus, "worker-a", ["bun"], { pool: "general" });
  expect(bus.claim("worker-a")).toBeNull();
  bus.close();
});

test("a worker without the runtime is not offered the task", () => {
  const bus = store();
  bus.dispatch(request({ runtime: "python" }));
  worker(bus, "worker-a", ["bun"]);
  expect(bus.claim("worker-a")).toBeNull();
  bus.close();
});

test("an expired lease returns the task to the queue for another worker", () => {
  const bus = store();
  bus.dispatch(request());
  worker(bus, "worker-a");
  worker(bus, "worker-b");
  const claim = bus.claim("worker-a")!;
  clock += 5000;
  bus.reclaim();
  expect(bus.task(claim.task.id).status).toBe("queued");
  const second = bus.claim("worker-b")!;
  expect(second.task.workerId).toBe("worker-b");
  expect(second.task.generation).toBeGreaterThan(claim.task.generation);
  bus.close();
});

test("a stale generation cannot complete a task someone else now holds", () => {
  const bus = store();
  bus.dispatch(request());
  worker(bus, "worker-a");
  worker(bus, "worker-b");
  const stale = bus.claim("worker-a")!;
  clock += 5000;
  bus.reclaim();
  bus.claim("worker-b");
  expect(() =>
    bus.complete(stale.task.id, {
      workerId: "worker-a",
      generation: stale.task.generation,
      ok: true,
      value: { slug: "hello" },
    }),
  ).toThrow(/stale task lease/);
  bus.close();
});

test("lease expiry past maxAttempts fails the task instead of looping", () => {
  const bus = store();
  bus.dispatch(request({ maxAttempts: 2 }));
  worker(bus, "worker-a");
  for (let round = 0; round < 2; round++) {
    bus.claim("worker-a");
    clock += 5000;
    bus.reclaim();
  }
  const task = bus.tasks()[0];
  expect(task.status).toBe("failed");
  expect(task.error).toMatch(/lease expired/);
  bus.close();
});

test("replaying the same completion is accepted, a different one conflicts", () => {
  const bus = store();
  bus.dispatch(request());
  worker(bus, "worker-a");
  const claim = bus.claim("worker-a")!;
  const completion = {
    workerId: "worker-a",
    generation: claim.task.generation,
    ok: true,
    value: { slug: "hello" },
  };
  expect(bus.complete(claim.task.id, completion).status).toBe("succeeded");
  expect(bus.complete(claim.task.id, completion).status).toBe("succeeded");
  expect(() =>
    bus.complete(claim.task.id, { ...completion, value: { slug: "other" } }),
  ).toThrow(/completion conflict/);
  bus.close();
});

test("a retryable failure requeues, a fatal one does not", () => {
  const bus = store();
  bus.dispatch(request());
  worker(bus, "worker-a");
  const first = bus.claim("worker-a")!;
  expect(
    bus.complete(first.task.id, {
      workerId: "worker-a",
      generation: first.task.generation,
      ok: false,
      error: "transient",
    }).status,
  ).toBe("queued");

  const second = bus.claim("worker-a")!;
  expect(
    bus.complete(second.task.id, {
      workerId: "worker-a",
      generation: second.task.generation,
      ok: false,
      error: "no executor",
      fatal: true,
    }).status,
  ).toBe("failed");
  bus.close();
});

test("usage from the worker is preserved for the engine to account", () => {
  const bus = store();
  bus.dispatch(request());
  worker(bus, "worker-a");
  const claim = bus.claim("worker-a")!;
  bus.complete(claim.task.id, {
    workerId: "worker-a",
    generation: claim.task.generation,
    ok: true,
    value: null,
    usage: { costMicros: 4200, inputTokens: 10 },
  });
  expect(bus.task(claim.task.id).usage).toEqual({
    costMicros: 4200,
    inputTokens: 10,
  });
  expect(bus.usageTotals().costMicros).toBe(4200);
  bus.close();
});

test("cancelling a queued task settles it; a running one is asked to stop", () => {
  const bus = store();
  bus.dispatch(request());
  expect(bus.cancel(bus.tasks()[0].id).status).toBe("cancelled");

  const second = bus.dispatch(request({ idempotencyKey: "run-1:step-b" }));
  worker(bus, "worker-a");
  bus.claim("worker-a");
  const cancelled = bus.cancel(second.id);
  expect(cancelled.status).toBe("running");
  expect(cancelled.cancelRequested).toBe(true);
  expect(
    bus.heartbeat(second.id, "worker-a", bus.task(second.id).generation)
      .cancelRequested,
  ).toBe(true);
  bus.close();
});

test("redispatching a cancelled key starts fresh rather than wedging", () => {
  const bus = store();
  const task = bus.dispatch(request());
  bus.cancel(task.id);
  const again = bus.dispatch(request({ attempt: 2 }));
  expect(again.id).toBe(task.id);
  expect(again.status).toBe("queued");
  expect(again.cancelRequested).toBe(false);
  bus.close();
});

test("a deadline in the past fails the task instead of dispatching it", () => {
  const bus = store();
  bus.dispatch(request({ deadlineAt: clock - 1 }));
  worker(bus, "worker-a");
  expect(bus.claim("worker-a")).toBeNull();
  expect(bus.tasks()[0].status).toBe("failed");
  bus.close();
});

test("a checkpoint survives for the next attempt to read", () => {
  const bus = store();
  bus.dispatch(request());
  worker(bus, "worker-a");
  const claim = bus.claim("worker-a")!;
  bus.checkpoint(claim.task.id, "worker-a", claim.task.generation, {
    sessionId: "abc",
  });
  clock += 5000;
  bus.reclaim();
  const second = bus.claim("worker-a")!;
  expect(second.task.checkpoint).toEqual({ sessionId: "abc" });
  bus.close();
});

test("a paused worker is offered nothing", () => {
  const bus = store();
  bus.dispatch(request());
  worker(bus, "worker-a");
  bus.pause("worker-a", true);
  expect(bus.claim("worker-a")).toBeNull();
  bus.pause("worker-a", false);
  expect(bus.claim("worker-a")).not.toBeNull();
  bus.close();
});

test("summaries withhold input, result and checkpoint payloads", () => {
  const bus = store();
  bus.dispatch(request());
  const summary = bus.tasks()[0] as Record<string, unknown>;
  expect(summary.input).toBeUndefined();
  expect(summary.value).toBeUndefined();
  expect(summary.checkpoint).toBeUndefined();
  expect(summary.stepKey).toBe("step-a");
  bus.close();
});

test("a deadline that passes mid-flight fails the task on the sweep", () => {
  const bus = store();
  bus.dispatch(request({ deadlineAt: clock + 1000 }));
  worker(bus, "worker-a");
  const claim = bus.claim("worker-a")!;
  expect(bus.expireDeadlines()).toBe(0);
  clock += 2000;
  expect(bus.expireDeadlines()).toBe(1);
  const task = bus.task(claim.task.id);
  expect(task.status).toBe("failed");
  expect(task.error).toMatch(/deadline/);
  bus.close();
});

test("readiness counts only workers that checked in recently", () => {
  const bus = store();
  worker(bus, "worker-a");
  expect(bus.liveWorkers()).toBe(1);
  clock += 120_000;
  expect(bus.liveWorkers()).toBe(0);
  bus.close();
});
