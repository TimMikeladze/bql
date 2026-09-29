import type {
  AckResult,
  AuditEntry,
  BlockedKey,
  CancelResult,
  Consumer,
  Delivery,
  EffectClaim,
  EffectRecord,
  Envelope,
  ExtendResult,
  Json,
  Message,
  PublishRequest,
  PublishResult,
  Quota,
  RegisterConsumer,
  Response as BusResponse,
  Schedule,
  ScheduleRequest,
  SchemaBinding,
  SchemaCheck,
  SchemaVersion,
  Stats,
  SubscribeRequest,
  Subscription,
  Usage,
} from "../shared/protocol";
import { DEFAULT_WORKSPACE } from "../shared/protocol";

/**
 * The client half of the bus: a typed wrapper over the HTTP API, plus a
 * consume loop.
 *
 * Kept free of any dependency but the wire types, so a producer or consumer can
 * be an ordinary script, a service, or an agent runtime without dragging a
 * workflow engine in with it.
 */

export interface ClientOptions {
  url: string;
  token: string;
  workspace?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Long-polling calls add their wait on top. */
  timeoutMs?: number;
}

/**
 * [Standard Schema](https://standardschema.dev), declared rather than imported.
 *
 * It is an *interface*, not a package: any library that implements it — Zod,
 * Valibot, ArkType — satisfies this without the bus depending on any of them,
 * so zero runtime dependencies holds. It is a client-side convenience for
 * local validation and TypeScript inference; the wire contract is the JSON
 * Schema in the registry, and this is never the source of truth.
 */
export interface StandardSchemaV1<Output = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { value: Output; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }> }
      | Promise<
          | { value: Output; issues?: undefined }
          | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }> }
        >;
    readonly types?: { readonly input: unknown; readonly output: Output };
  };
}

/** Thrown when a body fails the caller's own schema, before it reaches the bus. */
export class LocalValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }>) {
    super(
      `the body does not match the schema: ${issues
        .map(
          (issue) =>
            `${(issue.path ?? []).map((part) => String(part)).join(".") || "/"} ${issue.message}`,
        )
        .join("; ")}`,
    );
    this.name = "LocalValidationError";
  }
}

export class BusRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class BusClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  /** The workspace this client asks for; the token may pin another. */
  get workspace(): string {
    return this.options.workspace ?? DEFAULT_WORKSPACE;
  }

  constructor(private readonly options: ClientOptions) {
    this.base = options.url.replace(/\/$/, "");
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async call<T>(
    path: string,
    body?: unknown,
    {
      method,
      extraWaitMs = 0,
      signal,
    }: { method?: string; extraWaitMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs + extraWaitMs);
    const response = await this.doFetch(`${this.base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(this.options.workspace
          ? { "x-bus-workspace": this.options.workspace }
          : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A caller's signal composes with the timeout rather than replacing it:
      // a long poll that is abandoned should end now, and one that is merely
      // slow should still end eventually.
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok)
      throw new BusRequestError(
        payload.error ?? `HTTP ${response.status}`,
        response.status,
      );
    return payload as T;
  }

  /**
   * Publish, optionally validating the body locally first.
   *
   * Passing `schema` catches a bad body in the producer, where the stack trace
   * is, instead of as a 422 from a broker that cannot tell you which line
   * built it. The bus still validates against the registry — this does not
   * replace that, and a client-side schema is never the contract.
   */
  async publish(
    request: PublishRequest & { schema?: StandardSchemaV1 },
  ): Promise<PublishResult> {
    const { schema, ...rest } = request;
    if (schema) {
      const result = await schema["~standard"].validate(rest.body ?? null);
      if (result.issues) throw new LocalValidationError(result.issues);
    }
    return this.call<PublishResult>("/api/publish", rest);
  }

  /**
   * Publish up to 1000 messages in one request and one bus transaction — all
   * of them or none. Dedupe applies per message.
   */
  async publishBatch(messages: PublishRequest[]): Promise<PublishResult[]> {
    const { results } = await this.call<{ results: PublishResult[] }>(
      "/api/publish/batch",
      { messages },
    );
    return results;
  }

  /** Publish and wait for a reply, up to `waitMs`. */
  request(
    request: PublishRequest & { waitMs?: number },
  ): Promise<PublishResult & { response: BusResponse | null }> {
    return this.call("/api/requests", request, {
      extraWaitMs: request.waitMs ?? 0,
    });
  }

  /** Collect a reply published after the caller gave up waiting. */
  async response(
    correlation: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<BusResponse | null> {
    try {
      return await this.call<BusResponse>(
        `/api/requests/${encodeURIComponent(correlation)}?waitMs=${waitMs}`,
        undefined,
        { extraWaitMs: waitMs, ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      if (error instanceof BusRequestError && error.status === 404) return null;
      throw error;
    }
  }

  /** Answer a request: publishes to its reply subject and records the response. */
  reply(
    message: Message,
    body: Json,
    headers: Record<string, string> = {},
  ): Promise<PublishResult> {
    const correlation = message.headers.correlation;
    if (!correlation)
      throw new Error("that message carries no correlation to reply to");
    return this.call<PublishResult>("/api/publish", {
      subject: message.headers["reply-to"] ?? "reply",
      correlation,
      body,
      headers,
      // Explicit: this publish is an answer, not a new request.
      reply: true,
    });
  }

  subscribe(request: SubscribeRequest): Promise<Subscription> {
    return this.call<Subscription>("/api/subscriptions", request);
  }
  subscriptions(): Promise<Subscription[]> {
    return this.call<Subscription[]>("/api/subscriptions");
  }
  stats(): Promise<Stats> {
    return this.call<Stats>("/api/stats");
  }
  log(
    after = 0,
    limit = 100,
    options: { subject?: string; newest?: boolean } = {},
  ): Promise<Message[]> {
    const query = new URLSearchParams({
      after: String(after),
      limit: String(limit),
      ...(options.subject ? { subject: options.subject } : {}),
      ...(options.newest ? { newest: "true" } : {}),
    });
    return this.call<Message[]>(`/api/log?${query}`);
  }
  /** Dead letters for a subscription, newest first. */
  async deadLetters(subscription: string, limit = 50): Promise<Message[]> {
    const { dlqSubject } = await this.call<Subscription>(
      `/api/subscriptions/${subscription}`,
    );
    return this.log(0, limit, { subject: dlqSubject, newest: true });
  }
  /** Republish a dead letter onto the subject it originally failed on. */
  requeue(seq: number): Promise<PublishResult> {
    return this.call<PublishResult>(`/api/messages/${seq}/requeue`, {});
  }
  /** Keys an ordered subscription is stalled on behind a dead letter. */
  blockedKeys(subscription: string): Promise<BlockedKey[]> {
    return this.call<BlockedKey[]>(
      `/api/subscriptions/${subscription}/blocked`,
    );
  }
  /** Let one blocked key move again. Admin. */
  unblock(subscription: string, key: string): Promise<{ unblocked: boolean }> {
    return this.call<{ unblocked: boolean }>(
      `/api/subscriptions/${subscription}/unblock`,
      { key },
    );
  }
  pause(subscription: string, paused: boolean): Promise<Subscription> {
    return this.call<Subscription>(
      `/api/subscriptions/${subscription}/pause`,
      { paused },
    );
  }
  message(seq: number): Promise<Message> {
    return this.call<Message>(`/api/messages/${seq}`);
  }
  replay(subscription: string, fromSeq: number) {
    return this.call(`/api/subscriptions/${subscription}/replay`, { fromSeq });
  }
  purge(subscription: string, fromSeq = 0) {
    return this.call<{ removed: number }>(
      `/api/subscriptions/${subscription}/purge`,
      { fromSeq },
    );
  }

  claim(
    subscription: string,
    consumer: string,
    max = 1,
    waitMs = 0,
  ): Promise<Envelope[]> {
    return this.call<Envelope[]>(
      `/api/subscriptions/${subscription}/claim`,
      { consumer, max, waitMs },
      { extraWaitMs: waitMs },
    );
  }
  /**
   * Ack, optionally committing what the work produced in the same transaction.
   *
   * A retry of an ack this consumer already made answers 200 with
   * `replayed: true` rather than a 409 — losing the response to an ack is a
   * network event, not a conflict.
   */
  ack(
    delivery: Delivery,
    consumer: string,
    options: { publish?: PublishRequest[]; effects?: EffectRecord[] } = {},
  ): Promise<AckResult> {
    return this.call<AckResult>(`/api/deliveries/${delivery.id}/ack`, {
      consumer,
      generation: delivery.generation,
      ...options,
    });
  }

  // ------------------------------------------------------------ schemas
  registerSchema(
    name: string,
    source: Json,
    compat: "backward" | "forward" | "full" | "none" = "backward",
  ): Promise<SchemaVersion> {
    return this.call<SchemaVersion>("/api/schemas", { name, source, compat });
  }
  /** A dry run: what would change, and what would break. */
  checkSchema(
    name: string,
    source: Json,
    compat: "backward" | "forward" | "full" | "none" = "backward",
  ): Promise<SchemaCheck> {
    return this.call<SchemaCheck>("/api/schemas/check", { name, source, compat });
  }
  schemas(name?: string): Promise<SchemaVersion[]> {
    return this.call<SchemaVersion[]>(
      `/api/schemas${name ? `?name=${encodeURIComponent(name)}` : ""}`,
    );
  }
  bindSchema(
    pattern: string,
    schema: string,
    mode: "enforce" | "warn" | "off" = "warn",
  ): Promise<SchemaBinding> {
    return this.call<SchemaBinding>("/api/schemas/bindings", {
      pattern,
      schema,
      mode,
    });
  }
  schemaBindings(): Promise<SchemaBinding[]> {
    return this.call<SchemaBinding[]>("/api/schemas/bindings");
  }
  unbindSchema(pattern: string): Promise<{ removed: number }> {
    return this.call<{ removed: number }>(
      `/api/schemas/bindings?pattern=${encodeURIComponent(pattern)}`,
      undefined,
      { method: "DELETE" },
    );
  }

  // ---------------------------------------------------------- schedules
  /** Create or replace a cron schedule. Admin. */
  putSchedule(request: ScheduleRequest): Promise<Schedule> {
    const { name, ...rest } = request;
    return this.call<Schedule>(
      `/api/schedules/${encodeURIComponent(name)}`,
      rest,
      { method: "PUT" },
    );
  }
  schedules(): Promise<Schedule[]> {
    return this.call<Schedule[]>("/api/schedules");
  }
  schedule(name: string): Promise<Schedule> {
    return this.call<Schedule>(`/api/schedules/${encodeURIComponent(name)}`);
  }
  deleteSchedule(name: string): Promise<{ deleted: string }> {
    return this.call<{ deleted: string }>(
      `/api/schedules/${encodeURIComponent(name)}`,
      undefined,
      { method: "DELETE" },
    );
  }
  pauseSchedule(name: string): Promise<Schedule> {
    return this.call<Schedule>(
      `/api/schedules/${encodeURIComponent(name)}/pause`,
      {},
    );
  }
  resumeSchedule(name: string): Promise<Schedule> {
    return this.call<Schedule>(
      `/api/schedules/${encodeURIComponent(name)}/resume`,
      {},
    );
  }
  /** Fire once now, outside the cadence. Does not move `nextAt`. */
  runSchedule(name: string): Promise<PublishResult> {
    return this.call<PublishResult>(
      `/api/schedules/${encodeURIComponent(name)}/run`,
      {},
    );
  }

  // ------------------------------------------------------ tenant safety
  revokeToken(jti: string, notAfter = 0): Promise<{ revoked: string }> {
    return this.call<{ revoked: string }>("/api/tokens/revoke", {
      jti,
      notAfter,
    });
  }
  quota(): Promise<{ quota: Quota; usage: Usage }> {
    return this.call<{ quota: Quota; usage: Usage }>("/api/quota");
  }
  setQuota(quota: Partial<Quota>): Promise<Quota> {
    return this.call<Quota>("/api/quota", quota);
  }
  auditLog(limit = 100): Promise<AuditEntry[]> {
    return this.call<AuditEntry[]>(`/api/audit?limit=${limit}`);
  }

  /** Claim the right to perform an external effect exactly once. */
  claimEffect(key: string, fence?: string): Promise<EffectClaim> {
    return this.call<EffectClaim>("/api/effects/claim", {
      key,
      ...(fence ? { fence } : {}),
    });
  }
  /** Record what an effect returned, outside an ack. */
  recordEffect(key: string, result: Json): Promise<{ ok: true }> {
    return this.call<{ ok: true }>("/api/effects/record", { key, result });
  }

  /** Register or refresh this consumer's presence in the fleet. */
  register(input: RegisterConsumer): Promise<Consumer> {
    return this.call<Consumer>("/api/consumers/register", input);
  }
  nack(
    delivery: Delivery,
    consumer: string,
    options: { error?: string; fatal?: boolean; delayMs?: number } = {},
  ): Promise<Delivery> {
    return this.call<Delivery>(`/api/deliveries/${delivery.id}/nack`, {
      consumer,
      generation: delivery.generation,
      ...options,
    });
  }
  extend(delivery: Delivery, consumer: string): Promise<ExtendResult> {
    return this.call<ExtendResult>(`/api/deliveries/${delivery.id}/extend`, {
      consumer,
      generation: delivery.generation,
    });
  }

  /**
   * Cancel a message: every unfinished delivery of it stops, and no
   * subscription will create a new one. Admin, or the token that published it.
   */
  cancelMessage(seq: number): Promise<CancelResult> {
    return this.call<CancelResult>(`/api/messages/${seq}/cancel`, {});
  }
  /** Cancel one subscription's copy, leaving every other subscription alone. */
  cancelDelivery(deliveryId: string): Promise<CancelResult> {
    return this.call<CancelResult>(
      `/api/deliveries/${encodeURIComponent(deliveryId)}/cancel`,
      {},
    );
  }
}

/**
 * What a consume loop needs from a bus.
 *
 * `BusClient` implements it over HTTP; the embedded bus implements it against
 * the store directly, with no loopback socket. Naming it is what lets one
 * `BusConsumer` drive both.
 */
export interface BusApi {
  publish(request: PublishRequest): Promise<PublishResult>;
  claim(
    subscription: string,
    consumer: string,
    max?: number,
    waitMs?: number,
  ): Promise<Envelope[]>;
  ack(
    delivery: Delivery,
    consumer: string,
    options?: { publish?: PublishRequest[]; effects?: EffectRecord[] },
  ): Promise<AckResult>;
  nack(
    delivery: Delivery,
    consumer: string,
    options?: { error?: string; fatal?: boolean; delayMs?: number },
  ): Promise<Delivery>;
  extend(delivery: Delivery, consumer: string): Promise<ExtendResult>;
  reply(
    message: Message,
    body: Json,
    headers?: Record<string, string>,
  ): Promise<PublishResult>;
  register(input: RegisterConsumer): Promise<Consumer>;
  claimEffect(key: string, fence?: string): Promise<EffectClaim>;
}

export interface ConsumerOptions {
  client: BusApi;
  /** Consumer id. Must match the token's subject unless the token is admin. */
  id: string;
  subscription: string;
  handle: (envelope: Envelope, api: HandlerApi) => Promise<Json | void>;
  name?: string;
  host?: string;
  labels?: Record<string, string>;
  /** Deliveries leased at once. Raise for I/O-bound work. */
  prefetch?: number;
  /** How long a claim waits for work before returning empty. */
  waitMs?: number;
  /**
   * Upper bound on the lease-renewal interval. The real interval is derived
   * from the lease the bus actually granted, so a short ack window cannot
   * silently starve every consumer in the fleet.
   */
  maxExtendMs?: number;
  /**
   * Longest a single handler may run before it is aborted and the delivery
   * nacked.
   *
   * Without one, a handler that hangs holds its message indefinitely: this loop
   * keeps renewing the lease for as long as the promise is pending, so the very
   * mechanism that protects slow work also protects stuck work. Unset means no
   * limit, which is only right when the handler bounds itself.
   */
  handlerTimeoutMs?: number;
  /** How many times a lost ack response is retried. The ack is idempotent. */
  ackRetries?: number;
  log?: (message: string) => void;
}

export interface HandlerApi {
  /** Renew the lease. Call it from a long handler that risks the ack window. */
  extend(): Promise<void>;
  /** Answer a request message. Returning a value from `handle` does this too. */
  reply(body: Json, headers?: Record<string, string>): Promise<void>;
  /**
   * Publish **with the ack**, in one transaction (Tier 2).
   *
   * The difference from `client.publish` inside a handler is the whole point:
   * that publishes now and acks later, so a crash between them duplicates the
   * message on redelivery. This one cannot produce a message the ack did not
   * also commit.
   */
  emit(request: PublishRequest): void;
  /**
   * Perform an external effect at most once (Tier 3).
   *
   * Claims `key` in the ledger; if a previous attempt already recorded a
   * result, `work` is not called and that result is returned. The result of a
   * fresh call is recorded **with the ack**, so the ledger row and the ack
   * commit together.
   *
   * The window this does not close, stated plainly: a crash between `work`
   * returning and the ack committing. `fence` is on the envelope for exactly
   * that case — a destination that supports a conditional write can reject the
   * older attempt.
   */
  effect<T extends Json>(key: string, work: () => Promise<T> | T): Promise<T>;
  /** `<deliveryId>:<generation>` — this attempt, for conditional writes. */
  fence: string;
  signal: AbortSignal;
}

/** Thrown by a handler to dead-letter immediately, skipping remaining attempts. */
export class FatalError extends Error {}

/**
 * The abort reason when this consumer is shutting down.
 *
 * Distinguishable from a handler timeout on purpose: the delivery is nacked
 * with zero delay rather than the subscription's backoff, because nothing about
 * the *message* failed.
 */
export class ShutdownError extends Error {
  constructor(message = "shutting down") {
    super(message);
    this.name = "ShutdownError";
  }
}

/**
 * The abort reason when the publisher — or an operator — cancelled this work.
 *
 * Distinguishable from every other abort on purpose: a cancelled delivery is
 * already terminal on the bus, so the loop must not nack it, and a handler that
 * wants to tell cancellation apart from a timeout can.
 */
export class CancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/**
 * A consume loop: claim, run, ack.
 *
 * A handler that returns normally acks. A handler that throws nacks, and the
 * delivery is retried until the subscription's `maxAttempts` is spent, after
 * which the bus dead-letters it. Throwing `FatalError` skips straight to the
 * dead letter, because a message this consumer can never handle should not be
 * tried four more times.
 *
 * If the message carried a `reply-to`, whatever the handler returns is
 * published as its response — so an RPC consumer is an ordinary consumer that
 * happens to return a value.
 */
export class BusConsumer {
  private stopping = false;
  private running = new Set<Promise<void>>();
  /** In-flight work, so a shutdown can hand it back instead of abandoning it. */
  private inFlight = new Map<string, AbortController>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: ConsumerOptions) {
    this.log = options.log ?? (() => {});
  }

  /**
   * Stop claiming, and give back what is in flight.
   *
   * `abandon` — the default — aborts running handlers and nacks their
   * deliveries with **no delay**, so another consumer picks them up
   * immediately. Letting the leases expire instead costs one `ackWaitMs` of
   * dead time per in-flight message on every deploy, for nothing: the process
   * knows it is going away, and saying so is one request.
   *
   * `stop({ abandon: false })` is the other reasonable choice — finish what is
   * running, claim nothing new — for a consumer whose handlers are short and
   * whose work is not safe to interrupt.
   */
  stop(options: { abandon?: boolean } = {}) {
    this.stopping = true;
    if (options.abandon === false) return;
    for (const abort of this.inFlight.values())
      abort.abort(new ShutdownError("the consumer is shutting down"));
  }

  /**
   * Ack, retrying a lost response.
   *
   * Only transport failures and 5xx are retried: a 409 means someone else owns
   * the delivery now and retrying that would be a busy loop around a fact that
   * will not change. The bus answers a repeat from the same consumer and
   * generation with the original outcome, so this cannot double-publish
   * whatever the ack carried.
   */
  private async ackWithRetry(
    envelope: Envelope,
    options: { publish?: PublishRequest[]; effects?: EffectRecord[] },
  ): Promise<void> {
    const attempts = this.options.ackRetries ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.options.client.ack(envelope.delivery, this.options.id, options);
        return;
      } catch (error) {
        const status =
          error instanceof BusRequestError ? error.status : undefined;
        const worthRetrying = status === undefined || status >= 500;
        if (!worthRetrying || attempt >= attempts) throw error;
        await Bun.sleep(Math.min(2000, 100 * 2 ** (attempt - 1)));
      }
    }
  }

  private async runOne(envelope: Envelope) {
    const { client, id } = this.options;
    const abort = new AbortController();
    this.inFlight.set(envelope.delivery.id, abort);
    // Three renewals inside the granted lease: one lost request must not cost
    // the message. Reading the lease from the delivery rather than assuming a
    // constant is what keeps a 2s ack window working.
    const granted = Math.max(
      1000,
      (envelope.delivery.leaseUntil ?? Date.now() + 30_000) - Date.now(),
    );
    const extendMs = Math.max(
      250,
      Math.min(this.options.maxExtendMs ?? 10_000, Math.floor(granted / 3)),
    );
    // The lease renewal is also the cancellation channel: a consumer running a
    // long handler is already talking to the bus on a timer, so cancellation
    // needs no push and no second connection.
    const cancelled = () => abort.signal.reason instanceof CancelledError;
    const timer = setInterval(() => {
      void client
        .extend(envelope.delivery, id)
        .then((result) => {
          if (result.cancelled)
            abort.abort(new CancelledError("cancelled by the publisher"));
        })
        .catch(() => abort.abort(new Error("lease lost")));
    }, extendMs);
    // Collected during the handler, committed with the ack.
    const emitted: PublishRequest[] = [];
    const effects: EffectRecord[] = [];
    const api: HandlerApi = {
      extend: async () => {
        const result = await client.extend(envelope.delivery, id);
        if (result.cancelled) {
          const error = new CancelledError("cancelled by the publisher");
          abort.abort(error);
          throw error;
        }
      },
      reply: async (body, headers) => {
        await client.reply(envelope.message, body, headers);
      },
      emit: (request) => {
        emitted.push(request);
      },
      effect: async <T extends Json>(key: string, work: () => Promise<T> | T) => {
        const claimed = await client.claimEffect(key, envelope.fence);
        if (!claimed.fresh) return claimed.result as T;
        const value = await work();
        effects.push({ key, result: value });
        return value;
      },
      fence: envelope.fence,
      signal: abort.signal,
    };
    const timeoutMs = this.options.handlerTimeoutMs;
    const deadline =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => abort.abort(new Error(`handler exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
    try {
      const result = await Promise.race([
        this.options.handle(envelope, api),
        new Promise<never>((_, reject) => {
          if (abort.signal.aborted) reject(abort.signal.reason);
          else
            abort.signal.addEventListener(
              "abort",
              () => reject(abort.signal.reason),
              { once: true },
            );
        }),
      ]);
      // A handler that swallows its abort signal and returns normally has
      // still been cancelled: the delivery is already terminal, so replying or
      // acking would only fail as a stale lease.
      if (cancelled()) {
        this.log(`[${id}] ${envelope.message.subject} cancelled`);
        return;
      }
      // A reply becomes one of the ack's publishes rather than a separate
      // call: it then commits with the ack, so a crash cannot leave a message
      // answered but unacked — which is how a handler runs twice and the
      // caller gets two different answers.
      if (envelope.message.headers.correlation && result !== undefined)
        emitted.push({
          subject: envelope.message.headers["reply-to"] ?? "reply",
          correlation: envelope.message.headers.correlation,
          body: result as Json,
          reply: true,
        });
      // Retry the ack, because the ack is now idempotent for its own consumer
      // and a lost *response* is the commonest way at-least-once turns into a
      // duplicate. Before this, one dropped response meant the handler ran
      // again on the next attempt for work that was already finished.
      await this.ackWithRetry(envelope, {
        ...(emitted.length > 0 ? { publish: emitted } : {}),
        ...(effects.length > 0 ? { effects } : {}),
      });
    } catch (error) {
      // Cancelled work is neither acked nor nacked. The bus has already moved
      // the delivery to `cancelled`, which is terminal: a nack would be
      // rejected as a stale lease, and a retry would be the opposite of what
      // was asked for.
      if (error instanceof CancelledError || cancelled()) {
        this.log(`[${id}] ${envelope.message.subject} cancelled`);
        return;
      }
      const message = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 4000);
      this.log(`[${id}] ${envelope.message.subject} failed: ${message}`);
      await client
        .nack(envelope.delivery, id, {
          error: message,
          ...(error instanceof FatalError ? { fatal: true } : {}),
          // A shutdown is not a failure of the message, so it must not inherit
          // the subscription's retry backoff: hand it straight back.
          ...(error instanceof ShutdownError ? { delayMs: 0 } : {}),
        })
        .catch(() => {});
    } finally {
      this.inFlight.delete(envelope.delivery.id);
      clearInterval(timer);
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }

  async start() {
    const { client, id, subscription } = this.options;
    const prefetch = this.options.prefetch ?? 1;
    const waitMs = this.options.waitMs ?? 20_000;
    this.log(`[${id}] consuming '${subscription}'`);
    while (!this.stopping) {
      try {
        await client.register({
          id,
          name: this.options.name ?? id,
          host: this.options.host ?? "unknown",
          subscriptions: [subscription],
          labels: this.options.labels ?? {},
        });
        const free = prefetch - this.running.size;
        if (free <= 0) {
          await Promise.race(this.running);
          continue;
        }
        const envelopes = await client.claim(subscription, id, free, waitMs);
        for (const envelope of envelopes) {
          const task = this.runOne(envelope).finally(() => {
            this.running.delete(task);
          });
          this.running.add(task);
        }
      } catch (error) {
        if (!this.stopping)
          this.log(
            `[${id}] ${error instanceof Error ? error.message : String(error)}`,
          );
        await Bun.sleep(1000);
      }
    }
    await Promise.allSettled([...this.running]);
  }
}
