import type {
  DeliverFrom,
  Headers,
  Json,
  TokenClaims,
} from "../shared/protocol";
import { ANY, DEFAULT_WORKSPACE } from "../shared/protocol";
import { BusError, BusStore } from "./store";
import { SubjectError } from "./subjects";
import {
  authorizeConsumer,
  authorizePublish,
  authorizeSubscribe,
  mint,
  TokenError,
  verify,
} from "./tokens";

export interface ServerOptions {
  store: BusStore;
  /** HMAC key the bus signs and verifies tokens with. */
  signingKey: string;
  /** Bearer token for administration: minting, subscriptions, any workspace. */
  adminToken: string;
  port?: number;
  hostname?: string;
  /** Serves the dashboard from this directory when present. */
  assets?: string;
  /** Longest a claim or response request may be held open. */
  maxWaitMs?: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BusError("expected a JSON object", 400);
  return value as Record<string, unknown>;
}
function str(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new BusError(`invalid ${field}`, 400);
  return value;
}
function optionalStr(value: unknown, field: string, max = 200): string | null {
  return value === undefined || value === null ? null : str(value, field, max);
}
function int(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new BusError(`invalid ${field}`, 400);
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new BusError(`invalid ${field}`, 400);
  return value;
}
function headerMap(value: unknown, field: string): Headers {
  const source = value === undefined || value === null ? {} : record(value);
  const out: Headers = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!/^[A-Za-z0-9][\w.-]{0,62}$/.test(key))
      throw new BusError(`invalid ${field} key '${key}'`, 400);
    out[key.toLowerCase()] = str(entry, `${field}.${key}`, 1000);
  }
  return out;
}
function strings(value: unknown, field: string, max = 64): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max)
    throw new BusError(`invalid ${field}`, 400);
  return value.map((entry) => str(entry, field, 200));
}

export function createServer(options: ServerOptions) {
  const { store, signingKey, adminToken } = options;
  const maxWaitMs = options.maxWaitMs ?? 30_000;

  const authenticate = (req: Request, url: URL): TokenClaims => {
    const header = req.headers.get("authorization") ?? "";
    // EventSource cannot set headers, so the stream route — and only that
    // route — also accepts the token as a query parameter. Query strings reach
    // access logs, which is why nothing that mutates state is reachable that
    // way and the dashboard's token is read-only.
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : url.pathname === "/api/stream"
        ? (url.searchParams.get("token") ?? "")
        : "";
    if (!token) throw new BusError("bearer token required", 401);
    if (token === adminToken)
      return {
        sub: ANY,
        scope: "admin",
        workspace: ANY,
        publish: [ANY],
        subscribe: [ANY],
        exp: 0,
      };
    try {
      return verify(token, signingKey);
    } catch (error) {
      throw new BusError(
        error instanceof TokenError ? error.message : "invalid token",
        401,
      );
    }
  };

  const requireAdmin = (claims: TokenClaims) => {
    if (claims.scope !== "admin") throw new BusError("admin token required", 403);
  };
  const requireRead = (claims: TokenClaims) => {
    if (claims.scope === "consumer")
      throw new BusError("read access required", 403);
  };
  /**
   * Cancelling is the publisher's call, or an admin's.
   *
   * Not the consumer's: a consumer that could cancel its own work could make a
   * message it did not like disappear, which is a very quiet way to lose work.
   */
  const requireCancel = (claims: TokenClaims, publisher: string | null) => {
    if (claims.scope === "admin") return;
    if (claims.scope === "reader")
      throw new BusError("a reader token may not cancel", 403);
    if (publisher === null || publisher !== claims.sub)
      throw new BusError("only the publisher or an admin may cancel this", 403);
  };

  /**
   * The workspace a request acts in. An admin token may name any; every other
   * token is pinned to its own, so tenancy is a property of the credential
   * rather than a header the caller chooses.
   */
  const workspaceFor = (claims: TokenClaims, req: Request, url: URL): string => {
    const asked =
      req.headers.get("x-bus-workspace") ??
      url.searchParams.get("workspace") ??
      undefined;
    if (claims.workspace !== ANY) {
      if (asked !== undefined && asked !== claims.workspace)
        throw new BusError("token is pinned to another workspace", 403);
      return claims.workspace;
    }
    return asked ?? DEFAULT_WORKSPACE;
  };

  const readerToken = (workspace: string) =>
    mint(
      {
        sub: "dashboard",
        scope: "reader",
        workspace,
        publish: [],
        subscribe: [],
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      },
      signingKey,
    );

  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4317,
    idleTimeout: 120,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === "/health") return json({ ok: true });
        if (path === "/ready") {
          const live = store.liveConsumers();
          return live > 0
            ? json({ ok: true, consumers: live })
            : json({ ok: false, reason: "no consumer has checked in" }, 503);
        }
        if (!path.startsWith("/api/"))
          return serveAsset(options.assets, path, () =>
            readerToken(DEFAULT_WORKSPACE),
          );

        const claims = authenticate(req, url);
        const workspace = workspaceFor(claims, req, url);
        const body =
          req.method === "POST"
            ? await req
                .json()
                .then(record)
                .catch(() => {
                  throw new BusError("expected a JSON object", 400);
                })
            : {};

        // --------------------------------------------------------- publish
        if (req.method === "POST" && path === "/api/publish") {
          const subject = str(body.subject, "subject", 512);
          authorizePublish(claims, subject);
          const result = await store.publish(
            workspace,
            {
              subject,
              body: (body.body ?? null) as Json,
              key: optionalStr(body.key, "key", 200),
              headers: headerMap(body.headers, "headers"),
              dedupeKey: optionalStr(body.dedupeKey, "dedupeKey", 400),
              replyTo: optionalStr(body.replyTo, "replyTo", 512),
              correlation: optionalStr(body.correlation, "correlation", 200),
              ttlMs:
                body.ttlMs === undefined || body.ttlMs === null
                  ? null
                  : int(body.ttlMs, "ttlMs"),
            },
            claims.sub,
          );
          // A reply is recorded against its correlation so the caller can
          // collect it after a restart. It has to say so explicitly: inferring
          // it from "carries a correlation but no reply-to" would silently turn
          // a request that chose its own correlation into an answer to itself.
          const correlation = optionalStr(body.correlation, "correlation", 200);
          if (body.reply === true) {
            if (!correlation)
              throw new BusError("a reply needs a correlation", 400);
            store.respond(
              workspace,
              correlation,
              result.seq,
              (body.body ?? null) as Json,
              headerMap(body.headers, "headers"),
            );
          }
          return json(result, result.duplicate ? 200 : 201);
        }

        // ---------------------------------------------------- subscriptions
        if (req.method === "POST" && path === "/api/subscriptions") {
          requireAdmin(claims);
          const deliverFrom = body.deliverFrom;
          return json(
            store.subscribe(workspace, {
              name: str(body.name, "name", 100),
              pattern: str(body.pattern, "pattern", 512),
              ackWaitMs: int(body.ackWaitMs, "ackWaitMs", 30_000),
              maxAttempts: int(body.maxAttempts, "maxAttempts", 3),
              ordered: body.ordered === true,
              ...(body.dlqSubject
                ? { dlqSubject: str(body.dlqSubject, "dlqSubject", 512) }
                : {}),
              deliverFrom: (deliverFrom ?? "new") as DeliverFrom,
            }),
            201,
          );
        }
        if (req.method === "GET" && path === "/api/subscriptions") {
          requireRead(claims);
          return json(store.subscriptions(workspace));
        }

        const subPath =
          /^\/api\/subscriptions\/([A-Za-z0-9][\w.-]{0,99})(?:\/(claim|replay|purge|pause))?$/.exec(
            path,
          );
        if (subPath) {
          // The pattern guarantees group 1; the action group is genuinely optional.
          const name = subPath[1]!;
          const action = subPath[2];
          if (req.method === "GET" && !action) {
            requireRead(claims);
            return json(store.subscription(workspace, name));
          }
          if (req.method === "DELETE" && !action) {
            requireAdmin(claims);
            return json(store.unsubscribe(workspace, name));
          }
          if (req.method === "POST" && action === "claim") {
            authorizeSubscribe(claims, name);
            const consumer = str(body.consumer, "consumer", 100);
            authorizeConsumer(claims, consumer);
            const max = Math.min(100, Math.max(1, int(body.max, "max", 1)));
            const waitMs = Math.min(
              maxWaitMs,
              Math.max(0, int(body.waitMs, "waitMs", 0)),
            );
            const deadline = Date.now() + waitMs;
            // An empty claim is not free: it reclaims, materializes and scans
            // inside a transaction. Idle consumers holding a long poll would
            // otherwise pay that four times a second each, so once a claim has
            // come back empty the loop waits for the log to move — or for a
            // lease to plausibly have expired — before trying again.
            let seenSeq = -1;
            let nextRetry = 0;
            for (;;) {
              // A caller that has gone away, or a server being shut down,
              // aborts the request — and continuing to poll after that once
              // meant touching a database that had already been closed.
              if (req.signal.aborted) return json([]);
              const now = Date.now();
              const seq = store.lastSeq();
              if (seq !== seenSeq || now >= nextRetry) {
                const envelopes = await store.claim(
                  workspace,
                  name,
                  consumer,
                  max,
                );
                if (envelopes.length > 0) return json(envelopes);
                seenSeq = seq;
                nextRetry = now + 1000;
              }
              if (Date.now() >= deadline) return json([]);
              await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
            }
          }
          if (req.method === "POST" && action === "replay") {
            requireAdmin(claims);
            return json(
              store.replay(workspace, name, int(body.fromSeq, "fromSeq", 0)),
            );
          }
          if (req.method === "POST" && action === "purge") {
            requireAdmin(claims);
            return json(
              store.purge(workspace, name, int(body.fromSeq, "fromSeq", 0)),
            );
          }
          if (req.method === "POST" && action === "pause") {
            requireAdmin(claims);
            return json(
              store.pauseSubscription(workspace, name, body.paused === true),
            );
          }
        }

        // ---------------------------------------------------- cancellation
        const cancelDelivery = /^\/api\/deliveries\/([^/]+)\/cancel$/.exec(path);
        if (req.method === "POST" && cancelDelivery) {
          const id = cancelDelivery[1]!;
          const target = store.delivery(workspace, id);
          requireCancel(
            claims,
            store.messageMeta(workspace, target.messageSeq).publisher,
          );
          return json(store.cancelDelivery(workspace, id));
        }
        const cancelMessage = /^\/api\/messages\/(\d+)\/cancel$/.exec(path);
        if (req.method === "POST" && cancelMessage) {
          const seq = Number(cancelMessage[1]!);
          requireCancel(claims, store.messageMeta(workspace, seq).publisher);
          return json(store.cancelMessage(workspace, seq));
        }

        // ------------------------------------------------------ deliveries
        const delivery = /^\/api\/deliveries\/([^/]+)\/(ack|nack|extend)$/.exec(
          path,
        );
        if (req.method === "POST" && delivery) {
          const id = delivery[1]!;
          const action = delivery[2]!;
          const consumer = str(body.consumer, "consumer", 100);
          authorizeConsumer(claims, consumer);
          const generation = int(body.generation, "generation");
          if (action === "ack")
            return json(store.ack(workspace, id, consumer, generation));
          if (action === "extend")
            return json(store.extend(workspace, id, consumer, generation));
          return json(
            store.nack(workspace, id, consumer, generation, {
              ...(body.error ? { error: str(body.error, "error", 4000) } : {}),
              ...(body.fatal === true ? { fatal: true } : {}),
              ...(body.delayMs !== undefined
                ? { delayMs: int(body.delayMs, "delayMs", 0) }
                : {}),
            }),
          );
        }
        if (req.method === "GET" && path === "/api/deliveries") {
          requireRead(claims);
          return json(store.deliveries(workspace));
        }

        // -------------------------------------------------- request/reply
        if (req.method === "POST" && path === "/api/requests") {
          const subject = str(body.subject, "subject", 512);
          authorizePublish(claims, subject);
          const waitMs = Math.min(
            maxWaitMs,
            Math.max(0, int(body.waitMs, "waitMs", 0)),
          );
          const published = await store.publish(
            workspace,
            {
              subject,
              body: (body.body ?? null) as Json,
              key: optionalStr(body.key, "key", 200),
              headers: headerMap(body.headers, "headers"),
              dedupeKey: optionalStr(body.dedupeKey, "dedupeKey", 400),
              replyTo: optionalStr(body.replyTo, "replyTo", 512) ?? "reply",
              correlation: optionalStr(body.correlation, "correlation", 200),
              ttlMs:
                body.ttlMs === undefined || body.ttlMs === null
                  ? null
                  : int(body.ttlMs, "ttlMs"),
            },
            claims.sub,
          );
          const correlation = published.correlation!;
          const deadline = Date.now() + waitMs;
          for (;;) {
            if (req.signal.aborted) return json({ ...published, response: null }, 202);
            const response = store.response(workspace, correlation);
            if (response) return json({ ...published, response });
            if (Date.now() >= deadline)
              return json({ ...published, response: null }, 202);
            await Bun.sleep(Math.min(200, Math.max(1, deadline - Date.now())));
          }
        }
        const request = /^\/api\/requests\/([^/]+)$/.exec(path);
        if (req.method === "GET" && request) {
          const waitMs = Math.min(
            maxWaitMs,
            Math.max(0, Number(url.searchParams.get("waitMs") ?? 0)),
          );
          const deadline = Date.now() + waitMs;
          for (;;) {
            if (req.signal.aborted) return json({ error: "client went away" }, 499);
            const response = store.response(workspace, request[1]!);
            if (response) return json(response);
            if (Date.now() >= deadline)
              return json({ error: "no response yet" }, 404);
            await Bun.sleep(Math.min(200, Math.max(1, deadline - Date.now())));
          }
        }

        // -------------------------------------------------------- the log
        const message = /^\/api\/messages\/(\d+)$/.exec(path);
        if (req.method === "GET" && message) {
          requireRead(claims);
          return json(await store.message(workspace, Number(message[1]!)));
        }
        if (req.method === "GET" && path === "/api/log") {
          requireRead(claims);
          return json(
            await store.log(
              workspace,
              Number(url.searchParams.get("after") ?? 0),
              Number(url.searchParams.get("limit") ?? 100),
            ),
          );
        }
        if (req.method === "GET" && path === "/api/stream") {
          requireRead(claims);
          return stream(req, store);
        }

        // -------------------------------------------------------- fleet
        if (req.method === "POST" && path === "/api/consumers/register") {
          const id = str(body.id, "id", 100);
          authorizeConsumer(claims, id);
          const subscriptions = strings(body.subscriptions, "subscriptions");
          for (const name of subscriptions) authorizeSubscribe(claims, name);
          return json(
            store.register(workspace, {
              id,
              name: str(body.name, "name", 120),
              host: str(body.host, "host", 200),
              subscriptions,
              labels: headerMap(body.labels, "labels"),
            }),
          );
        }
        const consumer = /^\/api\/consumers\/([^/]+)\/pause$/.exec(path);
        if (req.method === "POST" && consumer) {
          requireAdmin(claims);
          return json(
            store.pauseConsumer(workspace, consumer[1]!, body.paused === true),
          );
        }
        if (req.method === "GET" && path === "/api/consumers") {
          requireRead(claims);
          return json(store.consumers(workspace));
        }
        if (req.method === "GET" && path === "/api/stats") {
          requireRead(claims);
          return json(store.stats(workspace));
        }

        // -------------------------------------------------------- tokens
        if (req.method === "POST" && path === "/api/tokens") {
          requireAdmin(claims);
          const ttlSeconds = int(body.ttlSeconds, "ttlSeconds", 0);
          const issued: TokenClaims = {
            sub: str(body.consumer, "consumer", 100),
            scope: body.scope === "reader" ? "reader" : "consumer",
            workspace: optionalStr(body.workspace, "workspace", 120) ?? workspace,
            publish: strings(body.publish, "publish"),
            subscribe: strings(body.subscribe, "subscribe"),
            exp:
              ttlSeconds === 0 ? 0 : Math.floor(Date.now() / 1000) + ttlSeconds,
          };
          return json({ token: mint(issued, signingKey), claims: issued }, 201);
        }

        return json({ error: "not found" }, 404);
      } catch (error) {
        if (error instanceof BusError)
          return json({ error: error.message }, error.status);
        if (error instanceof TokenError)
          return json({ error: error.message }, 401);
        // A malformed subject is the caller's mistake, not a server fault.
        if (error instanceof SubjectError)
          return json({ error: error.message }, 400);
        console.error("bus error", error);
        return json({ error: "the bus could not commit the operation" }, 500);
      }
    },
  });
}

/** SSE: a sequence number, not a durable subscription. Re-read after it moves. */
function stream(req: Request, store: BusStore): Response {
  let cleanup = () => {};
  const body = new ReadableStream({
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
  return new Response(body, {
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
