import type { BusApi } from "../client/bus";
import type { Envelope, Json } from "../shared/protocol";

/**
 * A batching consume loop that hands whole batches to a sink.
 *
 * `BusConsumer` runs one handler per delivery, which is right for work and
 * wrong for a destination that wants a batch: a webhook, an object per flush,
 * one `INSERT` per thousand rows. This loop claims until the batch is full or
 * `flushMs` has passed since its first delivery, renews every lease it holds
 * while it waits, and acks **only after the writer returned** — so a sink that
 * is down turns into nacks and the bus's own retry, backoff and dead letter,
 * rather than into messages acked into nowhere.
 *
 * At-least-once, like every consumer: a crash between the write and the acks
 * redelivers the batch. Each record carries `idempotencyKey` for a destination
 * that can dedupe on it.
 */

/** What a sink writes: the message, trimmed to what a destination can use. */
export interface SinkRecord {
  seq: number;
  subject: string;
  key: string | null;
  publishedAt: number;
  /** `<subscription>:<seq>`, stable across redeliveries. */
  idempotencyKey: string;
  body: Json;
}

export interface SinkWriter {
  /** For logs: `webhook`, `s3`, `clickhouse`. */
  readonly kind: string;
  /** Resolve once the destination has accepted the batch; throw to nack it. */
  write(records: SinkRecord[], signal: AbortSignal): Promise<void>;
}

export interface SinkOptions {
  client: Pick<BusApi, "claim" | "ack" | "nack" | "extend" | "register">;
  /** Consumer id. Must match the token's subject unless the token is admin. */
  id: string;
  subscription: string;
  writer: SinkWriter;
  /** Most deliveries in one write. Default 500. */
  batchSize?: number;
  /** Write a partial batch once its oldest delivery has waited this long. Default 1000. */
  flushMs?: number;
  /** Write once the buffered bodies pass this many bytes of JSON. Default 4 MiB. */
  maxBatchBytes?: number;
  /** Longest one write may take before it is aborted and the batch nacked. Default 30 s. */
  writeTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface SinkStats {
  batches: number;
  records: number;
  failures: number;
  lastError: string | null;
}

export function toRecord(envelope: Envelope): SinkRecord {
  const { message } = envelope;
  return {
    seq: message.seq,
    subject: message.subject,
    key: message.key,
    publishedAt: message.publishedAt,
    idempotencyKey: envelope.idempotencyKey,
    body: message.body,
  };
}

export class SinkRunner {
  readonly stats: SinkStats = {
    batches: 0,
    records: 0,
    failures: 0,
    lastError: null,
  };
  private stopping = false;
  private buffer: Envelope[] = [];
  private bufferBytes = 0;
  private firstAt = 0;
  /** Each buffered delivery's lease length as granted, by delivery id. */
  private granted = new Map<string, number>();
  private renewing = new Set<string>();
  /** The batch a write is in flight for; its leases are renewed too. */
  private writing: Envelope[] = [];
  private readonly log: (message: string) => void;

  constructor(private readonly options: SinkOptions) {
    this.log = options.log ?? (() => {});
  }

  /**
   * Stop claiming. A write already in flight is **finished**, not aborted, and
   * its batch acked — the destination may already hold it, and aborting would
   * nack a batch that landed, which is a guaranteed duplicate. It is bounded by
   * `writeTimeoutMs`. Whatever is buffered and unwritten is handed straight back.
   */
  stop(): void {
    this.stopping = true;
  }

  async start(): Promise<void> {
    const { client, id, subscription, writer } = this.options;
    const batchSize = Math.max(1, this.options.batchSize ?? 500);
    const flushMs = Math.max(0, this.options.flushMs ?? 1000);
    const maxBytes = this.options.maxBatchBytes ?? 4 * 1024 * 1024;
    this.log(`[${id}] ${writer.kind} sink consuming '${subscription}'`);
    const renew = setInterval(() => this.renew(), 250);
    let registeredAt = 0;
    try {
      while (!this.stopping) {
        try {
          if (Date.now() - registeredAt > 30_000) {
            await client.register({
              id,
              name: id,
              host: "sink",
              subscriptions: [subscription],
              labels: { sink: writer.kind },
            });
            registeredAt = Date.now();
          }
          const due =
            this.buffer.length > 0 &&
            (this.buffer.length >= batchSize ||
              this.bufferBytes >= maxBytes ||
              Date.now() - this.firstAt >= flushMs);
          if (due) {
            await this.flush();
            continue;
          }
          // An empty buffer waits for work; a partial one waits only for
          // what is left of its flush window, so a trickle is still written
          // on time.
          const waitMs =
            this.buffer.length === 0
              ? Math.max(flushMs, 1000)
              : Math.max(0, this.firstAt + flushMs - Date.now());
          const claimed = await client.claim(
            subscription,
            id,
            batchSize - this.buffer.length,
            Math.min(waitMs, 20_000),
          );
          for (const envelope of claimed) {
            if (this.buffer.length === 0) this.firstAt = Date.now();
            this.buffer.push(envelope);
            const until = envelope.delivery.leaseUntil;
            if (until !== null)
              this.granted.set(envelope.delivery.id, Math.max(500, until - Date.now()));
            this.bufferBytes += JSON.stringify(envelope.message.body).length;
          }
        } catch (error) {
          if (this.stopping) break;
          this.log(`[${id}] ${error instanceof Error ? error.message : String(error)}`);
          await Bun.sleep(1000);
        }
      }
    } finally {
      clearInterval(renew);
      const left = this.take();
      await Promise.allSettled(
        left.map((envelope) =>
          client.nack(envelope.delivery, id, { delayMs: 0, error: "sink stopped" }),
        ),
      );
    }
  }

  /** Writes what is buffered, then acks it — or nacks it all when the write fails. */
  async flush(): Promise<void> {
    const batch = this.take();
    if (batch.length === 0) return;
    this.writing = batch;
    try {
      await this.write(batch);
    } finally {
      this.writing = [];
      for (const envelope of batch) this.granted.delete(envelope.delivery.id);
    }
  }

  private async write(batch: Envelope[]): Promise<void> {
    const { client, id, writer } = this.options;
    const signal = AbortSignal.timeout(this.options.writeTimeoutMs ?? 30_000);
    try {
      await writer.write(batch.map(toRecord), signal);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
      this.stats.failures++;
      this.stats.lastError = message;
      this.log(`[${id}] ${writer.kind} write of ${batch.length} failed: ${message}`);
      await settle(batch, (envelope) =>
        client.nack(envelope.delivery, id, { error: message }),
      );
      return;
    }
    this.stats.batches++;
    this.stats.records += batch.length;
    const acked = await settle(batch, (envelope) => client.ack(envelope.delivery, id));
    // The write happened; an ack that did not land means a redelivery and a
    // duplicate at the destination, which is at-least-once doing its job. Say
    // so rather than hide it.
    if (acked < batch.length)
      this.log(`[${id}] ${batch.length - acked} of ${batch.length} acks failed; expect redelivery`);
  }

  private take(): Envelope[] {
    const batch = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;
    return batch;
  }

  /**
   * Renews a buffered delivery once half of its lease is gone, so one lost
   * renewal does not cost the message. Read from the lease the bus granted,
   * like `BusConsumer`, so a short ack window still works.
   */
  private renew(): void {
    const { client, id } = this.options;
    const now = Date.now();
    for (const envelope of [...this.buffer, ...this.writing]) {
      const delivery = envelope.delivery;
      if (delivery.leaseUntil === null || this.renewing.has(delivery.id)) continue;
      const granted = this.granted.get(delivery.id) ?? 30_000;
      if (delivery.leaseUntil - now > granted / 2) continue;
      this.renewing.add(delivery.id);
      void client
        .extend(delivery, id)
        .then((result) => {
          if (result.leaseUntil !== null) delivery.leaseUntil = result.leaseUntil;
        })
        .catch(() => {})
        .finally(() => this.renewing.delete(delivery.id));
    }
  }
}

/** Runs `fn` over the batch, sixteen at a time, and counts what succeeded. */
async function settle<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<number> {
  let ok = 0;
  for (let at = 0; at < items.length; at += 16) {
    const results = await Promise.allSettled(items.slice(at, at + 16).map(fn));
    for (const result of results) if (result.status === "fulfilled") ok++;
  }
  return ok;
}
