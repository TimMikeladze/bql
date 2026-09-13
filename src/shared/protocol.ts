/** Wire contracts for the bus. Nothing here knows what an agent is. */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };
export type Headers = Record<string, string>;

export const DEFAULT_WORKSPACE = "default";

export interface Message {
  seq: number;
  id: string;
  workspace: string;
  subject: string;
  /** Ordering key. Deliveries sharing one are serialized on ordered subscriptions. */
  key: string | null;
  headers: Headers;
  body: Json;
  publishedAt: number;
  expiresAt: number | null;
  dedupeKey: string | null;
  /** Set once cancelled: no subscription will materialize a delivery for it. */
  cancelledAt: number | null;
  /** The token subject that published it. `*` for an admin token. */
  publisher: string | null;
  /** −2…2. Higher is served first within a subscription. */
  priority: number;
  /** Epoch ms before which no delivery of this message may be claimed. */
  availableAt: number;
}

/** Per-subscription retry pacing. Full jitter; see `Subscription.backoff`. */
export interface Backoff {
  baseMs: number;
  maxMs: number;
  factor: number;
  jitter: "full" | "none";
}

/** When to stop a subscription that is melting into its dead-letter queue. */
export interface Quarantine {
  /** Dead ÷ settled over the window, above which the subscription pauses. 0 is off. */
  deadRate: number;
  windowMs: number;
  /** Never quarantine on fewer dead letters than this, however bad the rate. */
  minDead: number;
}

export const MIN_PRIORITY = -2;
export const MAX_PRIORITY = 2;

export interface PublishRequest {
  subject: string;
  body?: Json;
  key?: string | null;
  headers?: Headers;
  /** Publishing the same key twice in a workspace returns the first message. */
  dedupeKey?: string | null;
  /** Subject a reply should be published to; sets up a durable response. */
  replyTo?: string | null;
  correlation?: string | null;
  ttlMs?: number | null;
  /** Marks this publish as the answer to `correlation`, not a new request. */
  reply?: boolean;
  /** −2…2, clamped. Higher is claimed first within a subscription. */
  priority?: number;
  /** Hold every delivery of this message back this long. */
  delayMs?: number;
  /** Absolute epoch ms alternative to `delayMs`. The later of the two wins. */
  deliverAt?: number;
}

export interface PublishResult {
  seq: number;
  id: string;
  duplicate: boolean;
  correlation: string | null;
}

export type DeliverFrom = "new" | "beginning" | number;

export interface Subscription {
  id: string;
  workspace: string;
  name: string;
  pattern: string;
  /** How far this subscription has read the log. */
  cursorSeq: number;
  ackWaitMs: number;
  maxAttempts: number;
  /** Serialize deliveries that share a message key. */
  ordered: boolean;
  dlqSubject: string;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  /** How long a failed delivery waits before it is claimable again. */
  backoff: Backoff;
  /**
   * What an ordered subscription does when a key's message dead-letters.
   * `block` stalls that key — and only that key — until an operator requeues
   * or skips it. `skip` lets the next message through, which is a reordering.
   */
  onFailure: "block" | "skip";
  /** Ceiling on leased deliveries at once. 0 is unbounded. */
  maxInFlight: number;
  quarantine: Quarantine;
  /** Set when the bus paused this subscription for a dead-letter storm. */
  quarantinedAt: number | null;
}

export interface SubscribeRequest {
  name: string;
  pattern: string;
  ackWaitMs?: number;
  maxAttempts?: number;
  ordered?: boolean;
  dlqSubject?: string;
  deliverFrom?: DeliverFrom;
  backoff?: Partial<Backoff>;
  onFailure?: "block" | "skip";
  maxInFlight?: number;
  quarantine?: Partial<Quarantine>;
}

/** A key an ordered subscription will not move past until an operator acts. */
export interface BlockedKey {
  subscription: string;
  key: string;
  messageSeq: number;
  deliveryId: string;
  reason: string;
  createdAt: number;
}

export type DeliveryStatus =
  | "pending"
  | "leased"
  | "acked"
  | "dead"
  | "cancelled";

export interface Delivery {
  id: string;
  subscriptionId: string;
  subscription: string;
  messageSeq: number;
  status: DeliveryStatus;
  consumerId: string | null;
  /** Monotonic per delivery; fences a lease that has moved on. */
  generation: number;
  attempt: number;
  maxAttempts: number;
  leaseUntil: number | null;
  key: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  priority: number;
  /** Epoch ms before which this delivery may not be claimed. */
  availableAt: number;
}

/** A leased delivery with the message it carries. */
export interface Envelope {
  delivery: Delivery;
  message: Message;
  /** Stable `<subscription>:<seq>`, for consumers making external effects once. */
  idempotencyKey: string;
  /**
   * `<deliveryId>:<generation>` — this *attempt*, not this message.
   *
   * Monotonic per delivery, so a destination that supports a conditional write
   * (S3 `If-Match`, `WHERE fence < ?`) can reject a writer whose lease has
   * already been reclaimed by someone else. The idempotency key says "the same
   * work"; the fence says "the newer attempt".
   */
  fence: string;
}

export interface ClaimRequest {
  consumer: string;
  max?: number;
  /** Long-poll window. The broker holds the request open this long for work. */
  waitMs?: number;
}

export interface AckRequest {
  consumer: string;
  generation: number;
  /**
   * Messages to publish in the *same transaction* as the ack.
   *
   * Tier 2: a chain of consumers that stays on the bus is exactly-once end to
   * end, because "this work is finished" and "here is what it produced" commit
   * or roll back together. There is no window in which one happened and the
   * other did not.
   */
  publish?: PublishRequest[];
  /** Effect-ledger results to record with the ack. See `effects`. */
  effects?: EffectRecord[];
}

/** One entry in the effect ledger: a key, and what the effect returned. */
export interface EffectRecord {
  key: string;
  result?: Json;
}

export interface EffectClaim {
  /** True when the caller should perform the effect. */
  fresh: boolean;
  /** The recorded result, when a previous attempt completed it. */
  result: Json | null;
  /**
   * True when a previous attempt claimed this key and never recorded a result
   * — the documented window. The effect may or may not have happened; the
   * fence token is what lets the destination reject the older writer.
   */
  retried: boolean;
}

/** What an ack answers: the delivery, plus anything that committed with it. */
export interface AckResult extends Delivery {
  published: PublishResult[];
  /**
   * True when this ack had already been recorded by the same consumer and
   * generation. A retried ack after a lost response is a success, not a 409.
   */
  replayed: boolean;
}
export interface NackRequest extends AckRequest {
  error?: string;
  /** Skip remaining attempts and dead-letter immediately. */
  fatal?: boolean;
  /** Hold the delivery back this long before it becomes claimable again. */
  delayMs?: number;
}

/** What `extend` answers: a renewed lease, or the news that it was cancelled. */
export interface ExtendResult {
  leaseUntil: number | null;
  cancelled: boolean;
}

export interface CancelResult {
  /** Deliveries moved to `cancelled` by this call. */
  cancelled: number;
  alreadyCancelled: boolean;
}

/** Enough of a message to decide who may act on it. */
export interface MessageMeta {
  seq: number;
  subject: string;
  publisher: string | null;
  cancelledAt: number | null;
}

export interface Response {
  workspace: string;
  correlation: string;
  messageSeq: number;
  body: Json;
  headers: Headers;
  createdAt: number;
}

export interface Consumer {
  id: string;
  workspace: string;
  name: string;
  host: string;
  subscriptions: string[];
  labels: Record<string, string>;
  lastSeen: number;
  paused: boolean;
  registeredAt: number;
}

export interface RegisterConsumer {
  id: string;
  name: string;
  host: string;
  subscriptions: string[];
  labels?: Record<string, string>;
}

export interface SubscriptionStats extends Subscription {
  pending: number;
  leased: number;
  acked: number;
  dead: number;
  cancelled: number;
  /** Messages in the log this subscription has not examined yet. */
  lag: number;
  /** How long the oldest pending delivery has been waiting. 0 when empty. */
  oldestPendingAgeMs: number;
}

export interface Stats {
  subscriptions: SubscriptionStats[];
  consumers: Consumer[];
  messages: number;
  lastSeq: number;
  now: number;
}

/** Token claims. Signed by the broker, verified statelessly on every request. */
export interface TokenClaims {
  /** Consumer id this token may act as; `*` for admin and reader tokens. */
  sub: string;
  scope: "consumer" | "reader" | "admin";
  workspace: string;
  /** Subject patterns this token may publish to. */
  publish: string[];
  /** Subscription names this token may claim from. `*` for all. */
  subscribe: string[];
  /** Epoch seconds; 0 means no expiry. */
  exp: number;
  /**
   * Token id. Every token minted by this build has one, because revocation
   * needs something to revoke that is not "the key everyone else is using".
   */
  jti?: string;
  /**
   * Which signing key signed this. Read from the *unverified* payload to pick
   * the key — choosing which key to check against proves nothing on its own,
   * and the signature still has to match.
   */
  kid?: string;
}

export const ANY = "*";
export const isTerminal = (status: DeliveryStatus) =>
  status === "acked" || status === "dead" || status === "cancelled";

// --------------------------------------------------------------- schemas

export type CompatMode = "backward" | "forward" | "full" | "none";
export type SchemaMode = "enforce" | "warn" | "off";

export interface Violation {
  /** JSON Pointer into the instance. */
  pointer: string;
  message: string;
}

export interface CompatChange {
  /** Pointer into the schema where the change is. */
  pointer: string;
  /** `narrowed`: the new version accepts less. `widened`: it accepts more. */
  direction: "narrowed" | "widened";
  detail: string;
}

export interface SchemaVersion {
  workspace: string;
  name: string;
  version: number;
  /** The JSON Schema itself. */
  source: Json;
  hash: string;
  compat: CompatMode;
  createdAt: number;
}

export interface SchemaBinding {
  workspace: string;
  pattern: string;
  schema: string;
  mode: SchemaMode;
}

export interface SchemaCheck {
  changes: CompatChange[];
  breaking: CompatChange[];
  /** The version this was compared against, or null for a first registration. */
  against: number | null;
}

// ------------------------------------------------------- tenancy and audit

/** Per-workspace ceilings. 0 means unlimited. */
export interface Quota {
  maxMessages: number;
  maxBytes: number;
  maxSubscriptions: number;
}

export interface Usage {
  messages: number;
  bytes: number;
  subscriptions: number;
}

export interface AuditEntry {
  id: number;
  workspace: string;
  actor: string;
  scope: string;
  action: string;
  target: string | null;
  at: number;
}

// ----------------------------------------------------------- replication

export interface ClusterState {
  epoch: number;
  role: "leader" | "follower";
  upstream: string | null;
  /** Highest upstream sequence number this replica has applied. */
  appliedSeq: number;
  readOnly: boolean;
}
