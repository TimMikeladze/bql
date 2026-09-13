import { Database } from "bun:sqlite";
import type {
  Consumer,
  DeliverFrom,
  Delivery,
  DeliveryStatus,
  Envelope,
  Headers,
  Json,
  Message,
  PublishRequest,
  PublishResult,
  RegisterConsumer,
  Response,
  Stats,
  SubscribeRequest,
  Subscription,
  SubscriptionStats,
} from "../shared/protocol";
import { DEFAULT_WORKSPACE } from "../shared/protocol";
import type { BlobStore } from "./blobs";
import { assertPattern, assertSubject, matches, narrowingGlob } from "./subjects";

export class BusError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

const uuid = () => crypto.randomUUID();
const parse = <T>(text: string | null, fallback: T): T =>
  text === null ? fallback : (JSON.parse(text) as T);

export interface StoreOptions {
  now?: () => number;
  /** Bodies larger than this are written to the blob store. */
  inlineMaxBytes?: number;
  blobs?: BlobStore;
  /** Messages and settled deliveries older than this are pruned. 0 disables. */
  retentionMs?: number;
  /** How many log rows one claim may examine while materializing deliveries. */
  scanBatch?: number;
}

interface MessageRow {
  seq: number;
  id: string;
  workspace: string;
  subject: string;
  key: string | null;
  headers: string;
  body: string | null;
  body_blob: string | null;
  published_at: number;
  expires_at: number | null;
  dedupe_key: string | null;
}

interface SubscriptionRow {
  id: string;
  workspace: string;
  name: string;
  pattern: string;
  cursor_seq: number;
  ack_wait_ms: number;
  max_attempts: number;
  ordered: number;
  dlq_subject: string;
  paused: number;
  created_at: number;
  updated_at: number;
}

interface DeliveryRow {
  id: string;
  subscription_id: string;
  message_seq: number;
  status: DeliveryStatus;
  consumer_id: string | null;
  generation: number;
  attempt: number;
  lease_until: number | null;
  available_at: number;
  key: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * The bus.
 *
 * One process owns one SQLite file in WAL mode; consumers never open it, they
 * hold leases over HTTP. Every claim, ack and nack is a conditional UPDATE that
 * only transitions *out of* the state it expects, so two consumers racing for
 * one delivery is safe rather than merely unlikely.
 *
 * Fan-out happens when a consumer pulls, not when a producer publishes: a
 * subscription holds a cursor into the log and materializes deliveries forward
 * from it. Publishing is therefore O(1) in the number of subscriptions, a
 * subscription created today can read last week's messages, and — the part that
 * matters most — the cursor advances past messages that do not match, so a run
 * of non-matching subjects can never hide a matching one behind it.
 */
export class BusStore {
  private db: Database;
  private now: () => number;
  private inlineMaxBytes: number;
  private blobs: BlobStore | undefined;
  private retentionMs: number;
  private scanBatch: number;

  constructor(path: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.inlineMaxBytes = options.inlineMaxBytes ?? 64 * 1024;
    this.blobs = options.blobs;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.scanBatch = options.scanBatch ?? 500;
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA synchronous=FULL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run("PRAGMA foreign_keys=ON");
    this.migrate();
  }

  private migrate() {
    this.db.run(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace TEXT NOT NULL,
      subject TEXT NOT NULL,
      key TEXT,
      headers TEXT NOT NULL,
      body TEXT,
      body_blob TEXT,
      published_at INTEGER NOT NULL,
      expires_at INTEGER,
      dedupe_key TEXT)`);
    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS messages_dedupe ON messages(workspace, dedupe_key) WHERE dedupe_key IS NOT NULL",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS messages_log ON messages(workspace, seq)",
    );

    this.db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      name TEXT NOT NULL,
      pattern TEXT NOT NULL,
      cursor_seq INTEGER NOT NULL DEFAULT 0,
      ack_wait_ms INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      ordered INTEGER NOT NULL DEFAULT 0,
      dlq_subject TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_name ON subscriptions(workspace, name)",
    );

    this.db.run(`CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
      status TEXT NOT NULL,
      consumer_id TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      available_at INTEGER NOT NULL DEFAULT 0,
      key TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(subscription_id, message_seq))`);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS deliveries_ready ON deliveries(subscription_id, status, available_at, message_seq)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS deliveries_lease ON deliveries(status, lease_until)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS deliveries_key ON deliveries(subscription_id, status, key)",
    );

    this.db.run(`CREATE TABLE IF NOT EXISTS responses (
      workspace TEXT NOT NULL,
      correlation TEXT NOT NULL,
      message_seq INTEGER NOT NULL,
      headers TEXT NOT NULL,
      body TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace, correlation))`);

    this.db.run(`CREATE TABLE IF NOT EXISTS blobs (
      handle TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`);

    this.db.run(`CREATE TABLE IF NOT EXISTS consumers (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      data TEXT NOT NULL)`);
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------- messages

  private async writeBody(body: Json): Promise<{
    inline: string | null;
    blob: string | null;
  }> {
    const text = JSON.stringify(body ?? null);
    if (text.length <= this.inlineMaxBytes) return { inline: text, blob: null };
    if (!this.blobs)
      throw new BusError(
        `body is ${text.length} bytes and no blob store is configured`,
        413,
      );
    const handle = await this.blobs.put(uuid(), text);
    this.db.run(
      "INSERT INTO blobs (handle, created_at) VALUES (?,?) ON CONFLICT(handle) DO NOTHING",
      [handle, this.now()],
    );
    return { inline: null, blob: handle };
  }

  private async readBody(row: MessageRow): Promise<Json> {
    if (row.body !== null) return JSON.parse(row.body) as Json;
    if (row.body_blob === null) return null;
    if (!this.blobs)
      throw new BusError("message body is in a blob store that is not configured");
    return JSON.parse(await this.blobs.get(row.body_blob)) as Json;
  }

  private async hydrate(row: MessageRow): Promise<Message> {
    return {
      seq: row.seq,
      id: row.id,
      workspace: row.workspace,
      subject: row.subject,
      key: row.key,
      headers: parse<Headers>(row.headers, {}),
      body: await this.readBody(row),
      publishedAt: row.published_at,
      expiresAt: row.expires_at,
      dedupeKey: row.dedupe_key,
    };
  }

  async publish(
    workspace: string,
    request: PublishRequest,
  ): Promise<PublishResult> {
    assertSubject(request.subject);
    const { inline, blob } = await this.writeBody(request.body ?? null);
    const correlation =
      request.correlation ?? (request.replyTo ? uuid() : null);
    const headers: Headers = {
      ...(request.headers ?? {}),
      ...(request.replyTo ? { "reply-to": request.replyTo } : {}),
      ...(correlation ? { correlation } : {}),
    };

    return this.db.transaction(() => {
      if (request.dedupeKey) {
        const existing = this.db
          .query(
            "SELECT seq, id, headers FROM messages WHERE workspace = ? AND dedupe_key = ?",
          )
          .get(workspace, request.dedupeKey) as
          | { seq: number; id: string; headers: string }
          | null;
        if (existing)
          // The *original* correlation, not the one this call just generated:
          // a caller retrying an idempotent request has to be handed the
          // correlation the answer will actually arrive under, or it waits
          // forever on one nobody will ever reply to.
          return {
            seq: existing.seq,
            id: existing.id,
            duplicate: true,
            correlation:
              parse<Headers>(existing.headers, {}).correlation ?? correlation,
          };
      }
      const id = uuid();
      const now = this.now();
      this.db.run(
        `INSERT INTO messages (id, workspace, subject, key, headers, body, body_blob, published_at, expires_at, dedupe_key)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          workspace,
          request.subject,
          request.key ?? null,
          JSON.stringify(headers),
          inline,
          blob,
          now,
          request.ttlMs ? now + request.ttlMs : null,
          request.dedupeKey ?? null,
        ],
      );
      const seq = Number(
        (this.db.query("SELECT last_insert_rowid() AS seq").get() as {
          seq: number;
        }).seq,
      );
      return { seq, id, duplicate: false, correlation };
    })();
  }

  async message(workspace: string, seq: number): Promise<Message> {
    const row = this.db
      .query("SELECT * FROM messages WHERE seq = ? AND workspace = ?")
      .get(seq, workspace) as MessageRow | null;
    if (!row) throw new BusError("message not found", 404);
    return this.hydrate(row);
  }

  async log(workspace: string, after = 0, limit = 100): Promise<Message[]> {
    const rows = this.db
      .query(
        "SELECT * FROM messages WHERE workspace = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(workspace, after, Math.min(1000, limit)) as MessageRow[];
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  lastSeq(): number {
    const row = this.db.query("SELECT MAX(seq) AS seq FROM messages").get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  // -------------------------------------------------------- subscriptions

  private toSubscription(row: SubscriptionRow): Subscription {
    return {
      id: row.id,
      workspace: row.workspace,
      name: row.name,
      pattern: row.pattern,
      cursorSeq: row.cursor_seq,
      ackWaitMs: row.ack_wait_ms,
      maxAttempts: row.max_attempts,
      ordered: row.ordered === 1,
      dlqSubject: row.dlq_subject,
      paused: row.paused === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private subscriptionRow(workspace: string, name: string): SubscriptionRow {
    const row = this.db
      .query("SELECT * FROM subscriptions WHERE workspace = ? AND name = ?")
      .get(workspace, name) as SubscriptionRow | null;
    if (!row) throw new BusError(`no subscription '${name}'`, 404);
    return row;
  }

  subscription(workspace: string, name: string): Subscription {
    return this.toSubscription(this.subscriptionRow(workspace, name));
  }

  /**
   * Create a subscription, or update the tunables of one that exists.
   *
   * The pattern is immutable: changing it would silently change which of the
   * messages already behind the cursor were ever considered, and a subscription
   * that quietly means something different is worse than an error.
   */
  subscribe(workspace: string, request: SubscribeRequest): Subscription {
    assertPattern(request.pattern);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.name))
      throw new BusError("invalid subscription name", 400);
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM subscriptions WHERE workspace = ? AND name = ?")
        .get(workspace, request.name) as SubscriptionRow | null;
      const now = this.now();
      if (existing) {
        if (existing.pattern !== request.pattern)
          throw new BusError(
            `subscription '${request.name}' already exists with pattern '${existing.pattern}'`,
          );
        this.db.run(
          `UPDATE subscriptions SET ack_wait_ms=?, max_attempts=?, ordered=?, dlq_subject=?, updated_at=?
           WHERE id=?`,
          [
            request.ackWaitMs ?? existing.ack_wait_ms,
            request.maxAttempts ?? existing.max_attempts,
            request.ordered === undefined
              ? existing.ordered
              : request.ordered
                ? 1
                : 0,
            request.dlqSubject ?? existing.dlq_subject,
            now,
            existing.id,
          ],
        );
        return this.subscription(workspace, request.name);
      }
      const from = request.deliverFrom ?? "new";
      const cursor =
        from === "beginning" ? 0 : from === "new" ? this.lastSeq() : Number(from);
      const dlq =
        request.dlqSubject ?? `dlq.${request.name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
      assertSubject(dlq);
      const subscription: SubscriptionRow = {
        id: uuid(),
        workspace,
        name: request.name,
        pattern: request.pattern,
        cursor_seq: Math.max(0, cursor),
        ack_wait_ms: Math.max(1000, request.ackWaitMs ?? 30_000),
        max_attempts: Math.max(1, request.maxAttempts ?? 3),
        ordered: request.ordered ? 1 : 0,
        dlq_subject: dlq,
        paused: 0,
        created_at: now,
        updated_at: now,
      };
      this.db.run(
        `INSERT INTO subscriptions (id, workspace, name, pattern, cursor_seq, ack_wait_ms, max_attempts, ordered, dlq_subject, paused, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          subscription.id,
          workspace,
          subscription.name,
          subscription.pattern,
          subscription.cursor_seq,
          subscription.ack_wait_ms,
          subscription.max_attempts,
          subscription.ordered,
          subscription.dlq_subject,
          0,
          now,
          now,
        ],
      );
      return this.toSubscription(subscription);
    })();
  }

  subscriptions(workspace: string): Subscription[] {
    return (
      this.db
        .query("SELECT * FROM subscriptions WHERE workspace = ? ORDER BY name")
        .all(workspace) as SubscriptionRow[]
    ).map((row) => this.toSubscription(row));
  }

  unsubscribe(workspace: string, name: string) {
    const row = this.subscriptionRow(workspace, name);
    this.db.run("DELETE FROM subscriptions WHERE id = ?", [row.id]);
    return { ok: true };
  }

  pauseSubscription(workspace: string, name: string, paused: boolean) {
    const row = this.subscriptionRow(workspace, name);
    this.db.run("UPDATE subscriptions SET paused=?, updated_at=? WHERE id=?", [
      paused ? 1 : 0,
      this.now(),
      row.id,
    ]);
    return this.subscription(workspace, name);
  }

  /** Rewind a cursor so already-seen messages are delivered again. */
  replay(workspace: string, name: string, fromSeq: number) {
    const row = this.subscriptionRow(workspace, name);
    this.db.run(
      "UPDATE subscriptions SET cursor_seq=?, updated_at=? WHERE id=?",
      [Math.max(0, fromSeq), this.now(), row.id],
    );
    // Settled deliveries are left in place: `UNIQUE(subscription_id,
    // message_seq)` means a replayed message is skipped rather than delivered
    // twice, so a replay picks up what was never acked. Deleting them is the
    // caller's choice, via `purge`.
    return this.subscription(workspace, name);
  }

  /** Drop settled deliveries so a replay redelivers everything in range. */
  purge(workspace: string, name: string, fromSeq = 0) {
    const row = this.subscriptionRow(workspace, name);
    const result = this.db.run(
      "DELETE FROM deliveries WHERE subscription_id=? AND message_seq>=? AND status IN ('acked','dead')",
      [row.id, fromSeq],
    );
    return { removed: result.changes };
  }

  // ----------------------------------------------------------- deliveries

  private toDelivery(row: DeliveryRow, subscription: SubscriptionRow): Delivery {
    return {
      id: row.id,
      subscriptionId: row.subscription_id,
      subscription: subscription.name,
      messageSeq: row.message_seq,
      status: row.status,
      consumerId: row.consumer_id,
      generation: row.generation,
      attempt: row.attempt,
      maxAttempts: subscription.max_attempts,
      leaseUntil: row.lease_until,
      key: row.key,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Read the log forward from the cursor, creating deliveries for matches.
   *
   * Bounded by `scanBatch`, and the cursor advances over *examined* messages
   * whether or not they matched — which is what keeps a wall of unrelated
   * subjects from starving a subscription.
   */
  private materialize(subscription: SubscriptionRow): number {
    const glob = narrowingGlob(subscription.pattern);
    const rows = this.db
      .query(
        `SELECT seq, subject, key FROM messages
         WHERE workspace = ? AND seq > ? AND subject GLOB ?
         ORDER BY seq LIMIT ?`,
      )
      .all(
        subscription.workspace,
        subscription.cursor_seq,
        glob,
        this.scanBatch,
      ) as { seq: number; subject: string; key: string | null }[];

    // The GLOB narrows but does not decide, so the cursor may only advance to
    // the last row we actually looked at — not past rows the GLOB skipped.
    const ceiling = this.db
      .query(
        `SELECT MAX(seq) AS seq FROM (
           SELECT seq FROM messages WHERE workspace = ? AND seq > ? ORDER BY seq LIMIT ?)`,
      )
      .get(subscription.workspace, subscription.cursor_seq, this.scanBatch) as {
      seq: number | null;
    };
    if (ceiling.seq === null) return 0;

    const now = this.now();
    let created = 0;
    for (const row of rows) {
      if (row.seq > ceiling.seq) break;
      if (!matches(subscription.pattern, row.subject)) continue;
      this.db.run(
        `INSERT INTO deliveries (id, subscription_id, message_seq, status, generation, attempt, available_at, key, created_at, updated_at)
         VALUES (?,?,?,'pending',0,0,0,?,?,?)
         ON CONFLICT(subscription_id, message_seq) DO NOTHING`,
        [uuid(), subscription.id, row.seq, row.key, now, now],
      );
      created++;
    }
    this.db.run(
      "UPDATE subscriptions SET cursor_seq=?, updated_at=? WHERE id=?",
      [ceiling.seq, now, subscription.id],
    );
    subscription.cursor_seq = ceiling.seq;
    return created;
  }

  /** Return expired leases on one subscription. Never a global scan. */
  reclaim(subscriptionId?: string): number {
    return this.db.transaction(() => {
      const now = this.now();
      const rows = (
        subscriptionId
          ? this.db
              .query(
                "SELECT * FROM deliveries WHERE subscription_id=? AND status='leased' AND lease_until <= ?",
              )
              .all(subscriptionId, now)
          : this.db
              .query(
                "SELECT * FROM deliveries WHERE status='leased' AND lease_until <= ?",
              )
              .all(now)
      ) as DeliveryRow[];
      for (const row of rows) {
        const subscription = this.db
          .query("SELECT * FROM subscriptions WHERE id=?")
          .get(row.subscription_id) as SubscriptionRow;
        if (row.attempt >= subscription.max_attempts)
          this.deadLetter(row, subscription, "lease expired and attempts exhausted");
        else
          this.db.run(
            `UPDATE deliveries SET status='pending', consumer_id=NULL, lease_until=NULL,
               error=?, updated_at=? WHERE id=? AND status='leased'`,
            ["lease expired", now, row.id],
          );
      }
      return rows.length;
    })();
  }

  private deadLetter(
    row: DeliveryRow,
    subscription: SubscriptionRow,
    reason: string,
  ) {
    const now = this.now();
    this.db.run(
      "UPDATE deliveries SET status='dead', consumer_id=NULL, lease_until=NULL, error=?, updated_at=? WHERE id=?",
      [reason, now, row.id],
    );
    // The dead letter is an ordinary message on an ordinary subject, so a DLQ
    // is just another subscription and a replay is just another publish.
    const original = this.db
      .query("SELECT * FROM messages WHERE seq=?")
      .get(row.message_seq) as MessageRow;
    const headers: Headers = {
      ...parse<Headers>(original.headers, {}),
      "dlq-reason": reason.slice(0, 500),
      "dlq-subject": original.subject,
      "dlq-subscription": subscription.name,
      "dlq-attempts": String(row.attempt),
    };
    this.db.run(
      `INSERT INTO messages (id, workspace, subject, key, headers, body, body_blob, published_at, expires_at, dedupe_key)
       VALUES (?,?,?,?,?,?,?,?,NULL,NULL)`,
      [
        uuid(),
        subscription.workspace,
        subscription.dlq_subject,
        original.key,
        JSON.stringify(headers),
        original.body,
        original.body_blob,
        now,
      ],
    );
  }

  /**
   * Lease up to `max` deliveries to one consumer.
   *
   * The claim is a conditional update out of `pending`, so a row already taken
   * cannot be taken twice. On an ordered subscription a delivery is skipped
   * while another with the same key is in flight.
   */
  async claim(
    workspace: string,
    name: string,
    consumerId: string,
    max = 1,
  ): Promise<Envelope[]> {
    const leased = this.db.transaction(() => {
      const subscription = this.subscriptionRow(workspace, name);
      if (subscription.paused === 1) return [] as DeliveryRow[];
      this.reclaim(subscription.id);
      this.materialize(subscription);

      const now = this.now();
      const inFlight = subscription.ordered
        ? new Set(
            (
              this.db
                .query(
                  "SELECT DISTINCT key FROM deliveries WHERE subscription_id=? AND status='leased' AND key IS NOT NULL",
                )
                .all(subscription.id) as { key: string }[]
            ).map((row) => row.key),
          )
        : new Set<string>();

      const candidates = this.db
        .query(
          `SELECT * FROM deliveries
           WHERE subscription_id=? AND status='pending' AND available_at<=?
           ORDER BY message_seq LIMIT ?`,
        )
        .all(subscription.id, now, Math.max(max * 4, 32)) as DeliveryRow[];

      const taken: DeliveryRow[] = [];
      for (const row of candidates) {
        if (taken.length >= max) break;
        if (subscription.ordered && row.key !== null) {
          if (inFlight.has(row.key)) continue;
          inFlight.add(row.key);
        }
        const result = this.db.run(
          `UPDATE deliveries SET status='leased', consumer_id=?, generation=generation+1,
             attempt=attempt+1, lease_until=?, updated_at=?
           WHERE id=? AND status='pending'`,
          [consumerId, now + subscription.ack_wait_ms, now, row.id],
        );
        if (result.changes !== 1) continue;
        taken.push(
          this.db.query("SELECT * FROM deliveries WHERE id=?").get(row.id) as
            DeliveryRow,
        );
      }
      this.touchConsumer(workspace, consumerId);
      return taken;
    })();

    const subscription = this.subscriptionRow(workspace, name);
    return Promise.all(
      leased.map(async (row) => ({
        delivery: this.toDelivery(row, subscription),
        message: await this.message(workspace, row.message_seq),
        idempotencyKey: `${name}:${row.message_seq}`,
      })),
    );
  }

  private owned(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
  ): { row: DeliveryRow; subscription: SubscriptionRow } {
    const row = this.db
      .query("SELECT * FROM deliveries WHERE id=?")
      .get(deliveryId) as DeliveryRow | null;
    if (!row) throw new BusError("delivery not found", 404);
    const subscription = this.db
      .query("SELECT * FROM subscriptions WHERE id=?")
      .get(row.subscription_id) as SubscriptionRow;
    if (subscription.workspace !== workspace)
      throw new BusError("delivery not found", 404);
    if (
      row.status !== "leased" ||
      row.consumer_id !== consumerId ||
      row.generation !== generation ||
      (row.lease_until ?? 0) <= this.now()
    )
      throw new BusError("stale lease");
    return { row, subscription };
  }

  ack(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
  ): Delivery {
    return this.db.transaction(() => {
      const { row, subscription } = this.owned(
        workspace,
        deliveryId,
        consumerId,
        generation,
      );
      this.db.run(
        "UPDATE deliveries SET status='acked', lease_until=NULL, error=NULL, updated_at=? WHERE id=? AND status='leased'",
        [this.now(), row.id],
      );
      return this.toDelivery(
        this.db.query("SELECT * FROM deliveries WHERE id=?").get(row.id) as
          DeliveryRow,
        subscription,
      );
    })();
  }

  nack(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
    options: { error?: string; fatal?: boolean; delayMs?: number } = {},
  ): Delivery {
    return this.db.transaction(() => {
      const { row, subscription } = this.owned(
        workspace,
        deliveryId,
        consumerId,
        generation,
      );
      const reason = (options.error ?? "consumer nacked").slice(0, 4000);
      const exhausted =
        options.fatal === true || row.attempt >= subscription.max_attempts;
      if (exhausted) this.deadLetter(row, subscription, reason);
      else
        this.db.run(
          `UPDATE deliveries SET status='pending', consumer_id=NULL, lease_until=NULL,
             available_at=?, error=?, updated_at=? WHERE id=? AND status='leased'`,
          [this.now() + (options.delayMs ?? 0), reason, this.now(), row.id],
        );
      return this.toDelivery(
        this.db.query("SELECT * FROM deliveries WHERE id=?").get(row.id) as
          DeliveryRow,
        subscription,
      );
    })();
  }

  extend(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
  ) {
    const { row, subscription } = this.owned(
      workspace,
      deliveryId,
      consumerId,
      generation,
    );
    const leaseUntil = this.now() + subscription.ack_wait_ms;
    this.db.run(
      "UPDATE deliveries SET lease_until=?, updated_at=? WHERE id=? AND status='leased'",
      [leaseUntil, this.now(), row.id],
    );
    this.touchConsumer(workspace, consumerId);
    return { leaseUntil };
  }

  deliveries(workspace: string, limit = 200): Delivery[] {
    // The subscription's name and attempt cap come back on the join: this is
    // the dashboard's refresh path, and a lookup per row made it 200 queries a
    // second for a screen showing 200 rows.
    const rows = this.db
      .query(
        `SELECT d.*, s.name AS subscription_name, s.max_attempts AS subscription_max
           FROM deliveries d JOIN subscriptions s ON s.id = d.subscription_id
          WHERE s.workspace = ? ORDER BY d.updated_at DESC LIMIT ?`,
      )
      .all(workspace, limit) as (DeliveryRow & {
      subscription_name: string;
      subscription_max: number;
    })[];
    return rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscription_id,
      subscription: row.subscription_name,
      messageSeq: row.message_seq,
      status: row.status,
      consumerId: row.consumer_id,
      generation: row.generation,
      attempt: row.attempt,
      maxAttempts: row.subscription_max,
      leaseUntil: row.lease_until,
      key: row.key,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // ------------------------------------------------------------ responses

  /** Record a reply against its correlation, for the caller to collect later. */
  respond(
    workspace: string,
    correlation: string,
    messageSeq: number,
    body: Json,
    headers: Headers,
  ) {
    this.db.run(
      `INSERT INTO responses (workspace, correlation, message_seq, headers, body, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(workspace, correlation) DO NOTHING`,
      [
        workspace,
        correlation,
        messageSeq,
        JSON.stringify(headers),
        JSON.stringify(body ?? null),
        this.now(),
      ],
    );
  }

  response(workspace: string, correlation: string): Response | null {
    const row = this.db
      .query("SELECT * FROM responses WHERE workspace=? AND correlation=?")
      .get(workspace, correlation) as
      | {
          workspace: string;
          correlation: string;
          message_seq: number;
          headers: string;
          body: string | null;
          created_at: number;
        }
      | null;
    return row
      ? {
          workspace: row.workspace,
          correlation: row.correlation,
          messageSeq: row.message_seq,
          headers: parse<Headers>(row.headers, {}),
          body: parse<Json>(row.body, null),
          createdAt: row.created_at,
        }
      : null;
  }

  // ------------------------------------------------------------ consumers

  private touchConsumer(workspace: string, id: string) {
    this.db.run(
      "UPDATE consumers SET last_seen=? WHERE id=? AND workspace=?",
      [this.now(), id, workspace],
    );
  }

  register(workspace: string, input: RegisterConsumer): Consumer {
    const existing = this.db
      .query("SELECT data FROM consumers WHERE id=? AND workspace=?")
      .get(input.id, workspace) as { data: string } | null;
    const consumer: Consumer = {
      id: input.id,
      workspace,
      name: input.name,
      host: input.host,
      subscriptions: input.subscriptions,
      labels: input.labels ?? {},
      paused: existing ? (JSON.parse(existing.data) as Consumer).paused : false,
      registeredAt: existing
        ? (JSON.parse(existing.data) as Consumer).registeredAt
        : this.now(),
      lastSeen: this.now(),
    };
    this.db.run(
      `INSERT INTO consumers (id, workspace, last_seen, data) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, data=excluded.data`,
      [consumer.id, workspace, consumer.lastSeen, JSON.stringify(consumer)],
    );
    return consumer;
  }

  consumer(workspace: string, id: string): Consumer {
    const row = this.db
      .query("SELECT data FROM consumers WHERE id=? AND workspace=?")
      .get(id, workspace) as { data: string } | null;
    if (!row) throw new BusError("consumer not registered", 404);
    return JSON.parse(row.data) as Consumer;
  }

  pauseConsumer(workspace: string, id: string, paused: boolean): Consumer {
    const consumer = { ...this.consumer(workspace, id), paused };
    this.db.run("UPDATE consumers SET data=? WHERE id=? AND workspace=?", [
      JSON.stringify(consumer),
      id,
      workspace,
    ]);
    return consumer;
  }

  consumers(workspace: string): Consumer[] {
    return (
      this.db
        .query(
          "SELECT data FROM consumers WHERE workspace=? ORDER BY last_seen DESC",
        )
        .all(workspace) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as Consumer);
  }

  /**
   * How many consumers have checked in recently. Readiness is a property of the
   * install, not of one tenant, so `workspace` is optional here — an install
   * with consumers in some other workspace is still able to run work.
   */
  liveConsumers(workspace?: string, withinMs = 60_000): number {
    const since = this.now() - withinMs;
    const row = (
      workspace === undefined
        ? this.db
            .query("SELECT COUNT(*) AS n FROM consumers WHERE last_seen > ?")
            .get(since)
        : this.db
            .query(
              "SELECT COUNT(*) AS n FROM consumers WHERE workspace=? AND last_seen > ?",
            )
            .get(workspace, since)
    ) as { n: number };
    return row.n;
  }

  // ----------------------------------------------------------- operations

  stats(workspace: string): Stats {
    const lastSeq = this.lastSeq();
    const subscriptions: SubscriptionStats[] = this.subscriptions(workspace).map(
      (subscription) => {
        const counts = this.db
          .query(
            "SELECT status, COUNT(*) AS n FROM deliveries WHERE subscription_id=? GROUP BY status",
          )
          .all(subscription.id) as { status: DeliveryStatus; n: number }[];
        const of = (status: DeliveryStatus) =>
          counts.find((row) => row.status === status)?.n ?? 0;
        return {
          ...subscription,
          pending: of("pending"),
          leased: of("leased"),
          dead: of("dead"),
          lag: Math.max(0, lastSeq - subscription.cursorSeq),
        };
      },
    );
    const messages = this.db
      .query("SELECT COUNT(*) AS n FROM messages WHERE workspace=?")
      .get(workspace) as { n: number };
    return {
      subscriptions,
      consumers: this.consumers(workspace),
      messages: messages.n,
      lastSeq,
      now: this.now(),
    };
  }

  /**
   * Delete blobs no message references any more.
   *
   * Kept off `sweep` because it is the one part that touches a filesystem, and
   * the sweep runs every second on the same thread as every claim. A dead
   * letter shares its original's handle, so "no message references it" is the
   * only safe test — reference counting a two-row relationship is not worth a
   * table.
   */
  async collectBlobs(): Promise<number> {
    if (!this.blobs) return 0;
    const orphans = this.db
      .query(
        `SELECT handle FROM blobs
          WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.body_blob = blobs.handle)`,
      )
      .all() as { handle: string }[];
    for (const { handle } of orphans) {
      await this.blobs.delete(handle);
      this.db.run("DELETE FROM blobs WHERE handle = ?", [handle]);
    }
    return orphans.length;
  }

  /**
   * Expire leases, drop expired messages, prune history.
   *
   * Both deletions are guarded by the same predicate, for the same reason:
   * `deliveries` cascades from `messages`, so removing a message removes any
   * unfinished delivery of it. A cursor being past a message means it was
   * *examined*, not that anyone finished it — so "every subscription has moved
   * past it" is not enough on its own.
   */
  sweep() {
    this.reclaim();
    const now = this.now();
    const UNFINISHED = `NOT EXISTS (
      SELECT 1 FROM deliveries d
       WHERE d.message_seq = messages.seq AND d.status IN ('pending','leased'))`;

    this.db.run(
      `DELETE FROM messages
        WHERE expires_at IS NOT NULL AND expires_at <= ? AND ${UNFINISHED}`,
      [now],
    );
    if (this.retentionMs > 0)
      this.db.run(
        `DELETE FROM messages
          WHERE published_at < ?
            AND seq <= COALESCE((SELECT MIN(cursor_seq) FROM subscriptions), 0)
            AND ${UNFINISHED}`,
        [now - this.retentionMs],
      );
  }
}
