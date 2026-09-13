import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Inbox,
  Layers,
  Loader2,
  Radio,
  Server,
  Skull,
} from "lucide-react";
import type {
  Delivery,
  Message,
  Stats,
  SubscriptionStats,
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
  pending: { icon: CircleDashed, tone: "text-amber-600 bg-amber-50 border-amber-200" },
  leased: { icon: Loader2, tone: "text-blue-700 bg-blue-50 border-blue-200" },
  acked: { icon: CheckCircle2, tone: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  dead: { icon: Skull, tone: "text-red-700 bg-red-50 border-red-200" },
  cancelled: { icon: Ban, tone: "text-neutral-600 bg-neutral-100 border-neutral-300" },
} as const;

function Status({ status }: { status: Delivery["status"] }) {
  const meta = STATUS[status] ?? STATUS.pending;
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${meta.tone}`}
    >
      <Icon className={`size-3 ${status === "leased" ? "animate-spin" : ""}`} />
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

function SubscriptionRow({ subscription }: { subscription: SubscriptionStats }) {
  const bars: [string, number, string][] = [
    ["pending", subscription.pending, "bg-amber-500"],
    ["leased", subscription.leased, "bg-blue-500"],
    ["dead", subscription.dead, "bg-red-500"],
  ];
  const total = Math.max(1, bars.reduce((sum, [, n]) => sum + n, 0));
  return (
    <div className="border-b border-border px-3.5 py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="font-medium">{subscription.name}</span>
          <span className="ml-2 font-mono text-xs text-[var(--muted-text)]">
            {subscription.pattern}
          </span>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-[var(--muted-text)]">
          lag {subscription.lag}
        </span>
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
        {bars.map(([name, n, tone]) =>
          n > 0 ? (
            <div
              key={name}
              className={tone}
              style={{ width: `${(n / total) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="mt-1.5 flex gap-3 text-xs text-[var(--muted-text)]">
        {bars.map(([name, n]) => (
          <span key={name}>
            {name} <span className="tabular-nums text-[var(--text)]">{n}</span>
          </span>
        ))}
        {subscription.ordered ? <span>ordered</span> : null}
        {subscription.paused ? (
          <span className="text-amber-700">paused</span>
        ) : null}
      </div>
    </div>
  );
}

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [log, setLog] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"log" | "deliveries">("log");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [nextStats, nextDeliveries, nextLog] = await Promise.all([
        read<Stats>("/api/stats"),
        read<Delivery[]>("/api/deliveries"),
        read<Message[]>("/api/log?after=0&limit=60"),
      ]);
      setStats(nextStats);
      setDeliveries(nextDeliveries);
      setLog(nextLog.reverse());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // SSE is a refresh signal, not a subscription: when the sequence moves we
    // re-read, because the read is the only thing that is authoritative.
    const source = new EventSource(`/api/stream?token=${token()}`);
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

  const totals = useMemo(() => {
    const subscriptions = stats?.subscriptions ?? [];
    return {
      pending: subscriptions.reduce((sum, s) => sum + s.pending, 0),
      leased: subscriptions.reduce((sum, s) => sum + s.leased, 0),
      dead: subscriptions.reduce((sum, s) => sum + s.dead, 0),
    };
  }, [stats]);

  const live = stats
    ? stats.consumers.filter((c) => !c.paused && stats.now - c.lastSeen < 30_000)
        .length
    : 0;

  return (
    <div className="mx-auto max-w-6xl px-5 py-7">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <Radio className="size-4" />
            AgenticBus
          </h1>
          <p className="mt-0.5 text-xs text-[var(--muted-text)]">
            Subjects, durable subscriptions, leases. Agents and ordinary work,
            same bus.
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
        <Metric
          icon={Layers}
          label="Messages"
          value={stats?.messages ?? 0}
          hint={`seq ${stats?.lastSeq ?? 0}`}
        />
        <Metric icon={Inbox} label="Pending" value={totals.pending} hint={`${totals.leased} in flight`} />
        <Metric
          icon={Server}
          label="Consumers"
          value={live}
          hint={`${stats?.consumers.length ?? 0} registered`}
        />
        <Metric icon={AlertTriangle} label="Dead" value={totals.dead} />
      </section>

      <section className="mt-6 grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="overflow-hidden rounded-md border border-border bg-white">
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
            <h2 className="text-sm font-medium">
              {tab === "log" ? "Log" : "Deliveries"}
            </h2>
            <div className="flex gap-1">
              {(["log", "deliveries"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setTab(option)}
                  className={`rounded-md px-2 py-1 text-xs ${
                    tab === option
                      ? "bg-primary text-white"
                      : "text-[var(--muted-text)] hover:bg-muted"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          {tab === "log" ? (
            log.length === 0 ? (
              <p className="px-3.5 py-8 text-center text-xs text-[var(--muted-text)]">
                Nothing published yet.
              </p>
            ) : (
              log.map((message) => (
                <div
                  key={message.id}
                  className="flex items-baseline gap-3 border-b border-border px-3.5 py-2 last:border-b-0"
                >
                  <span className="w-12 shrink-0 text-right font-mono text-[11px] text-[var(--muted-text)]">
                    {message.seq}
                  </span>
                  <span className="w-52 shrink-0 truncate font-mono text-xs text-[var(--blue)]">
                    {message.subject}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                    {JSON.stringify(message.body)}
                  </span>
                  {message.key ? (
                    <span className="shrink-0 rounded border border-border bg-muted px-1.5 font-mono text-[11px]">
                      {message.key}
                    </span>
                  ) : null}
                </div>
              ))
            )
          ) : deliveries.length === 0 ? (
            <p className="px-3.5 py-8 text-center text-xs text-[var(--muted-text)]">
              No deliveries yet.
            </p>
          ) : (
            deliveries.slice(0, 40).map((delivery) => (
              <div
                key={delivery.id}
                className="flex items-center gap-3 border-b border-border px-3.5 py-2 last:border-b-0"
              >
                <Status status={delivery.status} />
                <span className="w-28 shrink-0 truncate text-xs">
                  {delivery.subscription}
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-[11px] text-[var(--muted-text)]">
                  #{delivery.messageSeq}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted-text)]">
                  {delivery.error ?? delivery.key ?? ""}
                </span>
                {delivery.attempt > 1 ? (
                  <span className="shrink-0 text-xs text-amber-700">
                    attempt {delivery.attempt}/{delivery.maxAttempts}
                  </span>
                ) : null}
                <span className="w-24 shrink-0 truncate text-right text-xs text-[var(--muted-text)]">
                  {delivery.consumerId ?? "—"}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="space-y-5">
          <div className="overflow-hidden rounded-md border border-border bg-white">
            <h2 className="border-b border-border px-3.5 py-2.5 text-sm font-medium">
              Subscriptions
            </h2>
            {stats && stats.subscriptions.length > 0 ? (
              stats.subscriptions.map((subscription) => (
                <SubscriptionRow
                  key={subscription.id}
                  subscription={subscription}
                />
              ))
            ) : (
              <p className="px-3.5 py-8 text-center text-xs text-[var(--muted-text)]">
                No subscriptions.
              </p>
            )}
          </div>

          <div className="overflow-hidden rounded-md border border-border bg-white">
            <h2 className="border-b border-border px-3.5 py-2.5 text-sm font-medium">
              Consumers
            </h2>
            {stats && stats.consumers.length > 0 ? (
              stats.consumers.map((consumer) => (
                <div
                  key={consumer.id}
                  className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`size-1.5 rounded-full ${
                          consumer.paused
                            ? "bg-amber-500"
                            : stats.now - consumer.lastSeen > 30_000
                              ? "bg-neutral-300"
                              : "bg-emerald-500"
                        }`}
                      />
                      <span className="truncate font-medium">{consumer.id}</span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-[var(--muted-text)]">
                      {consumer.subscriptions.join(", ")} · {consumer.host}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--muted-text)]">
                    {relative(consumer.lastSeen, stats.now)}
                  </span>
                </div>
              ))
            ) : (
              <p className="px-3.5 py-8 text-center text-xs text-[var(--muted-text)]">
                No consumers registered.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
