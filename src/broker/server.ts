import type {
  Completion,
  Labels,
  LogChannel,
  TokenClaims,
} from "../shared/protocol";
import { ANY } from "../shared/protocol";
import { BrokerError, BrokerStore } from "./store";
import {
  authorizeRegistration,
  authorizeWorker,
  mint,
  TokenError,
  verify,
} from "./tokens";

export interface BrokerOptions {
  store: BrokerStore;
  /** HMAC key the broker signs and verifies worker tokens with. */
  signingKey: string;
  /** Bearer token for dispatch, cancellation, token minting and fleet reads. */
  adminToken: string;
  port?: number;
  hostname?: string;
  /** Serves the fleet dashboard from this directory when present. */
  assets?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BrokerError("expected a JSON object", 400);
  return value as Record<string, unknown>;
}
function str(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new BrokerError(`invalid ${field}`, 400);
  return value;
}
function optionalStr(value: unknown, field: string, max = 200): string | null {
  return value === undefined || value === null ? null : str(value, field, max);
}
function int(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new BrokerError(`invalid ${field}`, 400);
  return value;
}
function labels(value: unknown, field: string): Labels {
  const source = value === undefined ? {} : record(value);
  const out: Labels = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!/^[a-zA-Z0-9][\w.\-/]{0,62}$/.test(key))
      throw new BrokerError(`invalid ${field} key '${key}'`, 400);
    out[key] = str(entry, `${field}.${key}`, 200);
  }
  return out;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    throw new BrokerError(`invalid ${field}`, 400);
  return value.map((entry) => str(entry, field, 100));
}

export function createBroker(options: BrokerOptions) {
  const { store, signingKey, adminToken } = options;

  const authenticate = (req: Request, url: URL): TokenClaims => {
    const header = req.headers.get("authorization") ?? "";
    // EventSource cannot set headers, so the SSE route — and only that route —
    // also accepts the token as a query parameter. Query strings end up in
    // access logs, which is why nothing that mutates state is reachable this
    // way and the dashboard's token is read-only and short-lived.
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : url.pathname === "/api/events/stream"
        ? (url.searchParams.get("token") ?? "")
        : "";
    if (!token) throw new BrokerError("bearer token required", 401);
    if (token === adminToken)
      return {
        sub: ANY,
        scope: "admin",
        runtimes: [ANY],
        labels: {},
        exp: 0,
      };
    try {
      return verify(token, signingKey);
    } catch (error) {
      throw new BrokerError(
        error instanceof TokenError ? error.message : "invalid token",
        401,
      );
    }
  };
  const requireAdmin = (claims: TokenClaims) => {
    if (claims.scope !== "admin")
      throw new BrokerError("admin token required", 403);
  };
  /** Fleet reads are open to the dashboard's read-only token as well. */
  const requireRead = (claims: TokenClaims) => {
    if (claims.scope !== "admin" && claims.scope !== "reader")
      throw new BrokerError("read access required", 403);
  };
  /**
   * The dashboard runs in a browser and has no credential of its own, so the
   * broker mints it a short-lived read-only token and injects it into the page
   * it serves. Read-only is the whole point: a page that can be opened is not a
   * page that can dispatch work. Anything in front of this on a network still
   * has to authenticate its own users.
   */
  const readerToken = () =>
    mint(
      {
        sub: "dashboard",
        scope: "reader",
        runtimes: [],
        labels: {},
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      },
      signingKey,
    );

  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4317,
    idleTimeout: 120,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === "/health") return json({ ok: true });
        if (path === "/ready") {
          // Readiness that only proves the database opens cannot see the
          // failure that matters most: an install with no worker to run
          // anything. One indexed count, not a fleet walk.
          const live = store.liveWorkers();
          return live > 0
            ? json({ ok: true, workers: live })
            : json({ ok: false, reason: "no worker has checked in" }, 503);
        }
        if (!path.startsWith("/api/"))
          return serveAsset(options.assets, path, readerToken);

        const claims = authenticate(req, url);
        const body =
          req.method === "POST"
            ? await req
                .json()
                .then(record)
                .catch(() => {
                  throw new BrokerError("expected a JSON object", 400);
                })
            : {};

        // ------------------------------------------------------ observation
        if (req.method === "GET" && path === "/api/snapshot") {
          requireRead(claims);
          return json(store.snapshot());
        }
        if (req.method === "GET" && path === "/api/events") {
          requireRead(claims);
          return json(
            store.events(Math.max(0, Number(url.searchParams.get("after")) || 0)),
          );
        }
        if (req.method === "GET" && path === "/api/events/stream") {
          requireRead(claims);
          return streamEvents(req, store);
        }
        if (req.method === "GET" && path === "/api/workers") {
          requireRead(claims);
          return json(store.workers());
        }
        if (req.method === "GET" && path === "/api/usage") {
          requireRead(claims);
          return json(store.usageTotals());
        }

        // ------------------------------------------------------------ tasks
        const taskPath = /^\/api\/tasks\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
        if (req.method === "GET" && taskPath && !taskPath[2]) {
          const task = store.task(taskPath[1]);
          if (claims.scope !== "admin") authorizeWorker(claims, task.workerId ?? "");
          return json(task);
        }
        if (req.method === "POST" && path === "/api/tasks") {
          requireAdmin(claims);
          return json(
            store.dispatch({
              idempotencyKey: str(body.idempotencyKey, "idempotencyKey", 400),
              runtime: str(body.runtime, "runtime", 100),
              selector: labels(body.selector, "selector"),
              input: body.input ?? null,
              uses: optionalStr(body.uses, "uses", 500) ?? undefined,
              script: optionalStr(body.script, "script", 200_000) ?? undefined,
              runId: str(body.runId, "runId", 200),
              stepKey: str(body.stepKey, "stepKey", 200),
              attempt: int(body.attempt, "attempt"),
              maxAttempts: int(body.maxAttempts, "maxAttempts"),
              deadlineAt:
                body.deadlineAt === null || body.deadlineAt === undefined
                  ? null
                  : int(body.deadlineAt, "deadlineAt"),
              provider:
                body.provider === null || body.provider === undefined
                  ? null
                  : {
                      unit: str(record(body.provider).unit, "provider.unit", 40),
                      units: Number(record(body.provider).units),
                    },
              workspace: str(body.workspace, "workspace", 120),
            }),
            201,
          );
        }
        if (req.method === "POST" && taskPath) {
          const [, taskId, action] = taskPath;
          if (action === "cancel") {
            requireAdmin(claims);
            return json(
              store.cancel(
                taskId,
                optionalStr(body.reason, "reason", 500) ?? undefined,
              ),
            );
          }
          const workerId = str(body.workerId, "workerId", 100);
          authorizeWorker(claims, workerId);
          const generation = int(body.generation, "generation");
          if (action === "heartbeat")
            return json(store.heartbeat(taskId, workerId, generation));
          if (action === "checkpoint")
            return json(
              store.checkpoint(taskId, workerId, generation, body.value ?? null),
            );
          if (action === "log")
            return json(
              store.log(
                taskId,
                workerId,
                generation,
                str(body.channel, "channel", 10) as LogChannel,
                str(body.message, "message", 8000),
              ),
            );
          if (action === "complete") {
            const completion: Completion = {
              workerId,
              generation,
              ok: body.ok === true,
              value: body.value ?? null,
              ...(body.usage ? { usage: record(body.usage) } : {}),
              ...(body.error
                ? { error: str(body.error, "error", 8000) }
                : {}),
              ...(body.fatal === true ? { fatal: true } : {}),
            };
            return json(store.complete(taskId, completion));
          }
        }

        // ---------------------------------------------------------- workers
        if (req.method === "POST" && path === "/api/workers/register") {
          const id = str(body.id, "id", 100);
          const runtimes = strings(body.runtimes, "runtimes");
          const workerLabels = labels(body.labels, "labels");
          authorizeRegistration(claims, id, runtimes, workerLabels);
          return json(
            store.register({
              id,
              name: str(body.name, "name", 120),
              host: str(body.host, "host", 200),
              runtimes,
              labels: workerLabels,
            }),
          );
        }
        const workerPath = /^\/api\/workers\/([^/]+)\/(claim|pause)$/.exec(path);
        if (req.method === "POST" && workerPath) {
          const [, workerId, action] = workerPath;
          authorizeWorker(claims, workerId);
          if (action === "claim") return json(store.claim(workerId));
          requireAdmin(claims);
          return json(store.pause(workerId, body.paused === true));
        }

        // ----------------------------------------------------------- tokens
        if (req.method === "POST" && path === "/api/tokens") {
          requireAdmin(claims);
          const ttlSeconds =
            body.ttlSeconds === undefined ? 0 : int(body.ttlSeconds, "ttlSeconds");
          const issued: TokenClaims = {
            sub: str(body.workerId, "workerId", 100),
            scope: "worker",
            runtimes:
              body.runtimes === undefined
                ? [ANY]
                : strings(body.runtimes, "runtimes"),
            labels: labels(body.labels, "labels"),
            exp: ttlSeconds === 0 ? 0 : Math.floor(Date.now() / 1000) + ttlSeconds,
          };
          return json({ token: mint(issued, signingKey), claims: issued }, 201);
        }

        return json({ error: "not found" }, 404);
      } catch (error) {
        if (error instanceof BrokerError)
          return json({ error: error.message }, error.status);
        // An authorization failure is the caller's answer, not a server fault.
        if (error instanceof TokenError) return json({ error: error.message }, 401);
        console.error("broker error", error);
        return json({ error: "broker could not commit the operation" }, 500);
      }
    },
  });
}

/** SSE refresh signal: a sequence number, not a durable subscription. */
function streamEvents(req: Request, store: BrokerStore): Response {
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let stopped = false;
      let last = -1;
      const tick = () => {
        if (stopped) return;
        try {
          const seq = store.lastSeq();
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

async function serveAsset(
  root: string | undefined,
  path: string,
  readerToken: () => string,
) {
  if (!root) return new Response("Not found", { status: 404 });
  const { resolve } = await import("node:path");
  const base = resolve(root);
  const isAsset = path.startsWith("/assets/");
  const target = isAsset ? resolve(base, `.${path}`) : resolve(base, "index.html");
  if (!target.startsWith(`${base}/`))
    return new Response("Not found", { status: 404 });
  const file = Bun.file(target);
  if (!(await file.exists()))
    return new Response("Dashboard not built: run bun run build.", {
      status: 404,
    });
  if (isAsset) return new Response(file);
  const html = (await file.text()).replace(
    "</head>",
    `<script>window.__BUS_TOKEN=${JSON.stringify(readerToken())}</script></head>`,
  );
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
