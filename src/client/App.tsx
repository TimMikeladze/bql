import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Blocks,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  Code2,
  FileCode2,
  FileText,
  GitBranch,
  Inbox,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  Network,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  TestTube2,
  X,
  XCircle,
} from "lucide-react";
import {
  DEFAULT_BRIEF,
  type Artifact,
  type BusEvent,
  type Mode,
  type Role,
  type Run,
  type Snapshot,
  type Task,
} from "../shared/protocol";
import { Button } from "./components/ui/button";

type Section = "overview" | "journal" | "workers" | "artifacts";
const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "journal", label: "Event journal", icon: Activity },
  { id: "workers", label: "Workers", icon: Server },
  { id: "artifacts", label: "Artifacts", icon: FileCode2 },
] as const;
const labels: Record<string, string> = {
  running: "Running",
  waiting_approval: "Needs approval",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Waiting",
  queued: "Queued",
  online: "Online",
  offline: "Offline",
  paused: "Paused",
};
const roleMeta = {
  creator: { name: "Create artifact", icon: Code2 },
  reviewer: { name: "Review code", icon: ShieldCheck },
  tester: { name: "Run tests", icon: TestTube2 },
};
function relative(time: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
function clock(time: string | number) {
  return new Date(time).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
function modeLabel(mode: Mode) {
  return mode === "demo" ? "Scripted demo" : "Live agents";
}
function shortId(id: string) {
  return id.slice(0, 8);
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status})`);
  return result as T;
}
function Status({ status }: { status: string }) {
  const Icon =
    status === "succeeded"
      ? CheckCircle2
      : status === "failed"
        ? XCircle
        : status === "running"
          ? LoaderCircle
          : status === "waiting_approval"
            ? ShieldCheck
            : status === "paused"
              ? Pause
              : Circle;
  return (
    <span className={`status status-${status}`}>
      <Icon className={status === "running" ? "spin" : undefined} />
      {labels[status] || status}
    </span>
  );
}
function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className={`modal ${wide ? "modal-wide" : ""}`}>
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon" aria-label="Close dialog" />
              }
            >
              <X />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function App() {
  const [section, setSection] = useState<Section>("overview");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const value = await api<Snapshot>("/api/snapshot");
      setSnapshot((previous) =>
        previous && previous.now > value.now ? previous : value,
      );
      setConnectionError("");
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : "Cannot reach coordinator",
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const stream = new EventSource("/api/events/stream");
    stream.onopen = () => {
      setConnected(true);
      void refresh();
    };
    stream.onerror = () => setConnected(false);
    stream.addEventListener("update", () => void refresh());
    const timer = window.setInterval(refresh, 10000);
    return () => {
      stream.close();
      window.clearInterval(timer);
    };
  }, [refresh]);
  const mutate = async (key: string, path: string, body: unknown = {}) => {
    if (pending) return false;
    setPending(key);
    setActionError("");
    try {
      const result = await api<Run | null>(path, body);
      if (key === "retry" && result?.id) setSelectedId(result.id);
      await refresh();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Action failed");
      return false;
    } finally {
      setPending(null);
    }
  };
  const runs = snapshot?.runs ?? [];
  const selected = runs.find((run) => run.id === selectedId) || runs[0];
  const busy = runs.filter((run) => run.status === "running").length;
  const approval = runs.filter(
    (run) => run.status === "waiting_approval",
  ).length;
  const online =
    snapshot?.workers.filter(
      (worker) => !worker.paused && snapshot.now - worker.lastSeen < 30000,
    ).length ?? 0;
  const goTo = (next: Section) => {
    setSection(next);
    setMobileNav(false);
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            goTo("overview");
          }}
        >
          <span className="brand-mark">
            <Network size={18} />
          </span>
          <span>
            agenticbus<span className="brand-tag">PROTOTYPE</span>
          </span>
        </a>
        <div className="workspace-select">
          <span className="workspace-icon">
            <Blocks size={15} />
          </span>
          <div>
            <strong>Local workspace</strong>
            <span>Development environment</span>
          </div>
          <span className="live-dot" />
        </div>
        <Button className="sidebar-cta" onClick={() => setNewRunOpen(true)}>
          <Plus />
          Run workflow
        </Button>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Workspace">
          {navigation.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => goTo(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={`nav-item ${section === item.id ? "active" : ""}`}
            >
              <item.icon size={16} />
              {item.label}
              {item.id === "overview" && approval > 0 && (
                <span className="nav-count">{approval}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <GitBranch size={17} />
            <strong>One workflow. Every handoff.</strong>
            <p>
              Create, review, test, and approve an artifact with a durable
              record.
            </p>
          </div>
          <div className="local-profile">
            <div className="avatar">L</div>
            <div>
              <strong>Local operator</strong>
              <span>Bun · SQLite coordinator</span>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-toggle"
              aria-label="Toggle navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu />
            </Button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {navigation.find((item) => item.id === section)?.label}
            </strong>
          </div>
          <div className="topbar-right">
            <span
              className={`connection ${connected && !connectionError ? "is-connected" : "is-offline"}`}
            >
              <span />
              {connected && !connectionError ? "Connected" : "Reconnecting"}
            </span>
            <span className="topbar-divider" />
            <span className="prototype-tag">Local prototype</span>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">AGENT COORDINATION</div>
              <h1>
                {section === "overview"
                  ? "Workflow overview"
                  : section === "journal"
                    ? "Event journal"
                    : section === "workers"
                      ? "Workers"
                      : "Artifact library"}
              </h1>
              <p>
                {section === "overview"
                  ? "A shared place for your agents to work, and for you to see what happened."
                  : section === "journal"
                    ? "Every handoff, decision, and result, in the order it was recorded."
                    : section === "workers"
                      ? "Independent runners, connected through the same durable bus."
                      : "The code and evidence your workflows leave behind."}
              </p>
            </div>
            <Button onClick={() => setNewRunOpen(true)}>
              <Plus />
              New run
            </Button>
          </div>
          {(connectionError || !connected) && (
            <div className="notice connection-notice" role="status">
              <Radio size={15} />
              <span>
                {connectionError
                  ? `Coordinator unavailable: ${connectionError}.`
                  : "Connecting to the event stream."}{" "}
                {snapshot
                  ? "Showing the last received state. Reconnecting automatically."
                  : "Make sure the local coordinator is running."}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refresh()}
              >
                <RefreshCw />
                Refresh
              </Button>
            </div>
          )}
          {actionError && (
            <div className="notice error-notice" role="alert">
              <XCircle size={16} />
              <span>{actionError}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Dismiss error"
                onClick={() => setActionError("")}
              >
                <X />
              </Button>
            </div>
          )}
          {!snapshot ? (
            <div className="loading-state">
              <LoaderCircle className="spin" size={20} />
              <span>Loading workspace…</span>
            </div>
          ) : (
            <>
              {section === "overview" && (
                <>
                  <div className="metrics">
                    <Metric
                      label="Workflow runs"
                      value={runs.length}
                      note="All recorded runs"
                      icon={<GitBranch />}
                    />
                    <Metric
                      label="In progress"
                      value={busy}
                      note="Work moving through the bus"
                      icon={<Activity />}
                    />
                    <Metric
                      label="Needs approval"
                      value={approval}
                      note="Ready for a human decision"
                      icon={<ShieldCheck />}
                      accent={approval > 0}
                    />
                    <Metric
                      label="Online workers"
                      value={online}
                      note={`${snapshot.workers.length} registered in this workspace`}
                      icon={<Server />}
                    />
                  </div>
                  <div className="overview-grid">
                    <section className="panel run-panel">
                      <div className="panel-heading">
                        <h2>
                          Workflow runs{" "}
                          <span className="count">{runs.length}</span>
                        </h2>
                        <span className="muted text-xs">Most recent first</span>
                      </div>
                      {runs.length === 0 ? (
                        <Empty
                          icon={<GitBranch />}
                          title="Your first handoff starts here"
                          action={
                            <Button
                              variant="outline"
                              onClick={() => setNewRunOpen(true)}
                            >
                              <Plus />
                              Create a run
                            </Button>
                          }
                        >
                          Give a creator a brief. Let a reviewer and a test
                          worker check the result.
                        </Empty>
                      ) : (
                        <div className="run-list">
                          {[...runs]
                            .sort((a, b) => b.createdAt - a.createdAt)
                            .map((run) => (
                              <button
                                key={run.id}
                                type="button"
                                className={`run-row ${selected?.id === run.id ? "selected" : ""}`}
                                onClick={() => setSelectedId(run.id)}
                                aria-pressed={selected?.id === run.id}
                              >
                                <div className="run-row-title">
                                  <span className="run-icon">
                                    <GitBranch size={15} />
                                  </span>
                                  <strong>{run.title}</strong>
                                  <ChevronRight size={14} />
                                </div>
                                <div className="run-row-meta">
                                  <Status status={run.status} />
                                  <time
                                    title={new Date(
                                      run.createdAt,
                                    ).toLocaleString()}
                                  >
                                    {relative(run.createdAt, snapshot.now)}
                                  </time>
                                </div>
                                <div className="run-row-mode">
                                  <span>{modeLabel(run.mode)}</span>
                                  <code>{shortId(run.id)}</code>
                                </div>
                              </button>
                            ))}
                        </div>
                      )}
                      <div className="panel-foot">
                        <span className="tiny-dot" />
                        Runs are persisted locally
                      </div>
                    </section>
                    {selected ? (
                      <RunDetail
                        run={selected}
                        snapshot={snapshot}
                        pending={pending}
                        mutate={mutate}
                        inspect={setArtifactId}
                      />
                    ) : (
                      <section className="panel intro-panel">
                        <div className="intro-illustration">
                          <div>
                            <Code2 />
                            <span>Create</span>
                          </div>
                          <ArrowRight />
                          <div>
                            <ShieldCheck />
                            <span>Review</span>
                          </div>
                          <ArrowRight />
                          <div>
                            <CheckCircle2 />
                            <span>Approve</span>
                          </div>
                        </div>
                        <span className="eyebrow">FROM BRIEF TO EVIDENCE</span>
                        <h2>
                          Let agents do the work.
                          <br />
                          Keep the whole picture.
                        </h2>
                        <p>
                          Start with a small, real workflow: create a TypeScript
                          utility, review its code, run executable tests, and
                          approve the exact artifact.
                        </p>
                        <div className="intro-points">
                          <span>
                            <Check size={14} />
                            Separate worker processes
                          </span>
                          <span>
                            <Check size={14} />A durable event journal
                          </span>
                          <span>
                            <Check size={14} />A human at the final step
                          </span>
                        </div>
                        <Button onClick={() => setNewRunOpen(true)}>
                          Run your first workflow
                          <ArrowRight />
                        </Button>
                      </section>
                    )}
                  </div>
                </>
              )}
              {section === "journal" && (
                <Journal events={snapshot.events} runs={runs} />
              )}
              {section === "workers" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      Registered workers{" "}
                      <span className="count">{snapshot.workers.length}</span>
                    </h2>
                    <span className="muted text-xs">
                      Heartbeat within 30 seconds = online
                    </span>
                  </div>
                  {snapshot.workers.length === 0 ? (
                    <Empty icon={<Server />} title="Waiting for workers">
                      Start the development stack to connect the creator,
                      reviewer, and test runners.
                    </Empty>
                  ) : (
                    <div className="worker-grid">
                      {snapshot.workers.map((worker) => {
                        const status =
                          snapshot.now - worker.lastSeen > 30000
                            ? "offline"
                            : worker.paused
                              ? "paused"
                              : "online";
                        const Icon = roleMeta[worker.role].icon;
                        const task = snapshot.tasks.find(
                          (task) =>
                            task.workerId === worker.id &&
                            task.status === "running",
                        );
                        return (
                          <article key={worker.id} className="worker-card">
                            <div className="worker-top">
                              <span className="worker-icon">
                                <Icon size={20} />
                              </span>
                              <Status status={status} />
                            </div>
                            <h3>{worker.name}</h3>
                            <div className="worker-subtitle">
                              {worker.role} <span>·</span>{" "}
                              {modeLabel(worker.mode)}
                            </div>
                            <dl>
                              <div>
                                <dt>Host</dt>
                                <dd>{worker.host}</dd>
                              </div>
                              <div>
                                <dt>Last heartbeat</dt>
                                <dd>
                                  {relative(worker.lastSeen, snapshot.now)}
                                </dd>
                              </div>
                              <div>
                                <dt>Current task</dt>
                                <dd>
                                  {task ? shortId(task.id) : "No active task"}
                                </dd>
                              </div>
                            </dl>
                            <Button
                              variant="outline"
                              disabled={!!pending}
                              onClick={() =>
                                void mutate(
                                  `worker-${worker.id}`,
                                  `/api/workers/${worker.id}/pause`,
                                  { paused: !worker.paused },
                                )
                              }
                            >
                              {pending === `worker-${worker.id}` ? (
                                <LoaderCircle className="spin" />
                              ) : worker.paused ? (
                                <Play />
                              ) : (
                                <Pause />
                              )}
                              {worker.paused
                                ? "Resume worker"
                                : "Pause new claims"}
                            </Button>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  <div className="panel-foot">
                    <CircleDot size={13} />
                    Pausing stops new claims. An active task can still finish.
                  </div>
                </section>
              )}
              {section === "artifacts" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      Artifacts{" "}
                      <span className="count">{snapshot.artifacts.length}</span>
                    </h2>
                    <span className="muted text-xs">
                      Evidence with verified digests
                    </span>
                  </div>
                  {snapshot.artifacts.length === 0 ? (
                    <Empty
                      icon={<FileCode2 />}
                      title="A home for work that is done"
                    >
                      Code, reviews, and test output will appear here as workers
                      finish their tasks.
                    </Empty>
                  ) : (
                    <div className="artifact-library">
                      {[...snapshot.artifacts].reverse().map((artifact) => (
                        <button
                          type="button"
                          key={artifact.id}
                          className="artifact-library-row"
                          onClick={() => setArtifactId(artifact.id)}
                        >
                          <span className="file-icon">
                            <FileCode2 size={18} />
                          </span>
                          <span>
                            <strong>{artifact.name}</strong>
                            <span className="muted">
                              {runs.find((run) => run.id === artifact.runId)
                                ?.title || shortId(artifact.runId)}
                            </span>
                          </span>
                          <code className="artifact-digest">
                            {artifact.digest.slice(0, 12)}
                          </code>
                          <span className="muted artifact-date">
                            {relative(artifact.createdAt, snapshot.now)}
                          </span>
                          <ArrowUpRight size={15} />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <Network size={13} />
              AgenticBus
            </span>
            <span>Durable handoffs. Inspectable evidence.</span>
          </footer>
        </main>
      </div>
      <NewRunModal
        open={newRunOpen}
        close={() => setNewRunOpen(false)}
        created={async (run) => {
          setSelectedId(run.id);
          setSection("overview");
          setNewRunOpen(false);
          await refresh();
        }}
      />
      <ArtifactModal id={artifactId} close={() => setArtifactId(null)} />
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon,
  accent,
}: {
  label: string;
  value: number;
  note: string;
  icon: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`metric ${accent ? "metric-accent" : ""}`}>
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <strong>{value.toString().padStart(2, "0")}</strong>
      <p>{note}</p>
    </div>
  );
}
function RunDetail({
  run,
  snapshot,
  pending,
  mutate,
  inspect,
}: {
  run: Run;
  snapshot: Snapshot;
  pending: string | null;
  mutate: (key: string, path: string, body?: unknown) => Promise<boolean>;
  inspect: (id: string) => void;
}) {
  const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
  const events = snapshot.events
    .filter((event) => event.runId === run.id)
    .slice(-8)
    .reverse();
  const artifacts = snapshot.artifacts.filter(
    (artifact) => artifact.runId === run.id,
  );
  const retryKeys = useRef<Record<string, string>>({});
  return (
    <section className="panel run-detail">
      <div className="detail-heading">
        <div className="detail-kicker">
          <code>{shortId(run.id)}</code>
          <span>·</span>
          <span>{modeLabel(run.mode)}</span>
        </div>
        <div className="detail-title">
          <h2>{run.title}</h2>
          <Status status={run.status} />
        </div>
        <p>{run.brief}</p>
      </div>
      <div className="detail-section">
        <div className="section-heading">
          <h3>Workflow</h3>
          <span className="muted text-xs">
            {tasks.filter((task) => task.status === "succeeded").length} of{" "}
            {tasks.length} tasks complete
          </span>
        </div>
        <div className="workflow" aria-label="Workflow progress">
          <WorkflowNode
            task={tasks.find((task) => task.role === "creator")}
            role="creator"
          />
          <div className="graph-branch" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="parallel-nodes">
            <WorkflowNode
              task={tasks.find((task) => task.role === "reviewer")}
              role="reviewer"
            />
            <WorkflowNode
              task={tasks.find((task) => task.role === "tester")}
              role="tester"
            />
          </div>
          <div className="graph-join" aria-hidden="true">
            <span />
            <span />
          </div>
          <div
            className={`workflow-node approval-node ${run.status === "succeeded" ? "node-succeeded" : run.status === "waiting_approval" ? "node-running" : ""}`}
          >
            <div className="node-top">
              <ShieldCheck size={16} />
              {run.status === "succeeded" && <CheckCircle2 size={13} />}
            </div>
            <strong>Human approval</strong>
            <span>
              {run.status === "succeeded"
                ? "Accepted"
                : run.status === "waiting_approval"
                  ? "Your decision"
                  : "Waiting for evidence"}
            </span>
          </div>
        </div>
      </div>
      {tasks.some((task) => task.error) && (
        <div className="task-errors">
          {tasks
            .filter((task) => task.error)
            .map((task) => (
              <div key={task.id} role="alert">
                <XCircle size={15} />
                <span>
                  <strong>{roleMeta[task.role].name}: </strong>
                  {task.error}
                </span>
              </div>
            ))}
        </div>
      )}
      {run.status === "waiting_approval" && (
        <div className="approval-callout">
          <div className="approval-callout-icon">
            <ShieldCheck size={19} />
          </div>
          <div>
            <h3>The evidence is in. Your call.</h3>
            <p>
              Review and tests passed for the same artifact. Inspect the
              results, then accept this version. Approval records your decision
              without publishing or merging.
            </p>
            <div className="action-row">
              <Button
                disabled={!!pending}
                onClick={() =>
                  void mutate("approve", `/api/runs/${run.id}/approve`)
                }
              >
                {pending === "approve" ? (
                  <LoaderCircle className="spin" />
                ) : (
                  <Check />
                )}
                Approve artifact
              </Button>
              <Button
                variant="outline"
                disabled={!!pending}
                onClick={() =>
                  void mutate("cancel", `/api/runs/${run.id}/cancel`)
                }
              >
                Reject run
              </Button>
            </div>
          </div>
        </div>
      )}
      {run.status === "succeeded" && (
        <div className="accepted-callout">
          <CheckCircle2 size={16} />
          <span>
            Artifact accepted. The decision and its evidence are recorded.
          </span>
        </div>
      )}
      <div className="detail-section">
        <div className="section-heading">
          <h3>Artifacts & evidence</h3>
          <span className="count">{artifacts.length}</span>
        </div>
        {artifacts.length ? (
          <div className="artifact-list">
            {artifacts.map((artifact) => (
              <button
                type="button"
                key={artifact.id}
                className="artifact-row"
                onClick={() => inspect(artifact.id)}
              >
                <FileCode2 size={16} />
                <span>
                  <strong>{artifact.name}</strong>
                  <small>{artifact.mediaType}</small>
                </span>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
        ) : (
          <p className="inline-empty">
            <Inbox size={15} />
            Artifacts appear here when workers complete their tasks.
          </p>
        )}
      </div>
      <div className="detail-section">
        <div className="section-heading">
          <h3>Activity</h3>
          <span className="muted text-xs">Latest {events.length} events</span>
        </div>
        <div className="timeline">
          {events.map((event) => (
            <div className="timeline-row" key={event.id}>
              <span
                className={`timeline-dot ${event.type.includes("failed") ? "timeline-failed" : ""}`}
              />
              <div>
                <strong>{humanEvent(event.type)}</strong>
                <span>{event.source}</span>
              </div>
              <time>{clock(event.time)}</time>
            </div>
          ))}
          {!events.length && (
            <p className="muted">
              No activity for this run in the recent event window.
            </p>
          )}
        </div>
      </div>
      {(run.status === "running" ||
        run.status === "failed" ||
        run.status === "cancelled") && (
        <div className="detail-actions">
          <span className="muted text-xs">
            Created {new Date(run.createdAt).toLocaleString()}
          </span>
          {run.status === "running" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!!pending}
              onClick={() =>
                void mutate("cancel", `/api/runs/${run.id}/cancel`)
              }
            >
              <X />
              Cancel run
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!!pending}
              onClick={() => {
                retryKeys.current[run.id] ??= crypto.randomUUID();
                void mutate("retry", `/api/runs/${run.id}/retry`, {
                  requestKey: retryKeys.current[run.id],
                }).then((succeeded) => {
                  if (succeeded) delete retryKeys.current[run.id];
                });
              }}
            >
              <RefreshCw />
              Retry as new run
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
function WorkflowNode({ task, role }: { task?: Task; role: Role }) {
  const { name, icon: Icon } = roleMeta[role];
  return (
    <div className={`workflow-node node-${task?.status || "blocked"}`}>
      <div className="node-top">
        <Icon size={16} />
        {task?.status === "succeeded" ? (
          <CheckCircle2 size={13} />
        ) : task?.status === "running" ? (
          <LoaderCircle className="spin" size={13} />
        ) : task?.status === "failed" ? (
          <XCircle size={13} />
        ) : null}
      </div>
      <strong>{name}</strong>
      <span>
        {labels[task?.status || "blocked"]}
        {task && task.attempt > 0 ? ` · attempt ${task.attempt}` : ""}
      </span>
    </div>
  );
}
function humanEvent(type: string) {
  const words = type
    .replace(/^(dev\.)?agenticbus\./, "")
    .replace(/\.v\d+$/, "")
    .replace(/[._-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function Journal({ events, runs }: { events: BusEvent[]; runs: Run[] }) {
  const [query, setQuery] = useState("");
  const filtered = [...events]
    .reverse()
    .filter((event) =>
      `${event.type} ${event.source} ${event.runId} ${JSON.stringify(event.data)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  return (
    <section className="panel">
      <div className="panel-heading journal-heading">
        <h2>
          Recorded events <span className="count">{events.length}</span>
        </h2>
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="Search events"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search events, sources, or run IDs…"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X size={13} />
            </button>
          )}
        </label>
      </div>
      {!filtered.length ? (
        <Empty
          icon={<Activity />}
          title={query ? "No matching events" : "The journal is ready"}
        >
          {query
            ? "Try another event name, source, or run ID."
            : "Start a workflow to see its handoffs and results arrive here."}
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="journal-table">
            <thead>
              <tr>
                <th>Sequence / time</th>
                <th>Event</th>
                <th>Run</th>
                <th>Source & payload</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => (
                <tr key={event.id}>
                  <td>
                    <code>#{event.seq.toString().padStart(4, "0")}</code>
                    <span className="muted">{clock(event.time)}</span>
                  </td>
                  <td>
                    <span className="event-type">
                      <span className="tiny-dot" />
                      {event.type}
                    </span>
                  </td>
                  <td>
                    {runs.find((run) => run.id === event.runId)?.title ||
                      (event.runId ? shortId(event.runId) : "Workspace")}
                  </td>
                  <td>
                    <details>
                      <summary>
                        {event.source}
                        <ChevronRight size={12} />
                      </summary>
                      <pre>{JSON.stringify(event.data, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-foot">
        <Radio size={13} />
        Live updates · latest {events.length} events in the workspace snapshot
      </div>
    </section>
  );
}
function NewRunModal({
  open,
  close,
  created,
}: {
  open: boolean;
  close: () => void;
  created: (run: Run) => Promise<void>;
}) {
  const [title, setTitle] = useState("Build a slugify utility");
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [mode, setMode] = useState<Mode>("demo");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ signature: string; key: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    // An unchanged submission retries the same operation after a lost response.
    // Editing the payload is explicit new intent; it gets a fresh request key.
    const payload = { title: title.trim(), brief: brief.trim(), mode };
    const signature = JSON.stringify(payload);
    if (request.current?.signature !== signature)
      request.current = { signature, key: crypto.randomUUID() };
    try {
      const run = await api<Run>("/api/runs", {
        ...payload,
        requestKey: request.current.key,
      });
      request.current = null;
      await created(run);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create run");
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        if (!value && !pending) close();
      }}
      title="Start a workflow"
      description="One brief. Three workers. A decision backed by evidence."
    >
      <form onSubmit={submit} className="run-form">
        <label>
          Run name
          <input
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Give this workflow a name"
          />
        </label>
        <fieldset>
          <legend>Execution mode</legend>
          <div className="mode-options">
            {(["demo", "live"] as const).map((value) => (
              <label
                className={`mode-option ${mode === value ? "mode-selected" : ""}`}
                key={value}
              >
                <input
                  type="radio"
                  name="mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span>
                  {value === "demo" ? (
                    <Play size={16} />
                  ) : (
                    <Terminal size={16} />
                  )}
                  <strong>{modeLabel(value)}</strong>
                  <small>
                    {value === "demo"
                      ? "Deterministic agents, real tests"
                      : "Claude creates, Codex reviews"}
                  </small>
                </span>
                {mode === value && <CheckCircle2 size={15} />}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mode-explanation">
          {mode === "demo"
            ? "No model calls. Scripted creator and reviewer produce inspectable artifacts; the test worker executes real Bun tests."
            : "Uses your installed, authenticated Claude and Codex CLIs. Live runs make model calls and consume provider usage. Live workers must be connected."}
        </div>
        <label>
          Brief
          <textarea
            required
            rows={5}
            maxLength={4000}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
        </label>
        <p className="form-help">
          This prototype builds a named TypeScript <code>slugify</code> export.
          You can add instructions while keeping that artifact contract.
        </p>
        <div className="form-workflow">
          <span>
            <Code2 size={13} />
            Create
          </span>
          <ArrowRight size={12} />
          <span>
            <ShieldCheck size={13} />
            Review + test
          </span>
          <ArrowRight size={12} />
          <span>
            <CheckCircle2 size={13} />
            Approve
          </span>
        </div>
        {error && (
          <div className="notice error-notice" role="alert">
            <XCircle size={15} />
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button
            variant="outline"
            disabled={pending}
            onClick={close}
            type="button"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={pending || !title.trim() || !brief.trim()}
          >
            {pending ? <LoaderCircle className="spin" /> : <Play />}
            {pending ? "Starting…" : "Start workflow"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function ArtifactModal({
  id,
  close,
}: {
  id: string | null;
  close: () => void;
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setArtifact(null);
    setError("");
    if (!id) return;
    let ignore = false;
    api<Artifact>(`/api/artifacts/${id}`)
      .then((value) => {
        if (!ignore) setArtifact(value);
      })
      .catch((error) => {
        if (!ignore) setError(error.message);
      });
    return () => {
      ignore = true;
    };
  }, [id]);
  let content = artifact?.content || "";
  if (artifact?.mediaType.includes("json")) {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      /* Show original content when JSON is malformed. */
    }
  }
  return (
    <Modal
      open={!!id}
      onOpenChange={(value) => {
        if (!value) close();
      }}
      title={artifact?.name || "Inspect artifact"}
      description={
        artifact
          ? `${artifact.mediaType} · ${new Date(artifact.createdAt).toLocaleString()}`
          : "Loading the recorded artifact and its evidence."
      }
      wide
    >
      {error ? (
        <div className="notice error-notice" role="alert">
          {error}
        </div>
      ) : !artifact ? (
        <div className="loading-state">
          <LoaderCircle className="spin" />
          Loading artifact…
        </div>
      ) : (
        <>
          <div className="artifact-metadata">
            <Braces size={14} />
            <span>SHA-256</span>
            <code>{artifact.digest}</code>
          </div>
          <pre
            className="code-view"
            tabIndex={0}
            aria-label={`${artifact.name} content`}
          >
            <code>{content}</code>
          </pre>
          <div className="artifact-modal-foot">
            <FileText size={14} />
            Immutable evidence from run <code>{shortId(artifact.runId)}</code>
          </div>
        </>
      )}
    </Modal>
  );
}
