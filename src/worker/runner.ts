import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { Executor, SecretResolver, StepContext } from "dagr";
import type { Claim, Labels, LogChannel, Usage } from "../shared/protocol";

export interface WorkerOptions {
  id: string;
  name?: string;
  broker: string;
  token: string;
  labels?: Labels;
  executors: Map<string, Executor>;
  secrets: SecretResolver;
  /** Directory holding completions not yet accepted by the broker. */
  spool?: string;
  heartbeatMs?: number;
  idleMs?: number;
  host?: string;
  log?: (message: string) => void;
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The remote half of the bus.
 *
 * It claims a task, synthesizes the `StepContext` dagr would have built
 * in-process, and hands it to dagr's own executor. Everything that makes the
 * step safe — allowlists, subprocess kill discipline, the agent runtime's
 * session checkpointing — comes along because it is the same executor code.
 *
 * What this adds is what a network needs and a single process does not: a
 * lease it must keep renewing, a cancellation it learns about on a heartbeat
 * rather than through an in-process AbortSignal, and an on-disk outbox so a
 * finished computation is not lost when the broker is briefly unreachable.
 */
export class RemoteWorker {
  private readonly options: Required<
    Pick<WorkerOptions, "heartbeatMs" | "idleMs" | "spool" | "name" | "host">
  > &
    WorkerOptions;
  private stopping = false;
  private current?: AbortController;
  private readonly log: (message: string) => void;

  constructor(options: WorkerOptions) {
    this.options = {
      ...options,
      name: options.name ?? options.id,
      host: options.host ?? hostname(),
      heartbeatMs: options.heartbeatMs ?? 3000,
      idleMs: options.idleMs ?? 1000,
      spool: resolve(
        options.spool ??
          `.agenticbus/outbox/${options.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      ),
    };
    this.log = options.log ?? ((message) => console.log(message));
  }

  stop(reason = "worker shutting down") {
    this.stopping = true;
    this.current?.abort(reason);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.options.broker}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok)
      throw new RequestError(
        payload.error ?? `HTTP ${response.status}`,
        response.status,
      );
    return payload;
  }

  /** Deliver completions the broker has not accepted yet. */
  private async flush() {
    for (const file of await readdir(this.options.spool)) {
      if (!file.endsWith(".json")) continue;
      const path = `${this.options.spool}/${file}`;
      const pending = (await Bun.file(path).json()) as {
        taskId: string;
        body: unknown;
      };
      try {
        await this.post(`/api/tasks/${pending.taskId}/complete`, pending.body);
        await unlink(path);
      } catch (error) {
        // 404/409 mean the broker has moved on — the lease was reclaimed and
        // someone else owns this work. Dropping the record is correct; retrying
        // it forever is not.
        if (error instanceof RequestError && [404, 409].includes(error.status)) {
          await unlink(path);
          this.log(`[${this.options.id}] completion fenced, discarded`);
        } else throw error;
      }
    }
  }

  private async spoolCompletion(taskId: string, body: unknown) {
    const path = `${this.options.spool}/${taskId}.json`;
    await Bun.write(`${path}.tmp`, JSON.stringify({ taskId, body }));
    await rename(`${path}.tmp`, path);
    await this.flush();
  }

  private context(claim: Claim, abort: AbortController): StepContext {
    const { task } = claim;
    const send = (path: string, body: Record<string, unknown>) =>
      this.post(`/api/tasks/${task.id}/${path}`, {
        workerId: this.options.id,
        generation: task.generation,
        ...body,
      }).catch((error) => {
        if (error instanceof RequestError && [404, 409].includes(error.status))
          abort.abort("lease no longer owned");
      });
    const line = (channel: LogChannel) => (message: string) => {
      void send("log", { channel, message });
    };
    return {
      runId: task.runId,
      stepKey: task.stepKey,
      stepId: task.id,
      ...(task.uses ? { uses: task.uses } : {}),
      ...(task.script ? { script: task.script } : {}),
      idempotencyKey: task.idempotencyKey,
      attempt: task.attempt,
      input: task.input,
      signal: abort.signal,
      logger: {
        info: line("info"),
        warn: line("warn"),
        error: line("error"),
        raw: (channel, message) => line(channel)(message),
      },
      secrets: this.options.secrets,
      // The broker's lease is renewed on our own timer below; an executor
      // calling this simply renews it sooner.
      heartbeat: () => {
        void send("heartbeat", {});
      },
      ...(task.deadlineAt !== null || task.provider !== null
        ? {
            resources: {
              reservationId: task.id,
              deadlineAt: task.deadlineAt ?? Date.now() + 3_600_000,
              ...(task.provider ? { provider: task.provider } : {}),
            },
          }
        : {}),
      ...(task.checkpoint !== null ? { checkpoint: task.checkpoint } : {}),
      setCheckpoint: async (value: unknown) => {
        await send("checkpoint", { value });
      },
    };
  }

  private async execute(claim: Claim) {
    const { task } = claim;
    const executor = this.options.executors.get(task.runtime);
    const abort = new AbortController();
    this.current = abort;
    // Three beats inside the lease: one lost request must not cost the task.
    const interval = Math.max(
      250,
      Math.min(this.options.heartbeatMs, Math.floor(claim.leaseMs / 3)),
    );
    const heartbeat = setInterval(() => {
      void this.post(`/api/tasks/${task.id}/heartbeat`, {
        workerId: this.options.id,
        generation: task.generation,
      })
        .then((result) => {
          if ((result as { cancelRequested?: boolean }).cancelRequested)
            abort.abort("cancelled by the engine");
        })
        .catch((error) => {
          if (error instanceof RequestError && [404, 409].includes(error.status))
            abort.abort("lease no longer owned");
        });
    }, interval);

    try {
      let body: Record<string, unknown>;
      try {
        if (!executor)
          throw new Error(`worker has no executor for runtime '${task.runtime}'`);
        const result = await executor.run(this.context(claim, abort));
        body = {
          workerId: this.options.id,
          generation: task.generation,
          ok: true,
          value: result.value ?? null,
          ...(result.usage ? { usage: result.usage as Usage } : {}),
        };
      } catch (error) {
        if (abort.signal.aborted && !this.stopping) {
          // The engine cancelled, or the lease moved. Neither is this worker's
          // result to report: leave the task to the broker's own bookkeeping.
          this.log(`[${this.options.id}] ${task.id} aborted`);
          return;
        }
        const message = String(
          error instanceof Error ? error.message : error,
        ).slice(0, 8000);
        body = {
          workerId: this.options.id,
          generation: task.generation,
          ok: false,
          error: message,
          // A missing executor is a routing mistake, not a flaky step: another
          // attempt on this worker would fail identically.
          ...(executor ? {} : { fatal: true }),
        };
      }
      await this.spoolCompletion(task.id, body);
      this.log(
        `[${this.options.id}] ${task.id} ${body.ok ? "succeeded" : "failed"}`,
      );
    } finally {
      clearInterval(heartbeat);
      this.current = undefined;
    }
  }

  async start() {
    await mkdir(this.options.spool, { recursive: true });
    const runtimes = [...this.options.executors.keys()];
    this.log(
      `[${this.options.id}] runtimes ${runtimes.join(", ") || "(none)"} -> ${this.options.broker}`,
    );
    while (!this.stopping) {
      try {
        await this.post("/api/workers/register", {
          id: this.options.id,
          name: this.options.name,
          host: this.options.host,
          runtimes,
          labels: this.options.labels ?? {},
        });
        await this.flush();
        const claim = (await this.post(
          `/api/workers/${encodeURIComponent(this.options.id)}/claim`,
          {},
        )) as Claim | null;
        if (!claim) {
          await Bun.sleep(this.options.idleMs);
          continue;
        }
        this.log(
          `[${this.options.id}] claimed ${claim.task.id} (${claim.task.runtime}, attempt ${claim.task.attempt})`,
        );
        await this.execute(claim);
      } catch (error) {
        if (!this.stopping)
          this.log(
            `[${this.options.id}] ${error instanceof Error ? error.message : String(error)}`,
          );
        await Bun.sleep(1500);
      }
    }
  }
}
