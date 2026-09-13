import {
  agentExecutor,
  bunExecutor,
  claudeProviderAdapter,
  httpExecutor,
  promptExecutor,
  pythonExecutor,
  shellExecutor,
  type Executor,
  type SecretResolver,
} from "dagr";

/**
 * The remote worker hosts dagr's own executors.
 *
 * This is what makes "supports every dagr step" a structural claim rather than
 * a parity chase: a remoted `bun` step runs the same `bunExecutor` it would
 * have run in-process, with the same allowlists and the same subprocess
 * discipline. The only difference is which machine it is on.
 *
 * Registration is default-deny, exactly as dagr's is. A worker reaches nothing
 * until its operator says what it may reach.
 */
export interface RuntimeOptions {
  /** `shell`: commands the worker may execute. */
  shellAllow?: string[];
  /** `http`: hostnames the worker may reach. */
  httpAllow?: string[];
  /** `bun`/`python`: directory handlers are resolved inside. */
  jobsDir?: string;
  /** `agent`: working directory, and the roots a step may choose within. */
  agentCwd?: string;
  agentCwdAllowlist?: string[];
  agentPermissionModes?: string[];
  agentModelAllowlist?: string[];
  agentAppendSystemPrompt?: string;
  /** `prompt`: model the prompt runtime calls. */
  promptModel?: string;
  /** Environment variables a subprocess runtime may inherit. */
  envAllowlist?: string[];
}

const DEFAULT_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR"];

export function buildExecutors(
  runtimes: string[],
  options: RuntimeOptions,
): Map<string, Executor> {
  const envAllowlist = options.envAllowlist ?? DEFAULT_ENV;
  const built = new Map<string, Executor>();
  for (const runtime of runtimes) {
    switch (runtime) {
      case "shell":
        built.set(
          runtime,
          shellExecutor({
            commandAllowlist: options.shellAllow ?? [],
            envAllowlist,
          }),
        );
        break;
      case "http":
        built.set(runtime, httpExecutor({ allowlist: options.httpAllow ?? [] }));
        break;
      case "bun":
        built.set(
          runtime,
          bunExecutor({ cwd: options.jobsDir ?? "./jobs", envAllowlist }),
        );
        break;
      case "python":
        built.set(
          runtime,
          pythonExecutor({ cwd: options.jobsDir ?? "./jobs", envAllowlist }),
        );
        break;
      case "agent":
        built.set(
          runtime,
          agentExecutor({
            provider: claudeProviderAdapter(),
            cwd: options.agentCwd ?? "./work",
            cwdAllowlist: options.agentCwdAllowlist ?? [
              options.agentCwd ?? "./work",
            ],
            envAllowlist,
            ...(options.agentPermissionModes
              ? { permissionModes: options.agentPermissionModes as never }
              : {}),
            ...(options.agentModelAllowlist
              ? { modelAllowlist: options.agentModelAllowlist }
              : {}),
            ...(options.agentAppendSystemPrompt
              ? { appendSystemPrompt: options.agentAppendSystemPrompt }
              : {}),
          }),
        );
        break;
      case "prompt":
        built.set(
          runtime,
          promptExecutor({
            ...(options.promptModel ? { defaultModel: options.promptModel } : {}),
          }),
        );
        break;
      default:
        throw new Error(
          `unknown runtime '${runtime}'. Known: shell, http, bun, python, agent, prompt`,
        );
    }
  }
  return built;
}

/**
 * Secrets resolve on the worker, from an explicit allowlist.
 *
 * A remote step's resolved `with` crosses the network, so `${{ secrets.X }}`
 * written into a definition's `with` would ship the value from the engine. The
 * pattern that keeps a secret on one machine is to leave it out of `with` and
 * let the runtime read it here instead.
 */
export function workerSecrets(allowed: string[]): SecretResolver {
  const set = new Set(allowed);
  return { get: (name) => (set.has(name) ? process.env[name] : undefined) };
}
