import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createEngine,
  envSecrets,
  fileSource,
  httpExecutor,
  installProcessGuards,
  type Executor,
} from "dagr";
import { SqliteStore } from "dagr/sqlite";
import { serve as serveEngine } from "dagr/serve";
import { BrokerStore, createBroker } from "../broker";
import { remoteExecutor } from "../executor/remote";

export interface HostOptions {
  /** Directory of dagr workflow definitions. */
  workflows: string;
  /** dagr's journal. One process writes it — this one. */
  engineDb: string;
  /**
   * The broker's own database, for the single-box deployment where this process
   * runs the broker too. Ignored when `brokerUrl` points at an external one.
   */
  brokerDb?: string;
  /**
   * An already-running broker to dispatch into, instead of starting one here.
   * This is the split deployment: the broker lives wherever the workers can
   * reach it, and the engine host is just another of its clients.
   */
  brokerUrl?: string;
  signingKey: string;
  adminToken: string;
  port: number;
  /** dagr's own control plane (runs, steps, asks, signals). Default: port + 1. */
  enginePort?: number;
  hostname: string;
  /** Hostnames the engine's local `http` runtime may reach. */
  httpAllow?: string[];
  assets?: string;
  /** Engine-side dispatch concurrency. Remote steps are pure waiting. */
  concurrency?: number;
  /** How long a worker may hold a task without a heartbeat. */
  leaseMs?: number;
}

export interface Host {
  /** Absent when this host dispatches into an external broker. */
  broker?: ReturnType<typeof createBroker>;
  brokerStore?: BrokerStore;
  brokerUrl: string;
  control: ReturnType<typeof serveEngine>;
  engine: Awaited<ReturnType<typeof createEngine>>;
  stop(): Promise<void>;
}

/**
 * One process holding both halves of the single-box deployment: dagr's engine
 * (the only writer of its journal) and the broker that remote workers talk to.
 *
 * They share a process and share nothing else — two databases, two concerns.
 * Splitting them across machines is `agenticbus broker` plus a host configured
 * with that broker's URL; nothing in this file is load-bearing for that.
 */
export async function startHost(options: HostOptions): Promise<Host> {
  const embedded = options.brokerUrl === undefined;
  for (const file of embedded ? [options.engineDb, options.brokerDb!] : [options.engineDb])
    await mkdir(dirname(resolve(file)), { recursive: true });

  const brokerStore = embedded
    ? new BrokerStore(options.brokerDb!, {
        ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
      })
    : undefined;
  const broker = brokerStore
    ? createBroker({
        store: brokerStore,
        signingKey: options.signingKey,
        adminToken: options.adminToken,
        port: options.port,
        hostname: options.hostname,
        ...(options.assets ? { assets: options.assets } : {}),
      })
    : undefined;
  const brokerUrl =
    options.brokerUrl?.replace(/\/$/, "") ??
    `http://${
      options.hostname === "0.0.0.0" ? "127.0.0.1" : options.hostname
    }:${broker!.port}`;

  const store = new SqliteStore(options.engineDb);
  await store.init();

  // Two remote executors, because agent-class is a static property of an
  // executor and the run's agent allowance must only be charged by steps that
  // actually spend it.
  const executors: Executor[] = [
    remoteExecutor({
      runtime: "remote",
      broker: brokerUrl,
      token: options.adminToken,
    }),
    remoteExecutor({
      runtime: "remote-agent",
      broker: brokerUrl,
      token: options.adminToken,
      agentClass: true,
      providerUnit: "USD",
    }),
    httpExecutor({ allowlist: options.httpAllow ?? [] }),
  ];

  const engine = createEngine({
    store,
    source: fileSource(options.workflows),
    executors,
    secrets: envSecrets(),
  });
  // Registration validates each definition against the executors this host
  // serves, so a step naming a runtime nothing can run is caught here rather
  // than at dispatch. A failure is loud: silently not registering a workflow is
  // the kind of thing an operator finds out about from its absence.
  for (const result of await engine.syncAll())
    for (const failure of result.failures ?? [])
      console.error(
        `workflow '${failure.slug}' was not registered: ${failure.message}`,
      );

  const worker = engine.worker({
    runtimes: ["remote", "remote-agent", "http"],
    // Remote steps are pure waiting — a network call, not a core — so this
    // sizes how many may be in flight, not how much CPU the host has.
    maxConcurrentSteps: options.concurrency ?? 32,
  });
  // `start()` resolves only when the loop stops, so it is held, not awaited.
  const loop = worker.start();
  loop.catch((error: unknown) => {
    console.error("dagr worker loop exited:", error);
  });

  // dagr's control plane, behind the same admin token as the broker. dagr
  // ships it unauthenticated by default and says so; a caller who reaches it
  // can start a run, which is arbitrary code on whatever runtimes the fleet
  // serves, so this host does not expose it bare.
  const control = serveEngine({
    engine,
    port: options.enginePort ?? options.port + 1,
    hostname: options.hostname,
    authenticate: async (req: Request) =>
      req.headers.get("authorization") === `Bearer ${options.adminToken}`
        ? { id: "operator" }
        : null,
  });

  // Only the process that owns the broker's database sweeps it.
  const sweep = brokerStore
    ? setInterval(() => brokerStore.sweep(), 1000)
    : undefined;
  installProcessGuards({ onFatal: () => void worker.stop() });

  return {
    ...(broker ? { broker } : {}),
    ...(brokerStore ? { brokerStore } : {}),
    brokerUrl,
    control,
    engine,
    async stop() {
      if (sweep) clearInterval(sweep);
      await worker.stop();
      await loop.catch(() => {});
      control.stop(true);
      broker?.stop(true);
      brokerStore?.close();
      await store.close?.();
    },
  };
}
