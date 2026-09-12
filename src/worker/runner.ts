import { hostname } from "node:os";
import { mkdir, readdir, unlink, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { execute } from "./executors";
import type { Claim, Completion, Mode, Role } from "../shared/protocol";

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : (process.argv[i + 1] ?? fallback);
};
const role = flag("role", "creator") as Role,
  mode = flag("mode", "demo") as Mode;
if (
  !["creator", "reviewer", "tester"].includes(role) ||
  !["demo", "live"].includes(mode)
)
  throw new Error("Expected --role creator|reviewer|tester --mode demo|live");
const workerId = flag("id", `${hostname()}-${mode}-${role}`),
  base = process.env.BUS_URL ?? "http://127.0.0.1:4317";
const token = process.env.BUS_TOKEN;
if (!token) throw new Error("BUS_TOKEN is required");
const spool = resolve(
  process.env.BUS_SPOOL ?? ".prototype/outbox",
  workerId.replace(/[^a-zA-Z0-9_-]/g, "_"),
);
await mkdir(spool, { recursive: true });
let stopping = false;
let current: AbortController | undefined;
process.on("SIGTERM", () => {
  stopping = true;
  current?.abort("Worker shutting down");
});
process.on("SIGINT", () => {
  stopping = true;
  current?.abort("Worker shutting down");
});
class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function post(path: string, data: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(5000),
  });
  const json = await r.json();
  if (!r.ok) throw new RequestError(json.error ?? `HTTP ${r.status}`, r.status);
  return json;
}
async function flush() {
  for (const file of await readdir(spool)) {
    if (!file.endsWith(".json")) continue;
    const pending = await Bun.file(`${spool}/${file}`).json();
    try {
      await post(`/api/tasks/${pending.taskId}/complete`, pending.result);
      await unlink(`${spool}/${file}`);
    } catch (e) {
      if (e instanceof RequestError && [404, 409].includes(e.status)) {
        await unlink(`${spool}/${file}`);
        console.warn(
          `[${workerId}] completion fenced; authoritative state has moved on`,
        );
      } else throw e;
    }
  }
}

console.log(`[${workerId}] ${mode} ${role} connecting to ${base}`);
while (!stopping) {
  try {
    await post("/api/workers/register", {
      id: workerId,
      name:
        mode === "demo"
          ? {
              creator: "Artifact builder",
              reviewer: "Code reviewer",
              tester: "Bun test runner",
            }[role]
          : {
              creator: "Claude Code",
              reviewer: "Codex CLI",
              tester: "Live artifact tests",
            }[role],
      role,
      mode,
      host: hostname(),
    });
    await flush();
    const claim: Claim | null = await post(
      `/api/workers/${encodeURIComponent(workerId)}/claim`,
      {},
    );
    if (!claim) {
      await Bun.sleep(1000);
      continue;
    }
    current = new AbortController();
    const abort = current;
    const heartbeat = setInterval(
      () =>
        post(`/api/tasks/${claim.task.id}/heartbeat`, {
          workerId,
          generation: claim.task.generation,
        }).catch((e) => {
          if (e instanceof RequestError && [404, 409].includes(e.status))
            abort.abort("Lease no longer owned");
        }),
      3000,
    );
    console.log(
      `[${workerId}] claimed ${claim.task.id} attempt ${claim.task.attempt}`,
    );
    try {
      let result: Completion;
      try {
        result = {
          generation: claim.task.generation,
          ...(await execute(
            claim,
            (type, data) =>
              post(`/api/tasks/${claim.task.id}/progress`, {
                workerId,
                generation: claim.task.generation,
                type,
                data,
              })
                .then(() => {})
                .catch((e) => {
                  if (
                    e instanceof RequestError &&
                    [404, 409].includes(e.status)
                  )
                    abort.abort("Lease no longer owned");
                  throw e;
                }),
            abort.signal,
            Number(process.env.DEMO_DELAY_MS ?? 1200),
          )),
        };
      } catch (e) {
        if (abort.signal.aborted) throw e;
        const error = String(e instanceof Error ? e.message : e).slice(0, 4000);
        result = {
          generation: claim.task.generation,
          ok: false,
          name: "error.txt",
          mediaType: "text/plain",
          content: error,
          error,
        };
      }
      if (!abort.signal.aborted) {
        const file = `${spool}/${claim.task.id}.json`;
        await Bun.write(
          `${file}.tmp`,
          JSON.stringify({
            taskId: claim.task.id,
            result: { ...result, workerId },
          }),
        );
        await rename(`${file}.tmp`, file);
        await flush();
      }
    } finally {
      clearInterval(heartbeat);
      current = undefined;
    }
  } catch (e) {
    if (!stopping)
      console.warn(
        `[${workerId}] ${e instanceof Error ? e.message : String(e)}`,
      );
    await Bun.sleep(1500);
  }
}
