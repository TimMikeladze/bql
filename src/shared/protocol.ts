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
}

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
}

export interface SubscribeRequest {
  name: string;
  pattern: string;
  ackWaitMs?: number;
  maxAttempts?: number;
  ordered?: boolean;
  dlqSubject?: string;
  deliverFrom?: DeliverFrom;
}

export type DeliveryStatus = "pending" | "leased" | "acked" | "dead";

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
}

/** A leased delivery with the message it carries. */
export interface Envelope {
  delivery: Delivery;
  message: Message;
  /** Stable `<subscription>:<seq>`, for consumers making external effects once. */
  idempotencyKey: string;
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
}
export interface NackRequest extends AckRequest {
  error?: string;
  /** Skip remaining attempts and dead-letter immediately. */
  fatal?: boolean;
  /** Hold the delivery back this long before it becomes claimable again. */
  delayMs?: number;
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
  dead: number;
  /** Messages in the log this subscription has not examined yet. */
  lag: number;
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
}

export const ANY = "*";
export const isTerminal = (status: DeliveryStatus) =>
  status === "acked" || status === "dead";
