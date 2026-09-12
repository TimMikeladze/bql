export type Role = "creator" | "reviewer" | "tester";
export type Mode = "demo" | "live";
export type TaskStatus =
  "blocked" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RunStatus =
  "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
export interface Run {
  id: string;
  title: string;
  brief: string;
  mode: Mode;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  requestKey: string;
}
export interface Task {
  id: string;
  runId: string;
  role: Role;
  status: TaskStatus;
  workerId: string | null;
  generation: number;
  leaseUntil: number | null;
  attempt: number;
  inputArtifactId: string | null;
  outputArtifactId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface Worker {
  id: string;
  name: string;
  role: Role;
  host: string;
  mode: Mode;
  lastSeen: number;
  paused: boolean;
}
export interface Artifact {
  id: string;
  runId: string;
  taskId: string;
  name: string;
  mediaType: string;
  content: string;
  digest: string;
  createdAt: number;
}
export interface BusEvent {
  seq: number;
  id: string;
  specversion: "1.0";
  source: string;
  type: string;
  subject: string;
  time: string;
  runId: string | null;
  data: Record<string, unknown>;
}
export interface Snapshot {
  runs: Run[];
  tasks: Task[];
  workers: Worker[];
  artifacts: Omit<Artifact, "content">[];
  events: BusEvent[];
  now: number;
}
export interface Claim {
  task: Task;
  run: Run;
  artifact: Artifact | null;
}
export interface Completion {
  generation: number;
  ok: boolean;
  name: string;
  mediaType: string;
  content: string;
  error?: string;
}
export interface NewRun {
  title: string;
  brief: string;
  mode: Mode;
  requestKey: string;
}
export const DEFAULT_BRIEF =
  "Build a slugify(text: string): string utility. Lowercase, trim whitespace, normalize accents, replace non-alphanumeric runs with one hyphen, and remove leading/trailing hyphens. Export a named slugify function.";
