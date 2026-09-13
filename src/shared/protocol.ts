/** Wire contracts between the dagr engine host, the broker, and remote workers. */

export type Labels = Record<string, string>;

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export const TERMINAL: TaskStatus[] = ["succeeded", "failed", "cancelled"];
export const isTerminal = (status: TaskStatus) => TERMINAL.includes(status);

/**
 * Usage mirrors dagr's `ResourceUsage` field for field, so a remote step
 * accounts against the run's resource grant exactly as a local one does.
 */
export interface Usage {
  providerUnits?: number;
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  costMicros?: number;
}

export interface ProviderGrant {
  unit: string;
  units: number;
}

/** What the engine hands the broker. Deduplicated on `idempotencyKey`. */
export interface DispatchRequest {
  idempotencyKey: string;
  runtime: string;
  selector: Labels;
  input: unknown;
  uses?: string;
  script?: string;
  runId: string;
  stepKey: string;
  attempt: number;
  maxAttempts: number;
  /** Absolute epoch ms; the worker refuses to start past it and stops at it. */
  deadlineAt: number | null;
  provider: ProviderGrant | null;
  workspace: string;
}

export interface Task {
  id: string;
  idempotencyKey: string;
  runtime: string;
  selector: Labels;
  input: unknown;
  uses: string | null;
  script: string | null;
  runId: string;
  stepKey: string;
  workspace: string;
  status: TaskStatus;
  /** dagr's attempt number for the dispatching step, carried for correlation. */
  engineAttempt: number;
  /** Broker-side attempts: how many workers have claimed this task. */
  attempt: number;
  maxAttempts: number;
  deadlineAt: number | null;
  provider: ProviderGrant | null;
  workerId: string | null;
  generation: number;
  leaseUntil: number | null;
  /** Opaque worker scratch, handed back to the next attempt (agent session ids). */
  checkpoint: unknown;
  value: unknown;
  usage: Usage | null;
  error: string | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The task as an unprivileged reader sees it: no input, no result payload. */
export type TaskSummary = Omit<Task, "input" | "value" | "checkpoint">;

export interface Claim {
  task: Task;
  /**
   * How long the granted lease lasts. The worker paces its heartbeat off this
   * rather than a constant of its own: an operator who shortens the lease must
   * not silently break every worker in the fleet.
   */
  leaseMs: number;
}

export interface Completion {
  workerId: string;
  generation: number;
  ok: boolean;
  value?: unknown;
  usage?: Usage;
  error?: string;
  /** Retryable failures return to the queue; fatal ones fail the task outright. */
  fatal?: boolean;
}

export interface Worker {
  id: string;
  name: string;
  host: string;
  runtimes: string[];
  labels: Labels;
  lastSeen: number;
  paused: boolean;
  registeredAt: number;
}

export interface RegisterWorker {
  id: string;
  name: string;
  host: string;
  runtimes: string[];
  labels: Labels;
}

export type LogChannel = "info" | "warn" | "error" | "stdout" | "stderr";

export interface BusEvent {
  seq: number;
  id: string;
  specversion: "1.0";
  source: string;
  type: string;
  subject: string;
  taskId: string | null;
  runId: string | null;
  time: string;
  data: Record<string, unknown>;
}

export interface Snapshot {
  tasks: TaskSummary[];
  workers: Worker[];
  events: BusEvent[];
  queueDepth: Record<string, number>;
  now: number;
}

/** Token claims. Signed by the broker; verified statelessly on every request. */
export interface TokenClaims {
  /** Worker identity this token may register and claim as; `*` for admin. */
  sub: string;
  /** `reader` may only read fleet state; `admin` may also dispatch and mint. */
  scope: "worker" | "reader" | "admin";
  runtimes: string[];
  labels: Labels;
  /** Epoch seconds; 0 means no expiry. */
  exp: number;
}

export const ANY = "*";
