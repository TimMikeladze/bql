import { test, expect } from "bun:test";
import { BusStore } from "../src/server/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Role, Completion } from "../src/shared/protocol";
const input = {
  title: "Ship slugify",
  brief: "Build slugify",
  mode: "demo" as const,
  requestKey: "unique-request",
};
const output = (generation: number, ok = true): Completion => ({
  generation,
  ok,
  name: "result.txt",
  mediaType: "text/plain",
  content: "hello",
  ...(!ok ? { error: "Test failed" } : {}),
});
function worker(s: BusStore, role: Role) {
  return s.registerWorker({
    id: role,
    name: role,
    role,
    host: "test",
    mode: "demo",
  });
}

test("duplicate request returns the same run and conflicts are rejected", () => {
  const s = new BusStore(":memory:");
  const a = s.createRun(input);
  const b = s.createRun(input);
  expect(a.id).toBe(b.id);
  expect(s.snapshot().tasks).toHaveLength(3);
  expect(() => s.createRun({ ...input, title: "Different" })).toThrow(
    "conflict",
  );
  s.close();
});
test("review and tests join on one artifact before approval", () => {
  const s = new BusStore(":memory:");
  const r = s.createRun(input);
  worker(s, "creator");
  worker(s, "reviewer");
  worker(s, "tester");
  expect(s.claim("reviewer")).toBeNull();
  const c = s.claim("creator")!;
  s.complete(c.task.id, "creator", output(c.task.generation));
  const review = s.claim("reviewer")!;
  const tests = s.claim("tester")!;
  expect(review.artifact!.id).toBe(tests.artifact!.id);
  s.complete(review.task.id, "reviewer", output(review.task.generation));
  expect(() => s.approve(r.id)).toThrow("not ready");
  s.complete(tests.task.id, "tester", output(tests.task.generation));
  expect(s.snapshot().runs[0].status).toBe("waiting_approval");
  s.approve(r.id);
  expect(s.snapshot().runs[0].status).toBe("succeeded");
  s.close();
});
test("expired attempts are fenced and identical completion is idempotent", () => {
  let now = 1000;
  const s = new BusStore(":memory:", () => now, 100);
  s.createRun(input);
  worker(s, "creator");
  const old = s.claim("creator")!;
  now += 101;
  s.recover();
  const next = s.claim("creator")!;
  expect(next.task.generation).toBeGreaterThan(old.task.generation);
  expect(() =>
    s.complete(old.task.id, "creator", output(old.task.generation)),
  ).toThrow("stale");
  s.complete(next.task.id, "creator", output(next.task.generation));
  const count = s.snapshot().events.length;
  s.complete(next.task.id, "creator", output(next.task.generation));
  expect(s.snapshot().events.length).toBe(count);
  expect(() =>
    s.complete(next.task.id, "creator", {
      ...output(next.task.generation),
      content: "different",
    }),
  ).toThrow("conflict");
  s.close();
});
test("failed checks prevent approval and cancelled attempts cannot complete", () => {
  const s = new BusStore(":memory:");
  const r = s.createRun(input);
  worker(s, "creator");
  const c = s.claim("creator")!;
  s.cancel(r.id);
  expect(() =>
    s.complete(c.task.id, "creator", output(c.task.generation)),
  ).toThrow("stale");
  expect(() => s.approve(r.id)).toThrow("not ready");
  s.close();
});
test("committed work survives reopening the database", () => {
  const dir = mkdtempSync(`${tmpdir()}/agenticbus-test-`);
  const file = `${dir}/bus.sqlite`;
  const s = new BusStore(file);
  const r = s.createRun(input);
  s.close();
  const reopened = new BusStore(file);
  expect(reopened.snapshot().runs[0].id).toBe(r.id);
  expect(reopened.events(0)).toHaveLength(1);
  reopened.close();
  rmSync(dir, { recursive: true });
});
test("a failed review blocks approval even when tests succeed", () => {
  const s = new BusStore(":memory:");
  const r = s.createRun(input);
  for (const role of ["creator", "reviewer", "tester"] as Role[])
    worker(s, role);
  const c = s.claim("creator")!;
  s.complete(c.task.id, "creator", output(c.task.generation));
  const a = s.claim("reviewer")!,
    b = s.claim("tester")!;
  s.complete(a.task.id, "reviewer", output(a.task.generation, false));
  s.complete(b.task.id, "tester", output(b.task.generation));
  expect(s.snapshot().runs[0].status).toBe("failed");
  expect(() => s.approve(r.id)).toThrow("not ready");
  const retry = s.retry(r.id, "retry-request");
  expect(retry.id).not.toBe(r.id);
  expect(retry.status).toBe("running");
  s.close();
});
test("paused worker stays paused after reconnect and never claims work", () => {
  const s = new BusStore(":memory:");
  s.createRun(input);
  worker(s, "creator");
  s.pauseWorker("creator", true);
  worker(s, "creator");
  expect(s.claim("creator")).toBeNull();
  s.pauseWorker("creator", false);
  expect(s.claim("creator")).not.toBeNull();
  s.close();
});
test("retry-safe work stops after three expired attempts", () => {
  let now = 0;
  const s = new BusStore(":memory:", () => now, 100);
  s.createRun(input);
  worker(s, "creator");
  for (let i = 0; i < 3; i++) {
    expect(s.claim("creator")).not.toBeNull();
    now += 101;
    s.recover();
  }
  expect(s.claim("creator")).toBeNull();
  expect(s.snapshot().runs[0].status).toBe("failed");
  s.close();
});
