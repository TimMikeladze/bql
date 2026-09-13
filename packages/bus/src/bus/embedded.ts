import type { Database } from "bun:sqlite";
import type {
  AckResult,
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
  RegisterConsumer,
} from "../shared/protocol";
import { DEFAULT_WORKSPACE } from "../shared/protocol";
import type { BusApi } from "../client/bus";
import { fileBlobs } from "./blobs";
import { BusStore, type StoreOptions } from "./store";

/**
 * The bus, in your own process.
 *
 * Everything the HTTP client does, minus the HTTP: no loopback socket, no
 * serialisation, no token. It exists for one reason that is not performance —
 * a handler running here writes to the *same SQLite file* the bus owns, which
 * is what makes `consumeTransactional` a genuine exactly-once guarantee rather
 * than a careful approximation of one.
 *
 * ```ts
 * const bus = createBus({ path: "./data/bus.db" });
 * bus.store.subscribe("default", { name: "work", pattern: "work.>" });
 * await bus.client.publish({ subject: "work.do", body: { id: 1 } });
 *
 * const loop = bus.consumeTransactional({
 *   subscription: "work",
 *   handle: (envelope, db) => {
 *     db.run("INSERT INTO processed (seq) VALUES (?)", [envelope.message.seq]);
 *   },
 * });
 * ```
 *
 * The handler's `INSERT` and the ack are one transaction. Kill the process
 * anywhere inside it and you get both or neither — never a row written twice
 * because the ack did not survive.
 */
export interface EmbeddedBus {
  store: BusStore;
  /** The same surface `BusClient` offers, answered in-process. */
  client: DirectClient;
  workspace: string;
  consumeTransactional(
    options: TransactionalConsumerOptions,
  ): TransactionalConsumer;
  close(): void;
}

export interface EmbeddedBusOptions extends StoreOptions {
  /** Database file. `:memory:` — the default — is for tests. */
  path?: string;
  /** Blob directory. Without one, oversized bodies are refused with 413. */
  blobDirectory?: string;
  workspace?: string;
}

export function createBus(options: EmbeddedBusOptions = {}): EmbeddedBus {
  const { path = ":memory:", blobDirectory, workspace: ws, ...rest } = options;
  const workspace = ws ?? DEFAULT_WORKSPACE;
  const store = new BusStore(path, {
    ...rest,
    ...(blobDirectory ? { blobs: fileBlobs(blobDirectory) } : {}),
  });
  const client = new DirectClient(store, workspace);
  return {
    store,
    client,
    workspace,
    consumeTransactional: (consumerOptions) =>
      consumeTransactional(store, workspace, consumerOptions),
    close: () => store.close(),
  };
}

/**
 * `BusApi` over a store rather than a socket.
 *
 * Deliberately the same interface as the HTTP client: a consumer written
 * against `BusApi` runs embedded or remote without knowing which, and moving
 * it from one to the other is a constructor change.
 */
export class DirectClient implements BusApi {
  constructor(
    private readonly store: BusStore,
    private readonly workspace: string = DEFAULT_WORKSPACE,
    /** The consumer identity in-process work publishes under. */
    private readonly publisher: string | null = null,
  ) {}

  publish(request: PublishRequest): Promise<PublishResult> {
    return this.store.publish(this.workspace, request, this.publisher);
  }

  /**
   * Claim, long-polling if asked.
   *
   * The wait is a sleep loop rather than a condition variable on purpose: the
   * embedded bus has exactly one writer and the sweep already runs on a timer,
   * so a hundred-millisecond poll is both simpler and no less prompt than
   * anything that needs to be woken.
   */
  async claim(
    subscription: string,
    consumer: string,
    max = 1,
    waitMs = 0,
  ): Promise<Envelope[]> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const envelopes = await this.store.claim(
        this.workspace,
        subscription,
        consumer,
        max,
      );
      if (envelopes.length > 0 || Date.now() >= deadline) return envelopes;
      await Bun.sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  ack(
    delivery: Delivery,
    consumer: string,
    options: { publish?: PublishRequest[]; effects?: EffectRecord[] } = {},
  ): Promise<AckResult> {
    return this.store.ack(
      this.workspace,
      delivery.id,
      consumer,
      delivery.generation,
      options,
    );
  }

  async nack(
    delivery: Delivery,
    consumer: string,
    options: { error?: string; fatal?: boolean; delayMs?: number } = {},
  ): Promise<Delivery> {
    return this.store.nack(
      this.workspace,
      delivery.id,
      consumer,
      delivery.generation,
      options,
    );
  }

  async extend(delivery: Delivery, consumer: string): Promise<ExtendResult> {
    return this.store.extend(
      this.workspace,
      delivery.id,
      consumer,
      delivery.generation,
    );
  }

  async reply(
    message: Message,
    body: Json,
    headers: Record<string, string> = {},
  ): Promise<PublishResult> {
    const correlation = message.headers.correlation;
    if (!correlation)
      throw new Error("that message carries no correlation to reply to");
    const result = await this.store.publish(
      this.workspace,
      {
        subject: message.headers["reply-to"] ?? "reply",
        correlation,
        body,
        headers,
      },
      this.publisher,
    );
    this.store.respond(this.workspace, correlation, result.seq, body, headers);
    return result;
  }

  async register(input: RegisterConsumer): Promise<Consumer> {
    return this.store.register(this.workspace, input);
  }

  async claimEffect(key: string, fence?: string): Promise<EffectClaim> {
    return this.store.claimEffect(this.workspace, key, fence ?? null);
  }

  async recordEffect(key: string, result: Json): Promise<{ ok: true }> {
    this.store.recordEffect(this.workspace, { key, result });
    return { ok: true };
  }
}

export interface TransactionalConsumerOptions {
  subscription: string;
  /**
   * The handler. **Synchronous, and that is load-bearing.**
   *
   * It runs inside the bus's own SQLite transaction, alongside the ack. An
   * `await` in here would let another statement interleave into that
   * transaction, which is precisely the property the whole method exists to
   * provide. Do the I/O before the delivery or after the ack; do the *writes*
   * in here.
   */
  handle: (envelope: Envelope, db: Database) => void;
  id?: string;
  /** Deliveries per claim. */
  prefetch?: number;
  /** How long a claim waits for work before looping. */
  waitMs?: number;
  /** Called when a handler throws. The delivery is nacked either way. */
  onError?: (error: unknown, envelope: Envelope) => void;
}

export interface TransactionalConsumer {
  /** Resolves when the loop has finished its current claim and stopped. */
  stop(): Promise<void>;
  /** The loop itself, so a caller can await a crash rather than lose it. */
  readonly done: Promise<void>;
}

/**
 * Tier 1: consume with the handler's writes and the ack in one transaction.
 *
 * A handler that throws rolls its own writes back and nacks, so the message is
 * retried against a database that never saw the failed attempt. A handler that
 * returns has already committed: there is no window in which the work is done
 * and the ack is not.
 */
export function consumeTransactional(
  store: BusStore,
  workspace: string,
  options: TransactionalConsumerOptions,
): TransactionalConsumer {
  const id = options.id ?? `embedded-${options.subscription}`;
  const prefetch = Math.max(1, options.prefetch ?? 8);
  const waitMs = options.waitMs ?? 50;
  let stopping = false;

  const done = (async () => {
    while (!stopping) {
      let envelopes: Envelope[] = [];
      try {
        envelopes = await store.claim(workspace, options.subscription, id, prefetch);
      } catch (error) {
        options.onError?.(error, undefined as unknown as Envelope);
        await Bun.sleep(100);
        continue;
      }
      if (envelopes.length === 0) {
        await Bun.sleep(waitMs);
        continue;
      }
      for (const envelope of envelopes) {
        try {
          store.ackTransactional(
            workspace,
            envelope.delivery.id,
            id,
            envelope.delivery.generation,
            (db) => options.handle(envelope, db),
          );
        } catch (error) {
          options.onError?.(error, envelope);
          store.nack(
            workspace,
            envelope.delivery.id,
            id,
            envelope.delivery.generation,
            { error: String(error instanceof Error ? error.message : error) },
          );
        }
      }
    }
  })();

  return {
    async stop() {
      stopping = true;
      await done;
    },
    done,
  };
}
