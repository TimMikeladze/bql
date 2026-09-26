import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Inbox,
  KeyRound,
  Layers,
  Loader2,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Server,
  Skull,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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

/**
 * Operator actions use a token the page is *given*, never the one it was
 * served with.
 *
 * The injected token is deliberately read-only — a page that can be opened is
 * not a page that can dispatch work — so pausing, replaying, purging and
 * requeueing ask for an admin token and keep it in `sessionStorage`, which
 * dies with the tab. The alternative, a fourth "operator" scope, would add a
 * permission axis to every route to save one paste.
 */
const OPERATOR_KEY = "bql-bus.operator";

function useOperator() {
  const [operator, setOperator] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(OPERATOR_KEY);
    } catch {
      return null;
    }
  });
  const save = useCallback((value: string | null) => {
    try {
      if (value) sessionStorage.setItem(OPERATOR_KEY, value);
      else sessionStorage.removeItem(OPERATOR_KEY);
    } catch {}
    setOperator(value);
  }, []);
  return { operator, save };
}

async function act(path: string, operator: string, body: unknown = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${operator}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function relative(time: number, now: number) {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** A duration, in the same units `relative` uses, so the two read alike. */
function formatAge(ms: number) {
  return relative(0, ms);
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

function OperatorBar({
  operator,
  save,
}: {
  operator: string | null;
  save: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  if (operator)
    return (
      <span className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
          <KeyRound className="size-3" />
          operator
        </span>
        <Button variant="ghost" size="sm" onClick={() => save(null)}>
          forget
        </Button>
      </span>
    );
  if (!open)
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <KeyRound />
        Operator actions
      </Button>
    );
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim()) save(draft.trim());
        setDraft("");
        setOpen(false);
      }}
    >
      <input
        autoFocus
        type="password"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="admin token"
        className="h-8 w-56 rounded-md border border-border px-2 text-xs outline-none focus:border-[var(--blue)]"
      />
      <Button size="sm" type="submit">
        Use
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

function SubscriptionRow({
  subscription,
  operator,
  onAction,
}: {
  subscription: SubscriptionStats;
  operator: string | null;
  onAction: (label: string, run: () => Promise<unknown>) => void;
}) {
  const bars: [string, number, string][] = [
    ["pending", subscription.pending, "bg-amber-500"],
    ["leased", subscription.leased, "bg-blue-500"],
    ["dead", subscription.dead, "bg-red-500"],
    ["cancelled", subscription.cancelled, "bg-neutral-400"],
  ];
  const total = Math.max(1, bars.reduce((sum, [, n]) => sum + n, 0));
  const base = `/api/subscriptions/${encodeURIComponent(subscription.name)}`;
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
          {/* Age of the oldest thing still waiting, beside the depth. Depth
              says how much is queued; age says how long the front of the queue
              has been there, which is the number a person cares about. */}
          {subscription.oldestPendingAgeMs > 0 ? (
            <span className="mr-2">
              oldest {formatAge(subscription.oldestPendingAgeMs)}
            </span>
          ) : null}
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
        {/* A subscription the bus paused for a dead-letter storm is a
            different fact from one an operator paused, and reads differently
            at 03:00. */}
        {subscription.quarantinedAt !== null ? (
          <span className="text-red-700">quarantined</span>
        ) : subscription.paused ? (
          <span className="text-amber-700">paused</span>
        ) : null}
      </div>
      {operator ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onAction(
                `${subscription.paused ? "resumed" : "paused"} ${subscription.name}`,
                () =>
                  act(`${base}/pause`, operator, {
                    paused: !subscription.paused,
                  }),
              )
            }
          >
            {subscription.paused ? <Play /> : <Pause />}
            {subscription.paused ? "Resume" : "Pause"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const from = window.prompt(
                `Replay '${subscription.name}' from which sequence number? Messages already settled are not delivered again — purge first for that.`,
                "0",
              );
              if (from === null) return;
              onAction(`replayed ${subscription.name} from ${from}`, () =>
                act(`${base}/replay`, operator, { fromSeq: Number(from) || 0 }),
              );
            }}
          >
            <RotateCcw />
            Replay
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (
                !window.confirm(
                  `Drop every settled delivery on '${subscription.name}'? A later replay will then deliver those messages again.`,
                )
              )
                return;
              onAction(`purged ${subscription.name}`, () =>
                act(`${base}/purge`, operator, { fromSeq: 0 }),
              );
            }}
          >
            <Trash2 />
            Purge
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type Tab = "log" | "deliveries" | "dead";

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [log, setLog] = useState<Message[]>([]);
  const [dead, setDead] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("log");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Read inside `refresh` so switching tabs does not tear down the SSE
  // connection just to change what the next poll fetches.
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;
  const { operator, save } = useOperator();

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
      if (tabRef.current === "dead") {
        // A dead-letter queue is an ordinary subject, so this is a filtered
        // log read — one per distinct DLQ subject, only while the tab is open.
        const subjects = [
          ...new Set(nextStats.subscriptions.map((s) => s.dlqSubject)),
        ];
        const pages = await Promise.all(
          subjects.map((subject) =>
            read<Message[]>(
              `/api/log?after=0&limit=25&newest=true&subject=${encodeURIComponent(subject)}`,
            ).catch(() => [] as Message[]),
          ),
        );
        setDead(pages.flat().sort((a, b) => b.seq - a.seq).slice(0, 50));
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const onAction = useCallback(
    (label: string, run: () => Promise<unknown>) => {
      void run()
        .then(() => {
          setNotice(label);
          setTimeout(() => setNotice(null), 4000);
          return refresh();
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [refresh],
  );

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

  useEffect(() => {
    void refresh();
  }, [tab, refresh]);

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
            bql.sh/bus
          </h1>
          <p className="mt-0.5 text-xs text-[var(--muted-text)]">
            Subjects, durable subscriptions, leases. Agents and ordinary work,
            same bus.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {notice ? (
            <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
              {notice}
            </span>
          ) : null}
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
          <OperatorBar operator={operator} save={save} />
        </div>
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
              {tab === "log"
                ? "Log"
                : tab === "deliveries"
                  ? "Deliveries"
                  : "Dead letters"}
            </h2>
            <div className="flex gap-1">
              {(
                [
                  ["log", "log"],
                  ["deliveries", "deliveries"],
                  ["dead", "dead letters"],
                ] as const
              ).map(([option, label]) => (
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
                  {label}
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
                  {message.cancelledAt ? (
                    <span className="shrink-0 rounded border border-neutral-300 bg-neutral-100 px-1.5 text-[11px] text-neutral-600">
                      cancelled
                    </span>
                  ) : null}
                  {message.key ? (
                    <span className="shrink-0 rounded border border-border bg-muted px-1.5 font-mono text-[11px]">
                      {message.key}
                    </span>
                  ) : null}
                </div>
              ))
            )
          ) : tab === "deliveries" ? (
            deliveries.length === 0 ? (
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
            )
          ) : dead.length === 0 ? (
            <p className="px-3.5 py-8 text-center text-xs text-[var(--muted-text)]">
              No dead letters. A message that exhausts its attempts is
              republished onto its subscription&rsquo;s dead-letter subject and
              shows up here.
            </p>
          ) : (
            dead.map((message) => (
              <div
                key={message.id}
                className="flex items-center gap-3 border-b border-border px-3.5 py-2 last:border-b-0"
              >
                <span className="w-12 shrink-0 text-right font-mono text-[11px] text-[var(--muted-text)]">
                  {message.seq}
                </span>
                <span className="w-44 shrink-0 truncate font-mono text-xs text-[var(--blue)]">
                  {message.headers["dlq-subject"] ?? message.subject}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-red-700"
                  title={message.headers["dlq-reason"]}
                >
                  {message.headers["dlq-reason"] ?? "no reason recorded"}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--muted-text)]">
                  {message.headers["dlq-subscription"]} ·{" "}
                  {message.headers["dlq-attempts"]} attempts
                </span>
                {operator ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onAction(`requeued ${message.seq}`, () =>
                        act(`/api/messages/${message.seq}/requeue`, operator),
                      )
                    }
                  >
                    <Undo2 />
                    Requeue
                  </Button>
                ) : null}
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
                  operator={operator}
                  onAction={onAction}
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
