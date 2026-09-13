import { afterAll, expect, test } from "bun:test";
import { BrokerStore } from "../src/broker/store";
import { createBroker } from "../src/broker/server";
import { generateKey, mint } from "../src/broker/tokens";

const signingKey = generateKey();
const adminToken = generateKey();
const store = new BrokerStore(":memory:", { leaseMs: 1000 });
const server = createBroker({
  store,
  signingKey,
  adminToken,
  port: 0,
  hostname: "127.0.0.1",
});
const base = `http://127.0.0.1:${server.port}`;
const workerToken = mint(
  {
    sub: "worker-a",
    scope: "worker",
    runtimes: ["bun"],
    labels: { pool: "general" },
    exp: 0,
  },
  signingKey,
);

afterAll(() => {
  server.stop(true);
  store.close();
});

const call = (path: string, token: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const dispatch = (key: string, selector = { pool: "general" }) =>
  call("/api/tasks", adminToken, {
    idempotencyKey: key,
    runtime: "bun",
    selector,
    input: { text: "hello" },
    runId: "run-1",
    stepKey: key.split(":")[1] ?? "step",
    attempt: 1,
    maxAttempts: 3,
    deadlineAt: null,
    provider: null,
    workspace: "default",
  });

test("health needs no credential; the API does", async () => {
  expect((await fetch(`${base}/health`)).status).toBe(200);
  expect((await call("/api/snapshot", "")).status).toBe(401);
  expect((await call("/api/snapshot", "not-a-token")).status).toBe(401);
});

test("a worker token cannot dispatch, cancel or read the fleet", async () => {
  expect((await dispatch("run-1:step-a")).status).toBe(201);
  const task = await (await dispatch("run-1:step-a")).json();
  expect(
    (
      await call("/api/tasks", workerToken, {
        idempotencyKey: "x",
        runtime: "bun",
        selector: {},
        runId: "r",
        stepKey: "s",
        attempt: 1,
        maxAttempts: 1,
        deadlineAt: null,
        provider: null,
        workspace: "default",
      })
    ).status,
  ).toBe(403);
  expect(
    (await call(`/api/tasks/${task.id}/cancel`, workerToken, {})).status,
  ).toBe(403);
  expect((await call("/api/snapshot", workerToken)).status).toBe(403);
});

test("a worker registers, claims, heartbeats and completes", async () => {
  const registered = await call("/api/workers/register", workerToken, {
    id: "worker-a",
    name: "worker-a",
    host: "test",
    runtimes: ["bun"],
    labels: { pool: "general" },
  });
  expect(registered.status).toBe(200);

  const claim = await (
    await call("/api/workers/worker-a/claim", workerToken, {})
  ).json();
  expect(claim.task.runtime).toBe("bun");
  expect(claim.task.input).toEqual({ text: "hello" });

  const beat = await (
    await call(`/api/tasks/${claim.task.id}/heartbeat`, workerToken, {
      workerId: "worker-a",
      generation: claim.task.generation,
    })
  ).json();
  expect(beat.leaseUntil).toBeGreaterThan(Date.now());

  const done = await (
    await call(`/api/tasks/${claim.task.id}/complete`, workerToken, {
      workerId: "worker-a",
      generation: claim.task.generation,
      ok: true,
      value: { slug: "hello" },
      usage: { costMicros: 100 },
    })
  ).json();
  expect(done.status).toBe("succeeded");
  expect(done.value).toEqual({ slug: "hello" });
});

test("a worker cannot act as another worker", async () => {
  await dispatch("run-1:step-b");
  const claim = await (
    await call("/api/workers/worker-a/claim", workerToken, {})
  ).json();
  const response = await call(
    `/api/tasks/${claim.task.id}/complete`,
    workerToken,
    {
      workerId: "worker-b",
      generation: claim.task.generation,
      ok: true,
      value: null,
    },
  );
  expect(response.status).toBe(401);
  expect((await response.json()).error).toMatch(/issued for worker/);
});

test("a token may not register a runtime or label it does not carry", async () => {
  const response = await call("/api/workers/register", workerToken, {
    id: "worker-a",
    name: "worker-a",
    host: "test",
    runtimes: ["bun", "shell"],
    labels: { pool: "general" },
  });
  expect(response.status).toBe(401);
  expect((await response.json()).error).toMatch(/runtime 'shell'/);
});

test("malformed dispatches are rejected with 400, not 500", async () => {
  const response = await call("/api/tasks", adminToken, {
    idempotencyKey: "bad",
    runtime: "bun",
    selector: { "not a label key!": "x" },
    runId: "r",
    stepKey: "s",
    attempt: 1,
    maxAttempts: 1,
    deadlineAt: null,
    provider: null,
    workspace: "default",
  });
  expect(response.status).toBe(400);
});

test("readiness reports whether any worker has checked in", async () => {
  expect((await fetch(`${base}/ready`)).status).toBe(200);
});

test("the admin sees snapshot, events and usage", async () => {
  const snapshot = await (await call("/api/snapshot", adminToken)).json();
  expect(snapshot.workers.map((w: { id: string }) => w.id)).toContain(
    "worker-a",
  );
  expect(snapshot.tasks.length).toBeGreaterThan(0);
  expect(snapshot.tasks[0].input).toBeUndefined();
  const events = await (await call("/api/events?after=0", adminToken)).json();
  expect(events.some((e: { type: string }) => e.type.includes("task.dispatched"))).toBe(
    true,
  );
  const usage = await (await call("/api/usage", adminToken)).json();
  expect(usage.costMicros).toBeGreaterThan(0);
});
