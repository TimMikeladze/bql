import type {
  Executor,
  ExecutorCapabilities,
  ExecutorResult,
  StepContext,
} from "dagr";
import type { Labels, Task, Usage } from "../shared/protocol";
import { isTerminal } from "../shared/protocol";

export interface RemoteExecutorOptions {
  /** Runtime name this executor answers to in workflow definitions. */
  runtime?: string;
  /** Broker base URL, e.g. `https://bus.internal`. */
  broker: string;
  /** Admin token: dispatching and cancelling are engine-side operations. */
  token: string;
  /**
   * Declares this executor's steps as agent-class, so they spend the root run's
   * agent allowance. Static per executor, which is why remoted agent work gets
   * its own registration rather than sharing the portable one.
   */
  agentClass?: boolean;
  providerUnit?: string;
  /** Selector merged under every step's own `select`. */
  defaultSelector?: Labels;
  /** Broker-side attempts before the task is failed back to dagr. */
  maxAttempts?: number;
  /** First poll delay. It backs off to `maxPollMs` while the step is running. */
  pollMs?: number;
  maxPollMs?: number;
  fetchImpl?: typeof fetch;
}

/** `with:` shape for a remote step. */
interface RemoteInput {
  run: string;
  select?: Labels;
  input?: unknown;
  uses?: string;
  script?: string;
  maxAttempts?: number;
}

export class RemoteStepError extends Error {
  constructor(
    message: string,
    readonly taskId: string,
  ) {
    super(message);
    this.name = "RemoteStepError";
  }
}

function parseInput(value: unknown): RemoteInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("a remote step needs an object `with`");
  const input = value as Record<string, unknown>;
  const run = input.run;
  if (typeof run !== "string" || run.length === 0)
    throw new Error("a remote step needs `with.run` naming the inner runtime");
  if (run === "remote")
    throw new Error("a remote step cannot dispatch to itself");
  return {
    run,
    select: (input.select ?? {}) as Labels,
    input: input.input ?? {},
    uses: typeof input.uses === "string" ? input.uses : undefined,
    script: typeof input.script === "string" ? input.script : undefined,
    maxAttempts:
      typeof input.maxAttempts === "number" ? input.maxAttempts : undefined,
  };
}

/**
 * A dagr executor that runs its step on another machine.
 *
 * The engine keeps the graph, the journal and the single writer; only the
 * handler moves. Three properties make that safe:
 *
 * 1. **Dispatch is idempotent** on dagr's `idempotencyKey` (`runId:stepKey`), so
 *    a re-dispatched step reattaches to remote work instead of duplicating it.
 * 2. **The task id is checkpointed before the wait begins**, so an engine that
 *    dies mid-step resumes waiting on a remote process that never stopped —
 *    the same trick dagr's agent runtime uses for session ids.
 * 3. **Waiting costs no lease work here**: dagr's worker loop renews the step
 *    lease on its own timer while `run()` is pending.
 */
export function remoteExecutor(options: RemoteExecutorOptions): Executor {
  const base = options.broker.replace(/\/$/, "");
  const pollMs = options.pollMs ?? 250;
  const maxPollMs = options.maxPollMs ?? 2000;
  const doFetch = options.fetchImpl ?? fetch;
  const capabilities: ExecutorCapabilities = options.agentClass
    ? {
        consumesAgentResources: true,
        resource: options.providerUnit
          ? {
              class: "provider",
              providerUnit: options.providerUnit,
              enforceProviderUnits: true,
            }
          : { class: "portable", enforceProviderUnits: false },
      }
    : {
        consumesAgentResources: false,
        resource: { class: "portable", enforceProviderUnits: false },
      };

  const call = async (path: string, body?: unknown) => {
    const response = await doFetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `broker ${path} failed: HTTP ${response.status} ${
          (payload as { error?: string }).error ?? ""
        }`.trim(),
      );
    return payload;
  };

  return {
    runtime: options.runtime ?? "remote",
    capabilities,
    async run(ctx: StepContext): Promise<ExecutorResult> {
      const spec = parseInput(ctx.input);
      const checkpoint = ctx.checkpoint as { taskId?: string } | undefined;

      let task: Task;
      if (checkpoint?.taskId) {
        // A reclaimed attempt: the remote step may still be running.
        task = (await call(`/api/tasks/${checkpoint.taskId}`)) as Task;
        ctx.logger.info(`reattached to remote task ${task.id} (${task.status})`);
      } else {
        task = (await call("/api/tasks", {
          idempotencyKey: ctx.idempotencyKey,
          runtime: spec.run,
          selector: { ...(options.defaultSelector ?? {}), ...(spec.select ?? {}) },
          input: spec.input,
          uses: spec.uses ?? ctx.uses,
          script: spec.script ?? ctx.script,
          runId: ctx.runId,
          stepKey: ctx.stepKey,
          attempt: ctx.attempt,
          maxAttempts: spec.maxAttempts ?? options.maxAttempts ?? 3,
          deadlineAt: ctx.resources?.deadlineAt ?? null,
          provider: ctx.resources?.provider ?? null,
          workspace: "default",
        })) as Task;
        await ctx.setCheckpoint?.({ taskId: task.id });
        ctx.logger.info(`dispatched remote task ${task.id} to '${spec.run}'`);
      }

      const onAbort = () => {
        void call(`/api/tasks/${task.id}/cancel`, {
          reason: "engine cancelled the step",
        }).catch(() => {});
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });

      try {
        let reported: string | null = null;
        // Quick at first — most steps are short — then backing off, because a
        // four-hour agent step should not cost four hours of polling.
        let delay = pollMs;
        while (!isTerminal(task.status)) {
          await sleep(delay, ctx.signal);
          delay = Math.min(maxPollMs, Math.round(delay * 1.5));
          ctx.signal.throwIfAborted();
          task = (await call(`/api/tasks/${task.id}`)) as Task;
          if (task.workerId && task.workerId !== reported) {
            reported = task.workerId;
            ctx.logger.info(
              `remote task ${task.id} claimed by ${task.workerId} (attempt ${task.attempt})`,
            );
          }
        }
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }

      const usage = (task.usage ?? undefined) as Usage | undefined;
      if (task.status === "succeeded")
        return usage ? { value: task.value, usage } : { value: task.value };
      throw new RemoteStepError(
        task.error ?? `remote task ${task.status}`,
        task.id,
      );
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
