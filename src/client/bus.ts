import type {
  Delivery,
  Envelope,
  Json,
  Message,
  PublishRequest,
  PublishResult,
  Response as BusResponse,
  Stats,
  SubscribeRequest,
  Subscription,
} from "../shared/protocol";

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

  constructor(private readonly options: ClientOptions) {
    this.base = options.url.replace(/\/$/, "");
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async call<T>(
    path: string,
    body?: unknown,
    { method, extraWaitMs = 0 }: { method?: string; extraWaitMs?: number } = {},
  ): Promise<T> {
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
      signal: AbortSignal.timeout(this.timeoutMs + extraWaitMs),
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

  publish(request: PublishRequest): Promise<PublishResult> {
    return this.call<PublishResult>("/api/publish", request);
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
  ): Promise<BusResponse | null> {
    try {
      return await this.call<BusResponse>(
        `/api/requests/${encodeURIComponent(correlation)}?waitMs=${waitMs}`,
        undefined,
        { extraWaitMs: waitMs },
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
  log(after = 0, limit = 100): Promise<Message[]> {
    return this.call<Message[]>(`/api/log?after=${after}&limit=${limit}`);
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
  ack(delivery: Delivery, consumer: string): Promise<Delivery> {
    return this.call<Delivery>(`/api/deliveries/${delivery.id}/ack`, {
      consumer,
      generation: delivery.generation,
    });
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
  extend(delivery: Delivery, consumer: string): Promise<{ leaseUntil: number }> {
    return this.call(`/api/deliveries/${delivery.id}/extend`, {
      consumer,
      generation: delivery.generation,
    });
  }
}

export interface ConsumerOptions {
  client: BusClient;
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
  log?: (message: string) => void;
}

export interface HandlerApi {
  /** Renew the lease. Call it from a long handler that risks the ack window. */
  extend(): Promise<void>;
  /** Answer a request message. Returning a value from `handle` does this too. */
  reply(body: Json, headers?: Record<string, string>): Promise<void>;
  signal: AbortSignal;
}

/** Thrown by a handler to dead-letter immediately, skipping remaining attempts. */
export class FatalError extends Error {}

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
  private readonly log: (message: string) => void;

  constructor(private readonly options: ConsumerOptions) {
    this.log = options.log ?? (() => {});
  }

  stop() {
    this.stopping = true;
  }

  private async runOne(envelope: Envelope) {
    const { client, id } = this.options;
    const abort = new AbortController();
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
    const timer = setInterval(() => {
      void client
        .extend(envelope.delivery, id)
        .catch(() => abort.abort("lease lost"));
    }, extendMs);
    const api: HandlerApi = {
      extend: async () => {
        await client.extend(envelope.delivery, id);
      },
      reply: async (body, headers) => {
        await client.reply(envelope.message, body, headers);
      },
      signal: abort.signal,
    };
    try {
      const result = await this.options.handle(envelope, api);
      if (envelope.message.headers.correlation && result !== undefined)
        await client.reply(envelope.message, result as Json);
      await client.ack(envelope.delivery, id);
    } catch (error) {
      const message = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 4000);
      this.log(`[${id}] ${envelope.message.subject} failed: ${message}`);
      await client
        .nack(envelope.delivery, id, {
          error: message,
          ...(error instanceof FatalError ? { fatal: true } : {}),
        })
        .catch(() => {});
    } finally {
      clearInterval(timer);
    }
  }

  async start() {
    const { client, id, subscription } = this.options;
    const prefetch = this.options.prefetch ?? 1;
    const waitMs = this.options.waitMs ?? 20_000;
    this.log(`[${id}] consuming '${subscription}'`);
    while (!this.stopping) {
      try {
        await client.call("/api/consumers/register", {
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
