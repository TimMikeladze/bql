import { Database } from "bun:sqlite";
import type {
  Artifact,
  BusEvent,
  Claim,
  Completion,
  NewRun,
  Role,
  Run,
  Snapshot,
  Task,
  Worker,
} from "../shared/protocol";

const id = () => crypto.randomUUID();
export class BusError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const roles: Role[] = ["creator", "reviewer", "tester"];
const digest = (content: string) =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex");
type Table = "runs" | "tasks" | "workers" | "artifacts";

/** Prototype store: small JSON records inside real SQLite transactions. */
export class BusStore {
  private db: Database;
  constructor(
    path: string,
    private now = Date.now,
    private leaseMs = 15_000,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    for (const table of ["runs", "tasks", "workers", "artifacts"])
      this.db.run(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
      );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS completions (task TEXT PRIMARY KEY, worker TEXT NOT NULL, generation INTEGER NOT NULL, digest TEXT NOT NULL)",
    );
  }
  close() {
    this.db.close();
  }
  private all<T>(table: Table): T[] {
    return (
      this.db.query(`SELECT data FROM ${table}`).all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  private get<T>(table: Table, key: string): T {
    const row = this.db
      .query(`SELECT data FROM ${table} WHERE id=?`)
      .get(key) as { data: string } | null;
    if (!row) throw new BusError(`${table} not found`, 404);
    return JSON.parse(row.data);
  }
  private put(table: Table, value: { id: string }) {
    this.db
      .query(
        `INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, JSON.stringify(value));
  }
  private emit(
    type: string,
    runId: string | null,
    data: Record<string, unknown>,
    source = "urn:agenticbus:coordinator",
    eventId: string = id(),
  ) {
    const event = {
      id: eventId,
      specversion: "1.0",
      source,
      type: `dev.agenticbus.${type}.v1`,
      subject: runId ? `runs/${runId}` : "workers",
      time: new Date(this.now()).toISOString(),
      runId,
      data,
    };
    this.db
      .query("INSERT INTO events(id,data) VALUES (?,?)")
      .run(eventId, JSON.stringify(event));
  }
  events(after = 0): BusEvent[] {
    return (
      this.db
        .query(
          "SELECT seq,data FROM events WHERE seq>? ORDER BY seq LIMIT 1000",
        )
        .all(after) as { seq: number; data: string }[]
    ).map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
  }
  snapshot(): Snapshot {
    const events = (
      this.db
        .query("SELECT seq,data FROM events ORDER BY seq DESC LIMIT 100")
        .all() as { seq: number; data: string }[]
    )
      .reverse()
      .map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
    return {
      runs: this.all<Run>("runs").sort((a, b) => b.createdAt - a.createdAt),
      tasks: this.all<Task>("tasks"),
      workers: this.all<Worker>("workers"),
      artifacts: this.all<Artifact>("artifacts").map(({ content, ...a }) => a),
      events,
      now: this.now(),
    };
  }
  artifact(key: string) {
    return this.get<Artifact>("artifacts", key);
  }
  createRun(input: NewRun): Run {
    return this.db.transaction(() => {
      const previous = this.all<Run>("runs").find(
        (r) => r.requestKey === input.requestKey,
      );
      if (previous) {
        if (
          previous.title !== input.title ||
          previous.brief !== input.brief ||
          previous.mode !== input.mode
        )
          throw new BusError("request key conflict");
        return previous;
      }
      const run: Run = {
        ...input,
        id: id(),
        status: "running",
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.put("runs", run);
      for (const role of roles)
        this.put("tasks", {
          id: id(),
          runId: run.id,
          role,
          status: role === "creator" ? "queued" : "blocked",
          workerId: null,
          generation: 0,
          leaseUntil: null,
          attempt: 0,
          inputArtifactId: null,
          outputArtifactId: null,
          error: null,
          createdAt: this.now(),
          updatedAt: this.now(),
        } as Task);
      this.emit("run.created", run.id, { title: run.title, mode: run.mode });
      return run;
    })();
  }
  registerWorker(input: Omit<Worker, "lastSeen" | "paused">): Worker {
    const old = this.all<Worker>("workers").find((w) => w.id === input.id);
    if (old && (old.role !== input.role || old.mode !== input.mode))
      throw new BusError("worker identity conflict");
    const w = { ...input, lastSeen: this.now(), paused: old?.paused ?? false };
    this.put("workers", w);
    if (!old)
      this.emit("worker.registered", null, {
        workerId: w.id,
        name: w.name,
        role: w.role,
        host: w.host,
        mode: w.mode,
      });
    return w;
  }
  pauseWorker(workerId: string, paused: boolean) {
    const w = this.get<Worker>("workers", workerId);
    w.paused = paused;
    this.put("workers", w);
    this.emit(paused ? "worker.paused" : "worker.resumed", null, { workerId });
    return w;
  }
  claim(workerId: string): Claim | null {
    return this.db.transaction(() => {
      this.recover();
      const w = this.get<Worker>("workers", workerId);
      w.lastSeen = this.now();
      this.put("workers", w);
      if (w.paused) return null;
      if (
        this.all<Task>("tasks").some(
          (t) => t.workerId === workerId && t.status === "running",
        )
      )
        return null;
      const t = this.all<Task>("tasks").find(
        (t) =>
          t.status === "queued" &&
          t.role === w.role &&
          this.get<Run>("runs", t.runId).mode === w.mode &&
          this.get<Run>("runs", t.runId).status === "running",
      );
      if (!t) return null;
      t.status = "running";
      t.workerId = w.id;
      t.generation++;
      t.attempt++;
      t.leaseUntil = this.now() + this.leaseMs;
      t.updatedAt = this.now();
      this.put("tasks", t);
      this.emit("task.claimed", t.runId, {
        taskId: t.id,
        role: t.role,
        workerId,
        generation: t.generation,
        attempt: t.attempt,
      });
      return {
        task: t,
        run: this.get<Run>("runs", t.runId),
        artifact: t.inputArtifactId ? this.artifact(t.inputArtifactId) : null,
      };
    })();
  }
  private owned(taskId: string, workerId: string, generation: number) {
    const t = this.get<Task>("tasks", taskId);
    if (
      t.status !== "running" ||
      t.workerId !== workerId ||
      t.generation !== generation ||
      (t.leaseUntil ?? 0) <= this.now()
    )
      throw new BusError("stale task lease");
    return t;
  }
  heartbeat(taskId: string, workerId: string, generation: number) {
    const t = this.owned(taskId, workerId, generation);
    t.leaseUntil = this.now() + this.leaseMs;
    this.put("tasks", t);
    const w = this.get<Worker>("workers", workerId);
    w.lastSeen = this.now();
    this.put("workers", w);
    return { leaseUntil: t.leaseUntil };
  }
  progress(
    taskId: string,
    workerId: string,
    generation: number,
    type: string,
    data: Record<string, unknown>,
  ) {
    const t = this.owned(taskId, workerId, generation);
    this.emit(
      type,
      t.runId,
      { ...data, taskId, role: t.role, workerId },
      `urn:agenticbus:worker:${workerId}`,
    );
  }
  complete(taskId: string, workerId: string, result: Completion) {
    return this.db.transaction(() => {
      const hash = digest(
        JSON.stringify([
          result.generation,
          result.ok,
          result.name,
          result.mediaType,
          result.content,
          result.error ?? null,
        ]),
      );
      const prior = this.db
        .query("SELECT * FROM completions WHERE task=?")
        .get(taskId) as {
        worker: string;
        generation: number;
        digest: string;
      } | null;
      if (prior) {
        if (
          prior.worker === workerId &&
          prior.generation === result.generation &&
          prior.digest === hash
        )
          return this.get<Task>("tasks", taskId);
        throw new BusError("completion conflict");
      }
      const t = this.owned(taskId, workerId, result.generation);
      const a: Artifact = {
        id: id(),
        runId: t.runId,
        taskId: t.id,
        name: result.name,
        mediaType: result.mediaType,
        content: result.content,
        digest: digest(result.content),
        createdAt: this.now(),
      };
      this.put("artifacts", a);
      t.outputArtifactId = a.id;
      t.status = result.ok ? "succeeded" : "failed";
      t.error = result.ok ? null : result.error || "Worker reported failure";
      t.leaseUntil = null;
      t.updatedAt = this.now();
      this.put("tasks", t);
      this.db
        .query("INSERT INTO completions VALUES (?,?,?,?)")
        .run(t.id, workerId, result.generation, hash);
      this.emit("artifact.created", t.runId, {
        artifactId: a.id,
        name: a.name,
        digest: a.digest,
        taskId: t.id,
      });
      this.emit(result.ok ? "task.completed" : "task.failed", t.runId, {
        taskId: t.id,
        role: t.role,
        artifactId: a.id,
        error: t.error,
      });
      const run = this.get<Run>("runs", t.runId);
      run.updatedAt = this.now();
      if (!result.ok) {
        run.status = "failed";
        this.emit("run.failed", run.id, { role: t.role, error: t.error });
      } else if (t.role === "creator") {
        for (const dep of this.all<Task>("tasks").filter(
          (x) => x.runId === t.runId && x.status === "blocked",
        )) {
          dep.status = "queued";
          dep.inputArtifactId = a.id;
          dep.updatedAt = this.now();
          this.put("tasks", dep);
        }
        this.emit("review.requested", t.runId, {
          artifactId: a.id,
          capabilities: ["code.review", "code.test"],
        });
      } else if (
        this.all<Task>("tasks")
          .filter((x) => x.runId === t.runId)
          .every((x) => x.status === "succeeded")
      ) {
        run.status = "waiting_approval";
        this.emit("approval.requested", run.id, {
          artifactId: t.inputArtifactId,
        });
      }
      this.put("runs", run);
      return t;
    })();
  }
  recover() {
    this.db.transaction(() => {
      for (const t of this.all<Task>("tasks").filter(
        (t) => t.status === "running" && (t.leaseUntil ?? 0) <= this.now(),
      )) {
        const run = this.get<Run>("runs", t.runId);
        t.leaseUntil = null;
        t.workerId = null;
        t.updatedAt = this.now();
        t.status = t.attempt >= 3 ? "failed" : "queued";
        t.error =
          t.status === "failed" ? "Worker lease expired three times" : null;
        this.put("tasks", t);
        this.emit("task.lease_expired", t.runId, {
          taskId: t.id,
          role: t.role,
          attempt: t.attempt,
          requeued: t.status === "queued",
        });
        if (t.status === "failed") {
          run.status = "failed";
          run.updatedAt = this.now();
          this.put("runs", run);
        }
      }
    })();
  }
  approve(runId: string) {
    return this.db.transaction(() => {
      const r = this.get<Run>("runs", runId);
      if (r.status === "succeeded") return r;
      if (r.status !== "waiting_approval")
        throw new BusError("run not ready for approval");
      r.status = "succeeded";
      r.updatedAt = this.now();
      this.put("runs", r);
      this.emit("approval.granted", runId, { decision: "accept_artifact" });
      return r;
    })();
  }
  cancel(runId: string) {
    return this.db.transaction(() => {
      const r = this.get<Run>("runs", runId);
      if (r.status === "cancelled") return r;
      if (r.status === "succeeded")
        throw new BusError("completed run cannot be cancelled");
      r.status = "cancelled";
      r.updatedAt = this.now();
      this.put("runs", r);
      for (const t of this.all<Task>("tasks").filter(
        (t) =>
          t.runId === runId &&
          ["queued", "blocked", "running"].includes(t.status),
      )) {
        t.status = "cancelled";
        t.generation++;
        t.leaseUntil = null;
        this.put("tasks", t);
      }
      this.emit("run.cancelled", runId, {
        reason: "Operator stopped this run",
      });
      return r;
    })();
  }
  retry(runId: string, requestKey: string) {
    const r = this.get<Run>("runs", runId);
    if (!["failed", "cancelled"].includes(r.status))
      throw new BusError("only stopped runs can be retried");
    return this.createRun({
      title: r.title,
      brief: r.brief,
      mode: r.mode,
      requestKey,
    });
  }
  hook(input: {
    id: string;
    source: string;
    type: string;
    data: Record<string, unknown>;
  }) {
    return this.db.transaction(() => {
      const key = digest(JSON.stringify([input.source, input.id]));
      const old = this.db
        .query("SELECT data FROM events WHERE id=?")
        .get(key) as { data: string } | null;
      if (old) {
        const prior = JSON.parse(old.data);
        if (
          prior.type !== `dev.agenticbus.hook.${input.type}.v1` ||
          JSON.stringify(prior.data) !== JSON.stringify(input.data)
        )
          throw new BusError("hook identity conflict");
        return { id: key, duplicate: true };
      }
      this.emit(`hook.${input.type}`, null, input.data, input.source, key);
      return { id: key, duplicate: false };
    })();
  }
}
