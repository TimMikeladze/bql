import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { BusStore, BusError } from "./store";
import type { Completion, Mode, Role } from "../shared/protocol";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
function str(value: unknown, name: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new BusError(`Invalid ${name}`, 400);
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new BusError(`Invalid ${name}`, 400);
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new BusError("Invalid generation", 400);
  return value;
}
function choice<T extends string>(
  value: unknown,
  values: T[],
  name: string,
): T {
  if (!values.includes(value as T)) throw new BusError(`Invalid ${name}`, 400);
  return value as T;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BusError("Expected JSON object", 400);
  return value as Record<string, unknown>;
}

export function createServer({
  store,
  port = 4317,
  hostname = "127.0.0.1",
  token,
}: {
  store: BusStore;
  port?: number;
  hostname?: string;
  token: string;
}) {
  return Bun.serve({
    hostname,
    port,
    idleTimeout: 60,
    maxRequestBodySize: 1024 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url),
        path = url.pathname;
      try {
        if (path === "/health") return json({ ok: true, prototype: true });
        if (!path.startsWith("/api/")) {
          const root = resolve("dist");
          const asset = path.startsWith("/assets/")
            ? resolve(root, `.${path}`)
            : resolve(root, "index.html");
          if (!asset.startsWith(`${root}/`))
            return new Response("Not found", { status: 404 });
          const file = Bun.file(asset);
          return (await file.exists())
            ? new Response(file)
            : new Response(
                "Dashboard: run bun run dev (port 5173), or bun run build.",
                { status: 404 },
              );
        }
        const address = server.requestIP(req)?.address ?? "";
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          address,
        );
        const authenticated =
          req.headers.get("authorization") === `Bearer ${token}`;
        if (
          !authenticated &&
          !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)
        )
          return json(
            { error: "Untrusted host; bearer authentication required" },
            403,
          );
        const workerOperation =
          /^\/api\/(workers\/register|workers\/[^/]+\/claim|tasks\/[^/]+\/(heartbeat|complete|progress)|hooks)$/.test(
            path,
          );
        if ((!local || workerOperation) && !authenticated)
          return json({ error: "Worker bearer token required" }, 401);
        const origin = req.headers.get("origin");
        if (
          origin &&
          !authenticated &&
          !new Set([
            url.origin,
            "http://localhost:5173",
            "http://127.0.0.1:5173",
          ]).has(origin)
        )
          return json({ error: "Origin rejected" }, 403);
        if (req.method === "GET" && path === "/api/snapshot")
          return json(store.snapshot());
        if (req.method === "GET" && path === "/api/events")
          return json(
            store.events(
              Math.max(0, Number(url.searchParams.get("after")) || 0),
            ),
          );
        if (req.method === "GET" && path === "/api/events/stream") {
          let cleanup = () => {};
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              let stopped = false;
              let last = -1;
              const tick = () => {
                if (stopped) return;
                try {
                  const snapshot = store.snapshot();
                  const seq = snapshot.events.at(-1)?.seq ?? 0;
                  controller.enqueue(
                    encoder.encode(
                      seq !== last
                        ? `id: ${seq}\nevent: update\ndata: ${JSON.stringify({ seq })}\n\n`
                        : ": keepalive\n\n",
                    ),
                  );
                  last = seq;
                } catch {
                  cleanup();
                }
              };
              const timer = setInterval(tick, 1000);
              cleanup = () => {
                if (stopped) return;
                stopped = true;
                clearInterval(timer);
                req.signal.removeEventListener("abort", cleanup);
                try {
                  controller.close();
                } catch {}
              };
              req.signal.addEventListener("abort", cleanup, { once: true });
              tick();
            },
            cancel() {
              cleanup();
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        }
        const artifact = /^\/api\/artifacts\/([^/]+)$/.exec(path);
        if (req.method === "GET" && artifact)
          return json(store.artifact(artifact[1]));
        if (req.method !== "POST") return json({ error: "Not found" }, 404);
        let body: Record<string, unknown>;
        try {
          body = record(await req.json());
        } catch {
          return json({ error: "Expected a JSON object" }, 400);
        }
        if (path === "/api/runs")
          return json(
            store.createRun({
              title: str(body.title, "title", 120),
              brief: str(body.brief, "brief", 4000),
              mode: choice<Mode>(body.mode, ["demo", "live"], "mode"),
              requestKey: str(body.requestKey, "request key", 160),
            }),
            201,
          );
        const run = /^\/api\/runs\/([^/]+)\/(approve|cancel|retry)$/.exec(path);
        if (run)
          return json(
            run[2] === "approve"
              ? store.approve(run[1])
              : run[2] === "cancel"
                ? store.cancel(run[1])
                : store.retry(run[1], str(body.requestKey, "request key", 160)),
          );
        if (path === "/api/workers/register")
          return json(
            store.registerWorker({
              id: str(body.id, "worker ID", 100),
              name: str(body.name, "worker name", 100),
              host: str(body.host, "host", 100),
              role: choice<Role>(
                body.role,
                ["creator", "reviewer", "tester"],
                "role",
              ),
              mode: choice<Mode>(body.mode, ["demo", "live"], "mode"),
            }),
          );
        const worker = /^\/api\/workers\/([^/]+)\/(claim|pause)$/.exec(path);
        if (worker)
          return json(
            worker[2] === "claim"
              ? store.claim(worker[1])
              : store.pauseWorker(worker[1], bool(body.paused, "paused")),
          );
        const task =
          /^\/api\/tasks\/([^/]+)\/(heartbeat|complete|progress)$/.exec(path);
        if (task) {
          const wid = str(body.workerId, "worker ID", 100),
            generation = integer(body.generation);
          if (task[2] === "heartbeat")
            return json(store.heartbeat(task[1], wid, generation));
          if (task[2] === "progress") {
            store.progress(
              task[1],
              wid,
              generation,
              choice(
                body.type,
                ["tool.started", "tool.completed", "agent.output"],
                "event type",
              ),
              record(body.data),
            );
            return json({ ok: true });
          }
          if (typeof body.content !== "string" || body.content.length > 500_000)
            throw new BusError("Invalid artifact content", 400);
          const result: Completion = {
            generation,
            ok: bool(body.ok, "ok"),
            name: str(body.name, "artifact name", 160),
            mediaType: str(body.mediaType, "media type", 100),
            content: body.content,
            ...(body.error ? { error: str(body.error, "error", 4000) } : {}),
          };
          return json(store.complete(task[1], wid, result));
        }
        if (path === "/api/hooks")
          return json(
            store.hook({
              id: str(body.id, "id", 160),
              source: str(body.source, "source", 200),
              type: str(body.type, "type", 100),
              data: record(body.data),
            }),
          );
        return json({ error: "Not found" }, 404);
      } catch (error) {
        if (error instanceof BusError)
          return json({ error: error.message }, error.status);
        console.error("Coordinator error", error);
        return json(
          { error: "Coordinator could not commit the operation" },
          500,
        );
      }
    },
  });
}

if (import.meta.main) {
  const file = process.env.BUS_DB ?? ".prototype/bus.sqlite";
  mkdirSync(dirname(file), { recursive: true });
  const token = process.env.BUS_TOKEN;
  if (!token)
    throw new Error(
      "Set BUS_TOKEN for worker authentication, or use bun run dev.",
    );
  const store = new BusStore(file);
  const server = createServer({
    store,
    port: Number(process.env.PORT ?? 4317),
    hostname: process.env.BUS_HOST ?? "127.0.0.1",
    token,
  });
  const recovery = setInterval(() => store.recover(), 1000);
  console.log(
    `AgenticBus coordinator http://${server.hostname}:${server.port}`,
  );
  const stop = () => {
    clearInterval(recovery);
    server.stop(true);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
