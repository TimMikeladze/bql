import type {
  Backoff,
  DeliverFrom,
  EffectRecord,
  Headers,
  Json,
  PublishRequest,
  Quarantine,
  SchemaMode,
  TokenClaims,
} from "../shared/protocol";
import { ANY, DEFAULT_WORKSPACE } from "../shared/protocol";
import { EMBEDDED_ASSETS } from "../dashboard/embedded.generated";
import { fault } from "./faults";
import { gate, type RateLimit, tokenBucket } from "./limits";
import { type Logger, silentLogger } from "./log";
import { type PrometheusMetrics, prometheusMetrics } from "./metrics";
import { BusError, BusStore } from "./store";
import { SubjectError } from "./subjects";
import { type CompatMode, SchemaError, SUPPORTED_KEYWORDS } from "./schema";
import {
  authorizeConsumer,
  authorizePublish,
  authorizeSubscribe,
  type Keyring,
  mint,
  singleKey,
  TokenError,
  verify,
} from "./tokens";

/**
 * Over the limit.
 *
 * A distinct type rather than a `BusError` with status 429, because the answer
 * has to carry `Retry-After`: telling a client to back off without telling it
 * for how long just moves the retry storm along by one round trip.
 */
class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super("rate limit exceeded");
  }
}

export interface ServerOptions {
  store: BusStore;
  /**
   * HMAC key the bus signs and verifies tokens with. A `Keyring` instead of a
   * string is what allows rotation with two keys live at once.
   */
  signingKey: string | Keyring;
  /** Bearer token for administration: minting, subscriptions, any workspace. */
  adminToken: string;
  port?: number;
  hostname?: string;
  /** Serves the dashboard from this directory when present. */
  assets?: string;
  /** Longest a claim or response request may be held open. */
  maxWaitMs?: number;
  /** Renders `GET /metrics`. Without one, that route is a 404. */
  metrics?: PrometheusMetrics;
  logger?: Logger;
  /** Publishes per token per second. 0 disables. */
  publishRate?: RateLimit;
  /** Claims per token per second. 0 disables. */
  claimRate?: RateLimit;
  /** Concurrent parked long polls one token may hold. 0 disables. */
  maxParkedPerToken?: number;
}

export interface BusServer {
  readonly hostname: string;
  readonly port: number;
  /** Stop immediately. `force` closes connections that are still open. */
  stop(force?: boolean): void;
  /**
   * Drain and close.
   *
   * Stops accepting claims first, so a consumer's long poll returns empty
   * instead of being cut off mid-request, waits for the polls already inside
   * the handler, and only then closes. The previous shutdown stopped the
   * server and closed the store underneath live long polls; only the abort
   * guard inside the claim loop made that survivable.
   */
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
  /** True once `shutdown` has begun. `/ready` reports it. */
  readonly draining: boolean;
}

/** The wire protocol this build speaks. `/api/v1/...` is the explicit spelling. */
export const API_VERSION = "1";

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
/**
 * Refuse a write when the disk is nearly full.
 *
 * 507 rather than 503: the request is well-formed and the server is up, it is
 * storage that is gone, and a producer's retry policy should tell those apart.
 * The body names the numbers so an operator does not have to guess the
 * threshold.
 */
function requireRoom(store: BusStore): void {
  const room = store.capacity();
  if (room.ok) return;
  throw new BusError(
    `the bus is out of disk: ${room.freeBytes} bytes free, ${room.minFreeBytes} required (reason=disk-full)`,
    507,
  );
}

function number(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new BusError(`invalid ${field}`, 400);
  return value;
}

function backoffOf(value: unknown): Partial<Backoff> {
  const source = record(value);
  const jitter = source.jitter === undefined ? undefined : str(source.jitter, "backoff.jitter", 8);
  if (jitter !== undefined && jitter !== "full" && jitter !== "none")
    throw new BusError("backoff.jitter must be 'full' or 'none'", 400);
  return {
    ...(source.baseMs !== undefined
      ? { baseMs: int(source.baseMs, "backoff.baseMs") }
      : {}),
    ...(source.maxMs !== undefined
      ? { maxMs: int(source.maxMs, "backoff.maxMs") }
      : {}),
    ...(source.factor !== undefined
      ? { factor: number(source.factor, "backoff.factor", 2) }
      : {}),
    ...(jitter !== undefined ? { jitter } : {}),
  };
}

function quarantineOf(value: unknown): Partial<Quarantine> {
  const source = record(value);
  return {
    ...(source.deadRate !== undefined
      ? { deadRate: number(source.deadRate, "quarantine.deadRate", 0) }
      : {}),
    ...(source.windowMs !== undefined
      ? { windowMs: int(source.windowMs, "quarantine.windowMs") }
      : {}),
    ...(source.minDead !== undefined
      ? { minDead: int(source.minDead, "quarantine.minDead") }
      : {}),
  };
}

/** Messages an ack carries, each authorized as though it were published alone. */
function publishList(
  value: unknown,
  claims: TokenClaims,
  max = 64,
): PublishRequest[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max)
    throw new BusError("invalid publish", 400);
  return value.map((entry) => {
    const item = record(entry);
    const subject = str(item.subject, "publish.subject", 512);
    authorizePublish(claims, subject);
    return {
      subject,
      body: (item.body ?? null) as Json,
      key: optionalStr(item.key, "publish.key", 200),
      headers: headerMap(item.headers, "publish.headers"),
      dedupeKey: optionalStr(item.dedupeKey, "publish.dedupeKey", 400),
      replyTo: optionalStr(item.replyTo, "publish.replyTo", 512),
      correlation: optionalStr(item.correlation, "publish.correlation", 200),
      ttlMs:
        item.ttlMs === undefined || item.ttlMs === null
          ? null
          : int(item.ttlMs, "publish.ttlMs"),
      ...(item.priority !== undefined
        ? { priority: int(item.priority, "publish.priority") }
        : {}),
      ...(item.delayMs !== undefined
        ? { delayMs: int(item.delayMs, "publish.delayMs") }
        : {}),
      ...(item.reply === true ? { reply: true } : {}),
    } satisfies PublishRequest;
  });
}

/** Effect-ledger results recorded with an ack. */
function effectList(value: unknown): EffectRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64)
    throw new BusError("invalid effects", 400);
  return value.map((entry) => {
    const item = record(entry);
    return {
      key: str(item.key, "effects.key", 400),
      result: (item.result ?? null) as Json,
    };
  });
}

function strings(value: unknown, field: string, max = 64): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max)
    throw new BusError(`invalid ${field}`, 400);
  return value.map((entry) => str(entry, field, 200));
}

export function createServer(options: ServerOptions): BusServer {
  const { store, signingKey, adminToken } = options;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const log = options.logger ?? silentLogger();
  let draining = false;
  /** Long polls currently parked inside the handler, so shutdown can wait. */
  let parked = 0;
  /**
   * Open SSE streams, and how to end each one.
   *
   * A stream is a response that never completes, so `server.stop(false)` —
   * which waits for in-flight requests — would wait for it forever. A single
   * open dashboard would have turned SIGTERM into a hang.
   */
  const streams = new Set<() => void>();
  let shuttingDown: Promise<void> | null = null;

  const keys: Keyring =
    typeof signingKey === "string" ? singleKey(signingKey) : signingKey;
  // Off by default: turning a limit on without knowing the workload is how a
  // healthy fleet gets throttled at 3am. The knobs are here, the numbers are
  // the operator's.
  const publishes = tokenBucket(options.publishRate ?? { perSecond: 0, burst: 0 });
  const claims429 = tokenBucket(options.claimRate ?? { perSecond: 0, burst: 0 });
  const polls = gate(options.maxParkedPerToken ?? 0);

  /**
   * Who a request is, for limiting and for the audit trail.
   *
   * The token *subject* rather than the raw token: the trail has to name a
   * party, and a credential in a log line is a credential in a log.
   */
  const identity = (claims: TokenClaims) => `${claims.workspace}/${claims.sub}`;

  const limit = (
    bucket: ReturnType<typeof tokenBucket>,
    claims: TokenClaims,
    cost = 1,
  ) => {
    const decision = bucket.take(identity(claims), cost);
    if (decision.ok) return;
    throw new RateLimited(decision.retryAfterMs);
  };

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
      const claims = verify(token, keys);
      // Stateless verification plus one local index probe. Not a round trip,
      // not a network call — which is what makes revocation affordable without
      // giving up the property that made stateless tokens worth having.
      if (claims.jti && store.isRevoked(claims.jti))
        throw new TokenError("this token has been revoked");
      return claims;
    } catch (error) {
      throw new BusError(
        error instanceof TokenError ? error.message : "invalid token",
        401,
      );
    }
  };

  /** Record an operator action against the token that took it. */
  const audit = (
    claims: TokenClaims,
    action: string,
    target?: string | null,
    workspace = claims.workspace,
  ) =>
    store.audit({
      workspace: workspace === ANY ? DEFAULT_WORKSPACE : workspace,
      actor: claims.sub,
      scope: claims.scope,
      action,
      target: target ?? null,
    });

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
    // `*` is the subject an *admin* token publishes under. A non-admin token
    // minted with `sub: "*"` would otherwise match it and inherit the right to
    // cancel anything an admin published.
    if (publisher === null || publisher === ANY || publisher !== claims.sub)
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
      keys,
    );

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4317,
    idleTimeout: 120,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      // A versioned wire protocol, so a broker and its clients can skew during
      // a rolling deploy instead of having to move in lockstep. `/api/v1/x` is
      // the same route as `/api/x`; the version may also arrive as a header.
      // One version exists today — the point is that the *next* one can be
      // added without breaking anything already deployed.
      const asked =
        /^\/api\/v(\d+)\//.exec(url.pathname)?.[1] ??
        req.headers.get("x-bus-api-version");
      const path = url.pathname.replace(/^\/api\/v\d+\//, "/api/");
      try {
        if (asked !== undefined && asked !== null && asked !== API_VERSION)
          return json(
            {
              error: `this bus speaks wire protocol v${API_VERSION}, not v${asked}`,
              version: API_VERSION,
            },
            400,
          );
        if (path === "/health") return json({ ok: true, draining });
        if (path === "/ready") {
          // Draining is deliberately *not* ready: a load balancer should stop
          // routing here before the process stops answering.
          if (draining) return json({ ok: false, reason: "draining" }, 503);
          // Nor is a bus that has run out of room to write. It still serves
          // claims and acks — consumers have to be able to drain — but it is
          // not somewhere a producer should be sent.
          const room = store.capacity();
          if (!room.ok)
            return json(
              {
                ok: false,
                reason: "disk-full",
                freeBytes: room.freeBytes,
                minFreeBytes: room.minFreeBytes,
              },
              503,
            );
          const live = store.liveConsumers();
          return live > 0
            ? json({ ok: true, consumers: live })
            : json({ ok: false, reason: "no consumer has checked in" }, 503);
        }
        if (path === "/metrics" && req.method === "GET") {
          if (!options.metrics) return json({ error: "not found" }, 404);
          // An admin scrape is the install: every workspace, plus the disk and
          // WAL numbers that belong to the process rather than to any tenant.
          // A workspace-pinned reader gets **only its own** series — the
          // counters carry a workspace label now, so this is a filter on the
          // way out rather than a second registry to keep in step. A consumer
          // token still gets nothing: observing is a read.
          const scraper = authenticate(req, url);
          requireRead(scraper);
          const scoped =
            scraper.workspace === ANY ? undefined : scraper.workspace;
          return new Response(renderMetrics(store, options.metrics, scoped), {
            headers: { "Content-Type": "text/plain; version=0.0.4" },
          });
        }
        if (!path.startsWith("/api/"))
          return serveAsset(options.assets, path, () =>
            readerToken(DEFAULT_WORKSPACE),
          );

        const claims = authenticate(req, url);
        const workspace = workspaceFor(claims, req, url);
        const body =
          req.method === "POST" || req.method === "PUT"
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
          limit(publishes, claims);
          requireRoom(store);
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
              ...(body.priority !== undefined
                ? { priority: int(body.priority, "priority") }
                : {}),
              ...(body.delayMs !== undefined
                ? { delayMs: int(body.delayMs, "delayMs") }
                : {}),
              ...(body.deliverAt !== undefined
                ? { deliverAt: int(body.deliverAt, "deliverAt") }
                : {}),
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

        // Many messages, one transaction. Each is authorized as though it were
        // published alone; a reply has its own route and is refused here.
        if (req.method === "POST" && path === "/api/publish/batch") {
          const messages = publishList(body.messages, claims, 1000);
          if (messages.length === 0)
            throw new BusError("messages must be a non-empty array", 400);
          if (messages.some((one) => one.reply))
            throw new BusError("a reply cannot be batched", 400);
          // A batch costs what its messages would cost published one at a
          // time, or a batch route would be a way around `--publish-rate`. A
          // batch larger than the burst could never be admitted, so it is
          // refused by name rather than answered 429 for ever.
          const rate = options.publishRate;
          if (rate && rate.perSecond > 0 && messages.length > rate.burst)
            throw new BusError(
              `a batch of ${messages.length} is larger than the publish burst (${rate.burst}); send at most ${rate.burst} at a time`,
              413,
            );
          limit(publishes, claims, messages.length);
          requireRoom(store);
          const results = await store.publishBatch(
            workspace,
            messages,
            claims.sub,
          );
          return json({ results }, 201);
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
              ...(body.backoff ? { backoff: backoffOf(body.backoff) } : {}),
              ...(body.onFailure
                ? {
                    onFailure:
                      str(body.onFailure, "onFailure", 8) === "skip"
                        ? ("skip" as const)
                        : ("block" as const),
                  }
                : {}),
              ...(body.maxInFlight !== undefined
                ? { maxInFlight: int(body.maxInFlight, "maxInFlight", 0) }
                : {}),
              ...(body.quarantine
                ? { quarantine: quarantineOf(body.quarantine) }
                : {}),
            }),
            201,
          );
        }
        if (req.method === "GET" && path === "/api/subscriptions") {
          requireRead(claims);
          return json(store.subscriptions(workspace));
        }

        const subPath =
          /^\/api\/subscriptions\/([A-Za-z0-9][\w.-]{0,99})(?:\/(claim|replay|purge|pause|blocked|unblock))?$/.exec(
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
            limit(claims429, claims);
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
            // One consumer must not be able to occupy the server's whole poll
            // budget by opening long polls it never uses.
            if (!polls.enter(identity(claims)))
              throw new BusError(
                `too many long polls open for '${claims.sub}'`,
                429,
              );
            parked++;
            try {
              for (;;) {
                // A caller that has gone away, or a server being shut down,
                // aborts the request — and continuing to poll after that once
                // meant touching a database that had already been closed.
                if (req.signal.aborted) return json([]);
                // Draining: answer now rather than holding the consumer for
                // the rest of its wait. An empty claim is a normal answer, so
                // the consumer simply asks again — somewhere else, once this
                // process is out of rotation.
                if (draining) return json([]);
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
                await Bun.sleep(
                  Math.min(100, Math.max(1, deadline - Date.now())),
                );
              }
            } finally {
              parked--;
              polls.leave(identity(claims));
            }
          }
          if (req.method === "POST" && action === "replay") {
            requireAdmin(claims);
            audit(claims, "subscription.replay", name);
            return json(
              store.replay(workspace, name, int(body.fromSeq, "fromSeq", 0)),
            );
          }
          if (req.method === "POST" && action === "purge") {
            requireAdmin(claims);
            audit(claims, "subscription.purge", name);
            return json(
              store.purge(workspace, name, int(body.fromSeq, "fromSeq", 0)),
            );
          }
          // Ordered subscriptions: the keys stalled behind a dead letter, and
          // the operator action that lets one move again.
          if (req.method === "GET" && action === "blocked") {
            requireRead(claims);
            return json(store.blockedKeys(workspace, name));
          }
          if (req.method === "POST" && action === "unblock") {
            requireAdmin(claims);
            audit(claims, "subscription.unblock", `${name}:${String(body.key)}`);
            return json(
              store.unblockKey(workspace, name, str(body.key, "key", 200)),
            );
          }
          // Ordered subscriptions: the keys stalled behind a dead letter, and
          // the operator action that lets one move again.
          if (req.method === "GET" && action === "blocked") {
            requireRead(claims);
            return json(store.blockedKeys(workspace, name));
          }
          if (req.method === "POST" && action === "unblock") {
            requireAdmin(claims);
            audit(claims, "subscription.unblock", `${name}:${String(body.key)}`);
            return json(
              store.unblockKey(workspace, name, str(body.key, "key", 200)),
            );
          }
          if (req.method === "POST" && action === "pause") {
            requireAdmin(claims);
            audit(claims, "subscription.pause", `${name} paused=${body.paused === true}`);
            return json(
              store.pauseSubscription(workspace, name, body.paused === true),
            );
          }
        }

        // ------------------------------------------------------- schedules
        // Defining a schedule is an admin action, like a subscription: it is
        // a standing publish that no token is present for when it fires.
        if (req.method === "GET" && path === "/api/schedules") {
          requireRead(claims);
          return json(store.schedules(workspace));
        }
        const schedulePath =
          /^\/api\/schedules\/([A-Za-z0-9][\w.-]{0,99})(?:\/(pause|resume|run))?$/.exec(
            path,
          );
        if (schedulePath) {
          const name = schedulePath[1]!;
          const action = schedulePath[2];
          if (req.method === "GET" && !action) {
            requireRead(claims);
            return json(store.schedule(workspace, name));
          }
          if (req.method === "PUT" && !action) {
            requireAdmin(claims);
            const catchUp = optionalStr(body.catchUp, "catchUp", 10) ?? "latest";
            if (catchUp !== "latest" && catchUp !== "none")
              throw new BusError("catchUp must be latest or none", 400);
            const schedule = store.upsertSchedule(workspace, {
              name,
              cron: str(body.cron, "cron", 200),
              tz: optionalStr(body.tz, "tz", 64) ?? "UTC",
              subject: str(body.subject, "subject", 512),
              body: (body.body ?? null) as Json,
              headers: headerMap(body.headers, "headers"),
              catchUp,
              paused: body.paused === true,
            });
            audit(claims, "schedule.put", `${name} ${schedule.cron} ${schedule.tz}`);
            return json(schedule);
          }
          if (req.method === "DELETE" && !action) {
            requireAdmin(claims);
            audit(claims, "schedule.delete", name);
            return json(store.deleteSchedule(workspace, name));
          }
          if (req.method === "POST" && (action === "pause" || action === "resume")) {
            requireAdmin(claims);
            audit(claims, `schedule.${action}`, name);
            return json(store.pauseSchedule(workspace, name, action === "pause"));
          }
          // Running one now is a publish: an admin, or a token that could
          // have published to the schedule's subject directly anyway.
          if (req.method === "POST" && action === "run") {
            authorizePublish(claims, store.schedule(workspace, name).subject);
            limit(publishes, claims);
            requireRoom(store);
            audit(claims, "schedule.run", name);
            return json(await store.runSchedule(workspace, name), 201);
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
          audit(claims, "message.cancel", String(seq), workspace);
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
          if (action === "ack") {
            // Anything published with the ack is still a publish: it needs the
            // same grant and the same disk check as one on its own.
            const publish = publishList(body.publish, claims);
            if (publish.length > 0) requireRoom(store);
            const acked = await store.ack(workspace, id, consumer, generation, {
              ...(publish.length > 0 ? { publish } : {}),
              ...(body.effects ? { effects: effectList(body.effects) } : {}),
            });
            // Committed, not yet answered: the window a consumer's retried ack
            // has to survive. `--fault post-ack` crashes exactly here.
            fault("post-ack");
            return json(acked);
          }
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

        // --------------------------------------------------- effect ledger
        // Tier 3. `claim` hands out the right to make one external call;
        // `record` writes down what it returned so a redelivery replays the
        // result instead of repeating the call. A consumer that can claim work
        // can use the ledger — it is scoped to the token's workspace like
        // everything else.
        if (req.method === "POST" && path === "/api/effects/claim") {
          if (claims.scope === "reader")
            throw new BusError("a reader token may not claim effects", 403);
          requireRoom(store);
          return json(
            store.claimEffect(
              workspace,
              str(body.key, "key", 400),
              optionalStr(body.fence, "fence", 200),
            ),
          );
        }
        if (req.method === "POST" && path === "/api/effects/record") {
          if (claims.scope === "reader")
            throw new BusError("a reader token may not record effects", 403);
          requireRoom(store);
          store.recordEffect(workspace, {
            key: str(body.key, "key", 400),
            result: (body.result ?? null) as Json,
          });
          return json({ ok: true });
        }
        const effect = /^\/api\/effects\/([^/]+)$/.exec(path);
        if (req.method === "GET" && effect) {
          requireRead(claims);
          const found = store.effect(workspace, decodeURIComponent(effect[1]!));
          return found ? json(found) : json({ error: "not found" }, 404);
        }

        // -------------------------------------------------- request/reply
        if (req.method === "POST" && path === "/api/requests") {
          const subject = str(body.subject, "subject", 512);
          authorizePublish(claims, subject);
          limit(publishes, claims);
          requireRoom(store);
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
              ...(body.priority !== undefined
                ? { priority: int(body.priority, "priority") }
                : {}),
              ...(body.delayMs !== undefined
                ? { delayMs: int(body.delayMs, "delayMs") }
                : {}),
              ...(body.deliverAt !== undefined
                ? { deliverAt: int(body.deliverAt, "deliverAt") }
                : {}),
            },
            claims.sub,
          );
          const correlation = published.correlation!;
          const deadline = Date.now() + waitMs;
          parked++;
          try {
            for (;;) {
              if (req.signal.aborted)
                return json({ ...published, response: null }, 202);
              // Draining answers now. The message is published and the
              // correlation is durable, so the caller collects the reply from
              // whichever process is serving next — which is the whole point
              // of a response being recorded rather than streamed.
              if (draining)
                return json({ ...published, response: null }, 202);
              const response = store.response(workspace, correlation);
              if (response) return json({ ...published, response });
              if (Date.now() >= deadline)
                return json({ ...published, response: null }, 202);
              await Bun.sleep(Math.min(200, Math.max(1, deadline - Date.now())));
            }
          } finally {
            parked--;
          }
        }
        const request = /^\/api\/requests\/([^/]+)$/.exec(path);
        if (req.method === "GET" && request) {
          const waitMs = Math.min(
            maxWaitMs,
            Math.max(0, Number(url.searchParams.get("waitMs") ?? 0)),
          );
          const deadline = Date.now() + waitMs;
          parked++;
          try {
            for (;;) {
              if (req.signal.aborted)
                return json({ error: "client went away" }, 499);
              if (draining) return json({ error: "no response yet" }, 404);
              const response = store.response(workspace, request[1]!);
              if (response) return json(response);
              if (Date.now() >= deadline)
                return json({ error: "no response yet" }, 404);
              await Bun.sleep(Math.min(200, Math.max(1, deadline - Date.now())));
            }
          } finally {
            parked--;
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
          const subject = url.searchParams.get("subject");
          return json(
            await store.log(
              workspace,
              Number(url.searchParams.get("after") ?? 0),
              Number(url.searchParams.get("limit") ?? 100),
              {
                ...(subject ? { subject } : {}),
                ...(url.searchParams.get("newest") === "true"
                  ? { newest: true }
                  : {}),
              },
            ),
          );
        }
        // Requeueing a dead letter is an ordinary publish onto the subject it
        // failed on, so it is admin like every other operator action — not the
        // publisher's, whose token may not even grant that subject any more.
        const requeue = /^\/api\/messages\/(\d+)\/requeue$/.exec(path);
        if (req.method === "POST" && requeue) {
          requireAdmin(claims);
          audit(claims, "message.requeue", requeue[1]!, workspace);
          return json(store.requeue(workspace, Number(requeue[1]!)), 201);
        }
        if (req.method === "GET" && path === "/api/stream") {
          requireRead(claims);
          return stream(req, store, streams);
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

        // -------------------------------------------------------- schemas
        // Registering and binding are admin actions: a schema is a contract
        // between publishers and consumers, and a publisher that could rewrite
        // it could license itself.
        if (req.method === "POST" && path === "/api/schemas") {
          requireAdmin(claims);
          const compat = str(body.compat ?? "backward", "compat", 10);
          if (!["backward", "forward", "full", "none"].includes(compat))
            throw new BusError(
              "compat must be backward, forward, full or none",
              400,
            );
          const registered = store.registerSchema(
            workspace,
            str(body.name, "name", 100),
            (body.source ?? null) as Json,
            compat as CompatMode,
          );
          audit(claims, "schema.register", registered.name);
          return json(registered, 201);
        }
        if (req.method === "GET" && path === "/api/schemas") {
          requireRead(claims);
          const name = url.searchParams.get("name");
          return json(store.schemaVersions(workspace, name ?? undefined));
        }
        // A dry run: what would change, and what would break, without writing.
        if (req.method === "POST" && path === "/api/schemas/check") {
          requireRead(claims);
          const compat = str(body.compat ?? "backward", "compat", 10);
          return json(
            store.checkSchema(
              workspace,
              str(body.name, "name", 100),
              (body.source ?? null) as Json,
              compat as CompatMode,
            ),
          );
        }
        if (req.method === "POST" && path === "/api/schemas/bindings") {
          requireAdmin(claims);
          const mode = str(body.mode ?? "warn", "mode", 10);
          if (!["enforce", "warn", "off"].includes(mode))
            throw new BusError("mode must be enforce, warn or off", 400);
          const bound = store.bindSchema(
            workspace,
            str(body.pattern, "pattern", 512),
            str(body.schema, "schema", 100),
            mode as SchemaMode,
          );
          audit(claims, "schema.bind", `${bound.pattern} -> ${bound.schema}`);
          return json(bound, 201);
        }
        if (req.method === "GET" && path === "/api/schemas/bindings") {
          requireRead(claims);
          return json(store.schemaBindings(workspace));
        }
        if (req.method === "DELETE" && path === "/api/schemas/bindings") {
          requireAdmin(claims);
          const pattern = url.searchParams.get("pattern");
          if (!pattern) throw new BusError("pattern is required", 400);
          audit(claims, "schema.unbind", pattern);
          return json(store.unbindSchema(workspace, pattern));
        }
        // The keyword subset, served rather than only documented: a schema
        // author should be able to ask the build they are talking to.
        if (req.method === "GET" && path === "/api/schemas/keywords")
          return json({ dialect: "2020-12", supported: SUPPORTED_KEYWORDS });

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
          const token = mint(issued, keys);
          audit(claims, "token.mint", `${issued.sub} (${issued.scope})`);
          return json({ token, claims: issued }, 201);
        }
        // Revocation. `jti` rather than the token itself, so revoking does not
        // require handing the credential back to the bus to be stored.
        if (req.method === "POST" && path === "/api/tokens/revoke") {
          requireAdmin(claims);
          const jti = str(body.jti, "jti", 100);
          store.revoke(jti, int(body.notAfter, "notAfter", 0));
          audit(claims, "token.revoke", jti);
          return json({ revoked: jti });
        }
        if (req.method === "GET" && path === "/api/tokens/revoked") {
          requireAdmin(claims);
          return json(store.revocations());
        }

        // ---------------------------------------------------- tenant safety
        if (req.method === "GET" && path === "/api/quota") {
          requireRead(claims);
          return json({
            quota: store.quota(workspace),
            usage: store.usage(workspace),
          });
        }
        if (req.method === "POST" && path === "/api/quota") {
          requireAdmin(claims);
          const quota = store.setQuota(workspace, {
            ...(body.maxMessages !== undefined
              ? { maxMessages: int(body.maxMessages, "maxMessages") }
              : {}),
            ...(body.maxBytes !== undefined
              ? { maxBytes: int(body.maxBytes, "maxBytes") }
              : {}),
            ...(body.maxSubscriptions !== undefined
              ? { maxSubscriptions: int(body.maxSubscriptions, "maxSubscriptions") }
              : {}),
          });
          audit(claims, "quota.set", JSON.stringify(quota), workspace);
          return json(quota);
        }
        // Readable by a reader token, because "who purged my subscription" is
        // a question a tenant has to be able to answer about their own
        // workspace without an admin credential.
        if (req.method === "GET" && path === "/api/audit") {
          requireRead(claims);
          return json(
            store.auditLog(workspace, Number(url.searchParams.get("limit") ?? 100)),
          );
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
        if (error instanceof SchemaError)
          return json(
            {
              error: `${error.message}${error.pointer ? ` at ${error.pointer}` : ""}`,
            },
            400,
          );
        if (error instanceof RateLimited)
          return new Response(
            JSON.stringify({
              error: "rate limit exceeded",
              retryAfterMs: error.retryAfterMs,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)),
              },
            },
          );
        // SQLITE_FULL arriving from whichever statement happened to need a
        // page. The watermark above should have caught this first; when it
        // does not — a quota-bound volume, another process filling the disk —
        // the answer is still 507 rather than a 500 that reads as a bug.
        if (
          error instanceof Error &&
          /database or disk is full|SQLITE_FULL|disk I\/O error/i.test(error.message)
        ) {
          log.error("the bus is out of disk", { path, error: error.message });
          return json(
            { error: `${error.message} (reason=disk-full)` },
            507,
          );
        }
        log.error("the bus could not commit an operation", {
          path,
          method: req.method,
          error: error instanceof Error ? error.message : String(error),
        });
        return json({ error: "the bus could not commit the operation" }, 500);
      }
    },
  });

  return {
    // Bun types these as optional because a unix-socket server has neither;
    // this one always listens on TCP.
    hostname: server.hostname ?? "127.0.0.1",
    port: server.port ?? 0,
    get draining() {
      return draining;
    },
    stop(force = false) {
      draining = true;
      for (const close of [...streams]) close();
      void server.stop(force);
    },
    shutdown({ timeoutMs = 15_000 } = {}) {
      // Idempotent, and correct even after `stop()` has already set `draining`
      // — the flag alone is not evidence that anything was awaited.
      shuttingDown ??= (async () => {
        draining = true;
        log.info("draining", { parked, streams: streams.size });
        const deadline = Date.now() + timeoutMs;
        while (parked > 0 && Date.now() < deadline) await Bun.sleep(25);
        if (parked > 0)
          log.warn("closing with long polls still parked", { parked });
        // An SSE stream is a response that never completes, so it has to be
        // ended explicitly before waiting on in-flight requests.
        for (const close of [...streams]) close();
        // `stop(false)` lets requests already in flight finish; `true` would
        // cut an ack off at the socket, which is the one thing worth waiting
        // for.
        await server.stop(false);
        log.info("stopped");
      })();
      return shuttingDown;
    },
  };
}

/**
 * Counters as they accumulated, plus gauges read at scrape time.
 *
 * A gauge that is only written when something moves is stale exactly when it
 * matters — an idle subscription with a thousand pending deliveries would keep
 * reporting whatever it last reported. So depth, lag and consumer counts are
 * read from the store here, per workspace, on every scrape.
 *
 * They go into a **fresh registry** each time rather than the long-lived one:
 * a gauge written once stays in a registry forever, so a deleted subscription
 * would have gone on reporting its final lag until the process restarted.
 * Counters are cumulative and stay where they are.
 */
function renderMetrics(
  store: BusStore,
  counters: PrometheusMetrics,
  only?: string,
): string {
  const gauges = prometheusMetrics();
  // Install-wide, so they carry no workspace label: one process owns one file,
  // and the disk it is on is not any tenant's property. A tenant scrape does
  // not get them, for the same reason.
  if (only === undefined) {
    const sizes = store.sizes();
    gauges.gauge("bql-bus.db_bytes", sizes.dbBytes);
    gauges.gauge("bql-bus.wal_bytes", sizes.walBytes);
    gauges.gauge("bql-bus.disk_free_bytes", sizes.freeBytes);
    gauges.gauge("bql-bus.writable", store.capacity().ok ? 1 : 0);
  }
  for (const workspace of store.workspaces()) {
    if (only !== undefined && workspace !== only) continue;
    const stats = store.stats(workspace);
    gauges.gauge("bql-bus.messages", stats.messages, { workspace });
    gauges.gauge("bql-bus.last_seq", stats.lastSeq, { workspace });
    gauges.gauge("bql-bus.consumers", stats.consumers.length, { workspace });
    // Only where a quota exists. `usage` sums `body_bytes` across the
    // workspace's whole log, which is a full scan — worth paying to show a
    // tenant how close they are to a ceiling, not worth paying on every scrape
    // of an install that has no ceilings.
    const quota = store.quota(workspace);
    if (quota.maxBytes > 0 || quota.maxMessages > 0) {
      const used = store.usage(workspace);
      gauges.gauge("bql-bus.workspace.bytes", used.bytes, { workspace });
      gauges.gauge("bql-bus.workspace.quota_bytes", quota.maxBytes, { workspace });
      gauges.gauge("bql-bus.workspace.quota_messages", quota.maxMessages, {
        workspace,
      });
    }
    gauges.gauge(
      "bql-bus.consumers_live",
      stats.consumers.filter((c) => !c.paused && stats.now - c.lastSeen < 60_000)
        .length,
      { workspace },
    );
    for (const subscription of stats.subscriptions) {
      const tags = { workspace, subscription: subscription.name };
      gauges.gauge("bql-bus.subscription.lag", subscription.lag, tags);
      gauges.gauge("bql-bus.subscription.paused", subscription.paused ? 1 : 0, tags);
      for (const status of ["pending", "leased", "acked", "dead", "cancelled"] as const)
        gauges.gauge("bql-bus.subscription.deliveries", subscription[status], {
          ...tags,
          status,
        });
    }
  }
  const include =
    only === undefined ? undefined : (tags: { workspace?: string }) => tags.workspace === only;
  return `${counters.render(include)}${gauges.render(include)}`;
}

/** SSE: a sequence number, not a durable subscription. Re-read after it moves. */
function stream(
  req: Request,
  store: BusStore,
  open: Set<() => void>,
): Response {
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
        open.delete(cleanup);
        req.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {}
      };
      open.add(cleanup);
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
  // A compiled binary carries the dashboard inside it. `Bun.file` on an
  // embedded path works in the compiled build and on disk in a checkout, so
  // this is one code path rather than two.
  const embedded =
    EMBEDDED_ASSETS[path] ??
    (path.startsWith("/assets/") ? undefined : EMBEDDED_ASSETS["/index.html"]);
  if (embedded !== undefined) {
    const file = Bun.file(embedded);
    if (path.startsWith("/assets/")) return new Response(file);
    const html = (await file.text()).replace(
      "</head>",
      `<script>window.__BUS_TOKEN=${JSON.stringify(readerToken())}</script></head>`,
    );
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
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
