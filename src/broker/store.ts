import { Database } from "bun:sqlite";
import type {
  BusEvent,
  Claim,
  Completion,
  DispatchRequest,
  Labels,
  LogChannel,
  RegisterWorker,
  Snapshot,
  Task,
  TaskStatus,
  TaskSummary,
  Usage,
  Worker,
} from "../shared/protocol";
import { isTerminal } from "../shared/protocol";

export class BrokerError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

const uuid = () => crypto.randomUUID();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(text: string | null): T =>
  (text === null ? null : JSON.parse(text)) as T;
const digest = (value: unknown) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

interface TaskRow {
  id: string;
  idempotency_key: string;
  runtime: string;
  status: TaskStatus;
  worker_id: string | null;
  generation: number;
  lease_until: number | null;
  deadline_at: number | null;
  attempt: number;
  data: string;
}

export interface StoreOptions {
  now?: () => number;
  leaseMs?: number;
  /** Journal rows older than this are pruned on `sweep`. 0 disables pruning. */
  retentionMs?: number;
}

/**
 * The broker's durable state.
 *
 * Everything the queue is searched by is a real column with an index; the rest
 * of a record rides in a JSON `data` blob. The prototype scanned whole tables
 * for every claim, which is fine for six rows and wrong for a queue.
 *
 * One process writes this database, exactly as dagr's engine owns its own. What
 * makes the workers distributed is that they never open it: they hold leases
 * over HTTP, and the conditional `UPDATE … WHERE status='queued'` is what makes
 * two workers racing for one task safe rather than merely unlikely.
 */
export class BrokerStore {
  private db: Database;
  private now: () => number;
  readonly leaseMs: number;
  private retentionMs: number;

  constructor(path: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    // Below a second there is no room for a worker to heartbeat inside the
    // window, and every long step would flap between workers.
    this.leaseMs = Math.max(1000, options.leaseMs ?? 15_000);
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA synchronous=FULL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run("PRAGMA foreign_keys=ON");
    this.migrate();
  }

  private migrate() {
    this.db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      runtime TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_id TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      deadline_at INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL)`);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, created_at)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS tasks_lease ON tasks(status, lease_until)",
    );
    // Deadlines are swept every second, so they get a column of their own
    // rather than a scan that deserializes every open task's JSON.
    this.db.run(
      "CREATE INDEX IF NOT EXISTS tasks_deadline ON tasks(deadline_at) WHERE deadline_at IS NOT NULL",
    );
    this.db.run(`CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, data TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL)`);
    this.db.run("CREATE INDEX IF NOT EXISTS events_task ON events(task_id)");
    this.db.run(`CREATE TABLE IF NOT EXISTS completions (
      task_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      digest TEXT NOT NULL)`);
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- events

  private emit(
    type: string,
    task: { id: string; runId: string } | null,
    data: Record<string, unknown>,
    source = "urn:agenticbus:broker",
  ) {
    const id = uuid();
    const event: Omit<BusEvent, "seq"> = {
      id,
      specversion: "1.0",
      source,
      type: `dev.agenticbus.${type}.v1`,
      subject: task ? `tasks/${task.id}` : "workers",
      taskId: task?.id ?? null,
      runId: task?.runId ?? null,
      time: new Date(this.now()).toISOString(),
      data,
    };
    this.db.run(
      "INSERT INTO events(id, task_id, run_id, created_at, data) VALUES (?,?,?,?,?)",
      [id, event.taskId, event.runId, this.now(), JSON.stringify(event)],
    );
  }

  events(after = 0, limit = 1000): BusEvent[] {
    return (
      this.db
        .query(
          "SELECT seq, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        )
        .all(after, limit) as { seq: number; data: string }[]
    ).map((row) => ({ ...JSON.parse(row.data), seq: row.seq }));
  }

  lastSeq(): number {
    const row = this.db.query("SELECT MAX(seq) AS seq FROM events").get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  // ----------------------------------------------------------------- tasks

  private row(id: string): TaskRow {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | null;
    if (!row) throw new BrokerError("task not found", 404);
    return row;
  }

  private hydrate(row: TaskRow): Task {
    return {
      ...parse<Omit<Task, keyof TaskRow | "status">>(row.data),
      id: row.id,
      idempotencyKey: row.idempotency_key,
      runtime: row.runtime,
      status: row.status,
      workerId: row.worker_id,
      generation: row.generation,
      leaseUntil: row.lease_until,
      deadlineAt: row.deadline_at,
      attempt: row.attempt,
    } as Task;
  }

  private write(task: Task) {
    const {
      id,
      idempotencyKey,
      runtime,
      status,
      workerId,
      generation,
      leaseUntil,
      deadlineAt,
      attempt,
      ...rest
    } = task;
    this.db.run(
      `INSERT INTO tasks (id, idempotency_key, runtime, status, worker_id, generation, lease_until, deadline_at, attempt, created_at, data)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, worker_id=excluded.worker_id,
         generation=excluded.generation, lease_until=excluded.lease_until,
         deadline_at=excluded.deadline_at, attempt=excluded.attempt, data=excluded.data`,
      [
        id,
        idempotencyKey,
        runtime,
        status,
        workerId,
        generation,
        leaseUntil,
        deadlineAt,
        attempt,
        task.createdAt,
        json(rest),
      ],
    );
  }

  task(id: string): Task {
    return this.hydrate(this.row(id));
  }

  byKey(key: string): Task | null {
    const row = this.db
      .query("SELECT * FROM tasks WHERE idempotency_key = ?")
      .get(key) as TaskRow | null;
    return row ? this.hydrate(row) : null;
  }

  /**
   * Accept a dispatch. Idempotent on `idempotencyKey`, which is dagr's stable
   * `${runId}:${stepKey}` — so a step re-dispatched after an engine crash
   * reattaches to remote work still in flight instead of starting a second copy.
   */
  dispatch(request: DispatchRequest): Task {
    return this.db.transaction(() => {
      const existing = this.byKey(request.idempotencyKey);
      if (existing) {
        if (existing.runtime !== request.runtime)
          throw new BrokerError(
            "idempotency key already dispatched with a different runtime",
          );
        if (existing.status === "cancelled") {
          // A cancelled attempt should not wedge the key: dagr is entitled to
          // retry the step, and that retry is new work.
          existing.status = "queued";
          existing.cancelRequested = false;
          existing.error = null;
          existing.workerId = null;
          existing.leaseUntil = null;
          existing.engineAttempt = request.attempt;
          existing.updatedAt = this.now();
          this.write(existing);
          this.emit("task.requeued", existing, { reason: "redispatched" });
        }
        return existing;
      }
      const task: Task = {
        id: uuid(),
        idempotencyKey: request.idempotencyKey,
        runtime: request.runtime,
        selector: request.selector,
        input: request.input,
        uses: request.uses ?? null,
        script: request.script ?? null,
        runId: request.runId,
        stepKey: request.stepKey,
        workspace: request.workspace,
        status: "queued",
        engineAttempt: request.attempt,
        attempt: 0,
        maxAttempts: Math.max(1, request.maxAttempts),
        deadlineAt: request.deadlineAt,
        provider: request.provider,
        workerId: null,
        generation: 0,
        leaseUntil: null,
        checkpoint: null,
        value: null,
        usage: null,
        error: null,
        cancelRequested: false,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.write(task);
      this.emit("task.dispatched", task, {
        runtime: task.runtime,
        selector: task.selector,
        runId: task.runId,
        stepKey: task.stepKey,
      });
      return task;
    })();
  }

  /**
   * Hand one queued task to a worker.
   *
   * Selection is by runtime and label match; the claim itself is a conditional
   * update that only transitions out of `queued`, so a row already taken cannot
   * be taken twice even when two brokers-worth of workers race.
   */
  claim(workerId: string): Claim | null {
    return this.db.transaction(() => {
      this.reclaim();
      const worker = this.worker(workerId);
      worker.lastSeen = this.now();
      this.writeWorker(worker);
      if (worker.paused) return null;
      if (worker.runtimes.length === 0) return null;

      const candidates = this.db
        .query(
          `SELECT * FROM tasks WHERE status='queued' AND runtime IN (${worker.runtimes
            .map(() => "?")
            .join(",")}) ORDER BY created_at LIMIT 50`,
        )
        .all(...worker.runtimes) as TaskRow[];

      for (const row of candidates) {
        const task = this.hydrate(row);
        if (!matches(task.selector, worker.labels)) continue;
        if (task.deadlineAt !== null && task.deadlineAt <= this.now()) {
          this.fail(task, "deadline passed before a worker claimed it", true);
          continue;
        }
        const claimed = this.db.run(
          `UPDATE tasks SET status='running', worker_id=?, generation=generation+1,
             attempt=attempt+1, lease_until=? WHERE id=? AND status='queued'`,
          [workerId, this.now() + this.leaseMs, task.id],
        );
        if (claimed.changes !== 1) continue;
        const fresh = this.task(task.id);
        fresh.updatedAt = this.now();
        this.write(fresh);
        this.emit("task.claimed", fresh, {
          workerId,
          generation: fresh.generation,
          attempt: fresh.attempt,
          runtime: fresh.runtime,
        });
        return { task: fresh, leaseMs: this.leaseMs };
      }
      return null;
    })();
  }

  /** Throws unless this worker still holds an unexpired lease at `generation`. */
  private owned(taskId: string, workerId: string, generation: number): Task {
    const task = this.task(taskId);
    if (
      task.status !== "running" ||
      task.workerId !== workerId ||
      task.generation !== generation ||
      (task.leaseUntil ?? 0) <= this.now()
    )
      throw new BrokerError("stale task lease");
    return task;
  }

  heartbeat(taskId: string, workerId: string, generation: number) {
    return this.db.transaction(() => {
      const task = this.owned(taskId, workerId, generation);
      task.leaseUntil = this.now() + this.leaseMs;
      task.updatedAt = this.now();
      this.write(task);
      const worker = this.worker(workerId);
      worker.lastSeen = this.now();
      this.writeWorker(worker);
      return {
        leaseUntil: task.leaseUntil,
        cancelRequested: task.cancelRequested,
      };
    })();
  }

  /** Scratch written during an attempt, handed to the next one. */
  checkpoint(
    taskId: string,
    workerId: string,
    generation: number,
    value: unknown,
  ) {
    return this.db.transaction(() => {
      const task = this.owned(taskId, workerId, generation);
      task.checkpoint = value;
      task.updatedAt = this.now();
      this.write(task);
      return { ok: true };
    })();
  }

  log(
    taskId: string,
    workerId: string,
    generation: number,
    channel: LogChannel,
    message: string,
  ) {
    const task = this.owned(taskId, workerId, generation);
    this.emit(
      "task.log",
      task,
      { channel, message: message.slice(0, 8000), workerId },
      `urn:agenticbus:worker:${workerId}`,
    );
    return { ok: true };
  }

  /**
   * Record a terminal result.
   *
   * Duplicate-safe: a replayed completion with the same worker, generation and
   * result digest is accepted silently, because the worker's outbox may well
   * deliver the same bytes twice. A *different* result for a task that already
   * completed is a conflict, not a correction.
   */
  complete(taskId: string, result: Completion): Task {
    return this.db.transaction(() => {
      const hash = digest([
        result.generation,
        result.ok,
        result.value ?? null,
        result.error ?? null,
      ]);
      const prior = this.db
        .query("SELECT * FROM completions WHERE task_id = ?")
        .get(taskId) as {
        worker_id: string;
        generation: number;
        digest: string;
      } | null;
      if (prior) {
        if (
          prior.worker_id === result.workerId &&
          prior.generation === result.generation &&
          prior.digest === hash
        )
          return this.task(taskId);
        throw new BrokerError("completion conflict");
      }
      const task = this.owned(taskId, result.workerId, result.generation);
      this.db.run(
        "INSERT INTO completions (task_id, worker_id, generation, digest) VALUES (?,?,?,?)",
        [taskId, result.workerId, result.generation, hash],
      );
      task.usage = result.usage ?? null;
      task.leaseUntil = null;
      task.updatedAt = this.now();
      if (result.ok) {
        task.status = "succeeded";
        task.value = result.value ?? null;
        task.error = null;
        task.workerId = result.workerId;
        this.write(task);
        this.emit("task.succeeded", task, {
          workerId: result.workerId,
          attempt: task.attempt,
          usage: task.usage ?? {},
        });
        return task;
      }
      const error = result.error ?? "remote step failed";
      // A fatal failure is the handler's verdict and must not be re-attempted
      // here; dagr's own `retries` policy decides whether the step runs again.
      const exhausted = result.fatal === true || task.attempt >= task.maxAttempts;
      if (exhausted) {
        this.fail(task, error, result.fatal === true);
        return this.task(taskId);
      }
      this.db.run("DELETE FROM completions WHERE task_id = ?", [taskId]);
      task.status = "queued";
      task.workerId = null;
      task.error = error;
      this.write(task);
      this.emit("task.requeued", task, {
        reason: error,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
      });
      return task;
    })();
  }

  private fail(task: Task, error: string, fatal: boolean) {
    task.status = "failed";
    task.error = error;
    task.leaseUntil = null;
    task.updatedAt = this.now();
    this.write(task);
    this.emit("task.failed", task, {
      error,
      fatal,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
    });
  }

  /**
   * Ask for a task to stop. Cooperative by construction: the worker learns of
   * it on its next heartbeat and aborts its child process. A queued task can be
   * cancelled outright because nothing is running yet.
   */
  cancel(taskId: string, reason = "cancelled by the engine"): Task {
    return this.db.transaction(() => {
      const task = this.task(taskId);
      if (isTerminal(task.status)) return task;
      task.cancelRequested = true;
      task.updatedAt = this.now();
      if (task.status === "queued") {
        task.status = "cancelled";
        task.error = reason;
        task.leaseUntil = null;
      }
      this.write(task);
      this.emit("task.cancel_requested", task, { reason });
      return task;
    })();
  }

  /**
   * Return leases that expired to the queue.
   *
   * This is the distributed half of the design: dagr keeps leases only for
   * crash recovery because it has one worker, while here a worker really can
   * vanish mid-step with the engine still healthy, and the task has to find
   * another machine.
   */
  reclaim(): number {
    return this.db.transaction(() => {
      const expired = this.db
        .query(
          "SELECT * FROM tasks WHERE status='running' AND lease_until IS NOT NULL AND lease_until <= ?",
        )
        .all(this.now()) as TaskRow[];
      for (const row of expired) {
        const task = this.hydrate(row);
        task.leaseUntil = null;
        task.workerId = null;
        task.updatedAt = this.now();
        if (task.attempt >= task.maxAttempts) {
          this.fail(
            task,
            `worker lease expired on attempt ${task.attempt} of ${task.maxAttempts}`,
            false,
          );
        } else {
          task.status = "queued";
          task.error = "worker lease expired";
          this.write(task);
          this.emit("task.lease_expired", task, {
            attempt: task.attempt,
            maxAttempts: task.maxAttempts,
            requeued: true,
          });
        }
      }
      return expired.length;
    })();
  }

  /** Fail anything past its deadline, whoever holds it. */
  expireDeadlines(): number {
    return this.db.transaction(() => {
      const rows = this.db
        .query(
          `SELECT * FROM tasks WHERE status IN ('queued','running')
             AND deadline_at IS NOT NULL AND deadline_at <= ?`,
        )
        .all(this.now()) as TaskRow[];
      for (const row of rows)
        this.fail(this.hydrate(row), "remote step exceeded its deadline", true);
      return rows.length;
    })();
  }

  sweep() {
    this.reclaim();
    this.expireDeadlines();
    if (this.retentionMs > 0) {
      const cutoff = this.now() - this.retentionMs;
      this.db.run("DELETE FROM events WHERE created_at < ?", [cutoff]);
      this.db.run(
        "DELETE FROM tasks WHERE status IN ('succeeded','failed','cancelled') AND created_at < ?",
        [cutoff],
      );
    }
  }

  // --------------------------------------------------------------- workers

  private writeWorker(worker: Worker) {
    this.db.run(
      `INSERT INTO workers (id, last_seen, data) VALUES (?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, data=excluded.data`,
      [worker.id, worker.lastSeen, json(worker)],
    );
  }

  worker(id: string): Worker {
    const row = this.db.query("SELECT data FROM workers WHERE id = ?").get(id) as
      | { data: string }
      | null;
    if (!row) throw new BrokerError("worker not registered", 404);
    return JSON.parse(row.data);
  }

  register(input: RegisterWorker): Worker {
    return this.db.transaction(() => {
      let existing: Worker | null = null;
      try {
        existing = this.worker(input.id);
      } catch {
        existing = null;
      }
      const worker: Worker = {
        ...input,
        paused: existing?.paused ?? false,
        registeredAt: existing?.registeredAt ?? this.now(),
        lastSeen: this.now(),
      };
      this.writeWorker(worker);
      if (!existing)
        this.emit("worker.registered", null, {
          workerId: worker.id,
          name: worker.name,
          host: worker.host,
          runtimes: worker.runtimes,
          labels: worker.labels,
        });
      return worker;
    })();
  }

  pause(workerId: string, paused: boolean): Worker {
    const worker = this.worker(workerId);
    worker.paused = paused;
    this.writeWorker(worker);
    this.emit(paused ? "worker.paused" : "worker.resumed", null, { workerId });
    return worker;
  }

  /** How many workers have checked in recently and are accepting work. */
  liveWorkers(withinMs = 60_000): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM workers WHERE last_seen > ?")
      .get(this.now() - withinMs) as { n: number };
    return row.n;
  }

  workers(): Worker[] {
    return (
      this.db
        .query("SELECT data FROM workers ORDER BY last_seen DESC")
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }

  // -------------------------------------------------------------- readouts

  private summarize(task: Task): TaskSummary {
    const { input, value, checkpoint, ...summary } = task;
    return summary;
  }

  tasks(limit = 200): TaskSummary[] {
    return (
      this.db
        .query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
        .all(limit) as TaskRow[]
    ).map((row) => this.summarize(this.hydrate(row)));
  }

  snapshot(): Snapshot {
    const depth = this.db
      .query(
        "SELECT runtime, COUNT(*) AS n FROM tasks WHERE status='queued' GROUP BY runtime",
      )
      .all() as { runtime: string; n: number }[];
    return {
      tasks: this.tasks(),
      workers: this.workers(),
      events: (
        this.db
          .query("SELECT seq, data FROM events ORDER BY seq DESC LIMIT 100")
          .all() as { seq: number; data: string }[]
      )
        .reverse()
        .map((row) => ({ ...JSON.parse(row.data), seq: row.seq })),
      queueDepth: Object.fromEntries(depth.map((d) => [d.runtime, d.n])),
      now: this.now(),
    };
  }

  usageTotals(): Usage {
    const rows = this.db
      .query("SELECT data FROM tasks WHERE status='succeeded'")
      .all() as { data: string }[];
    const total: Usage = {};
    for (const row of rows) {
      const usage = (JSON.parse(row.data).usage ?? {}) as Usage;
      for (const [key, value] of Object.entries(usage))
        if (typeof value === "number")
          total[key as keyof Usage] = (total[key as keyof Usage] ?? 0) + value;
    }
    return total;
  }
}

/** Every selector entry must equal the worker's label of the same key. */
export function matches(selector: Labels, labels: Labels): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}
