import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleDashed,
  Clock,
  Cpu,
  Layers,
  Loader2,
  Server,
  XCircle,
} from "lucide-react";
import type {
  BusEvent,
  Snapshot,
  TaskSummary,
  Worker,
} from "../shared/protocol";

declare global {
  interface Window {
    __BUS_TOKEN?: string;
  }
}

const token = () =>
  window.__BUS_TOKEN ??
  new URLSearchParams(window.location.search).get("token") ??
  "";

async function read<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function relative(time: number, now: number) {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

const STATUS = {
  queued: { icon: CircleDashed, tone: "text-amber-600 bg-amber-50 border-amber-200" },
  running: { icon: Loader2, tone: "text-blue-700 bg-blue-50 border-blue-200" },
  succeeded: { icon: CheckCircle2, tone: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  failed: { icon: XCircle, tone: "text-red-700 bg-red-50 border-red-200" },
  cancelled: { icon: AlertTriangle, tone: "text-neutral-600 bg-muted border-border" },
} as const;

function Status({ status }: { status: TaskSummary["status"] }) {
  const meta = STATUS[status] ?? STATUS.cancelled;
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${meta.tone}`}
    >
      <Icon className={`size-3 ${status === "running" ? "animate-spin" : ""}`} />
      {status}
    </span>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Server;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-white px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-xs text-[var(--muted-text)]">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1.5 text-xl font-medium tabular-nums">{value}</div>
      {hint ? (
        <div className="mt-0.5 text-xs text-[var(--muted-text)]">{hint}</div>
      ) : null}
    </div>
  );
}

function WorkerRow({ worker, now }: { worker: Worker; now: number }) {
  const stale = now - worker.lastSeen > 30_000;
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-3.5 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`size-1.5 rounded-full ${
              worker.paused
                ? "bg-amber-500"
                : stale
                  ? "bg-neutral-300"
                  : "bg-emerald-500"
            }`}
          />
          <span className="truncate font-medium">{worker.id}</span>
          {worker.paused ? (
            <span className="rounded border border-amber-200 bg-amber-50 px-1.5 text-xs text-amber-700">
              paused
            </span>
          ) : null}
        </div>
        <div className="mt-1 truncate text-xs text-[var(--muted-text)]">
          {worker.host} · {worker.runtimes.join(", ")}
        </div>
        {Object.keys(worker.labels).length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {Object.entries(worker.labels).map(([key, value]) => (
              <span
                key={key}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
              >
                {key}={value}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-[var(--muted-text)]">
        {relative(worker.lastSeen, now)} ago
      </span>
    </div>
  );
}

function TaskRow({
  task,
  now,
  selected,
  onSelect,
}: {
  task: TaskSummary;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-2.5 text-left last:border-b-0 hover:bg-muted ${
        selected ? "bg-muted" : ""
      }`}
    >
      <Status status={task.status} />
      <span className="w-20 shrink-0 truncate font-mono text-xs text-[var(--muted-text)]">
        {task.runtime}
      </span>
      <span className="min-w-0 flex-1 truncate">{task.stepKey}</span>
      {task.attempt > 1 ? (
        <span className="shrink-0 text-xs text-amber-700">
          attempt {task.attempt}/{task.maxAttempts}
        </span>
      ) : null}
      <span className="w-24 shrink-0 truncate text-right text-xs text-[var(--muted-text)]">
        {task.workerId ?? "—"}
      </span>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-[var(--muted-text)]">
        {relative(task.updatedAt, now)}
      </span>
    </button>
  );
}

function TaskDetail({ task, events }: { task: TaskSummary; events: BusEvent[] }) {
  const mine = events.filter((event) => event.taskId === task.id);
  return (
    <div className="border-t border-border bg-muted/40 px-3.5 py-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
        {[
          ["run", task.runId],
          ["step", task.stepKey],
          ["idempotency key", task.idempotencyKey],
          ["generation", String(task.generation)],
          ["selector", JSON.stringify(task.selector)],
          [
            "lease",
            task.leaseUntil ? new Date(task.leaseUntil).toLocaleTimeString() : "—",
          ],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[var(--muted-text)]">{label}</dt>
            <dd className="truncate font-mono text-[11px]">{value}</dd>
          </div>
        ))}
      </dl>
      {task.error ? (
        <p className="mt-2.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-red-800">
          {task.error}
        </p>
      ) : null}
      {mine.length > 0 ? (
        <ul className="mt-2.5 space-y-1">
          {mine.slice(-12).map((event) => (
            <li key={event.id} className="flex gap-2 font-mono text-[11px]">
              <span className="shrink-0 text-[var(--muted-text)]">
                {new Date(event.time).toLocaleTimeString()}
              </span>
              <span className="shrink-0 text-[var(--blue)]">
                {event.type.replace("dev.agenticbus.", "").replace(".v1", "")}
              </span>
              <span className="truncate">
                {typeof event.data.message === "string"
                  ? event.data.message
                  : JSON.stringify(event.data)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "failed">("active");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await read<Snapshot>("/api/snapshot"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // SSE is a refresh signal, not a subscription: on any sequence change we
    // re-read the snapshot, which is the only thing that is authoritative.
    const source = new EventSource(`/api/events/stream?token=${token()}`);
    source.addEventListener("update", () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), 120);
    });
    source.onerror = () => {};
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      source.close();
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [refresh]);

  const tasks = useMemo(() => {
    if (!snapshot) return [];
    if (filter === "active")
      return snapshot.tasks.filter((task) =>
        ["queued", "running"].includes(task.status),
      );
    if (filter === "failed")
      return snapshot.tasks.filter((task) => task.status === "failed");
    return snapshot.tasks;
  }, [snapshot, filter]);

  const queued = snapshot
    ? Object.values(snapshot.queueDepth).reduce((sum, n) => sum + n, 0)
    : 0;
  const running = snapshot
    ? snapshot.tasks.filter((task) => task.status === "running").length
    : 0;
  const live = snapshot
    ? snapshot.workers.filter(
        (worker) => !worker.paused && snapshot.now - worker.lastSeen < 30_000,
      ).length
    : 0;

  return (
    <div className="mx-auto max-w-6xl px-5 py-7">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <Boxes className="size-4" />
            AgenticBus
          </h1>
          <p className="mt-0.5 text-xs text-[var(--muted-text)]">
            Remote execution fleet. Runs and steps live in dagr; this is the
            machines underneath them.
          </p>
        </div>
        {error ? (
          <span className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs text-red-700">
            {error}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-[var(--muted-text)]">
            <Activity className="size-3.5" />
            live
          </span>
        )}
      </header>

      <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric icon={Server} label="Workers" value={live} hint={`${snapshot?.workers.length ?? 0} registered`} />
        <Metric icon={Layers} label="Queued" value={queued} />
        <Metric icon={Cpu} label="Running" value={running} />
        <Metric
          icon={Clock}
          label="Failed"
          value={snapshot?.tasks.filter((t) => t.status === "failed").length ?? 0}
          hint="recent window"
        />
      </section>

      <section className="mt-6 grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="overflow-hidden rounded-md border border-border bg-white">
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
            <h2 className="text-sm font-medium">Tasks</h2>
            <div className="flex gap-1">
              {(["active", "failed", "all"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setFilter(option)}
                  className={`rounded-md px-2 py-1 text-xs ${
                    filter === option
                      ? "bg-primary text-white"
                      : "text-[var(--muted-text)] hover:bg-muted"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          {tasks.length === 0 ? (
            <p className="px-3.5 py-8 text-center text-xs text-[var(--muted-text)]">
              Nothing here. Dispatch a step with <code>runtime: remote</code>.
            </p>
          ) : (
            tasks.map((task) => (
              <div key={task.id}>
                <TaskRow
                  task={task}
                  now={snapshot?.now ?? Date.now()}
                  selected={selected === task.id}
                  onSelect={() =>
                    setSelected(selected === task.id ? null : task.id)
                  }
                />
                {selected === task.id ? (
                  <TaskDetail task={task} events={snapshot?.events ?? []} />
                ) : null}
              </div>
            ))
          )}
        </div>

        <div className="overflow-hidden rounded-md border border-border bg-white">
          <h2 className="border-b border-border px-3.5 py-2.5 text-sm font-medium">
            Workers
          </h2>
          {snapshot && snapshot.workers.length > 0 ? (
            snapshot.workers.map((worker) => (
              <WorkerRow key={worker.id} worker={worker} now={snapshot.now} />
            ))
          ) : (
            <p className="px-3.5 py-8 text-center text-xs text-[var(--muted-text)]">
              No worker has registered.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
