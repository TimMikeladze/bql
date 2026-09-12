import { test, expect } from "bun:test";
import { createServer } from "../src/server/server";
import { BusStore } from "../src/server/store";
test("worker operations require bearer auth and browser writes reject foreign origins", async () => {
  const store = new BusStore(":memory:");
  const server = createServer({ store, port: 0, token: "test-token" });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    expect(
      (
        await fetch(`${url}/api/workers/register`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/runs`, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/runs`, {
          method: "POST",
          headers: { Host: "rebind.example", Origin: "http://rebind.example" },
          body: JSON.stringify({
            title: "Rebound",
            brief: "Attempt",
            mode: "demo",
            requestKey: "rebind",
          }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/runs`, {
          method: "POST",
          body: JSON.stringify({ title: 42 }),
        })
      ).status,
    ).toBe(400);
    const response = await fetch(`${url}/api/workers/register`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: JSON.stringify({
        id: "w1",
        name: "Creator",
        role: "creator",
        host: "remote",
        mode: "demo",
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).role).toBe("creator");
  } finally {
    server.stop(true);
    store.close();
  }
});
