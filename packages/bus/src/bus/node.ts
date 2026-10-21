/**
 * The bus on a bql.sh node that serves: mounted under `/bus` on bql.sh's own
 * listener, writing while this node holds database `bus` as primary and
 * serving reads from its copy while it holds a replica.
 *
 * Two entry points build one of these: `bql bus serve --cluster …` and
 * `bql serve --bus`. Both open a `Bql`, call `busNode`, pass `node.mount` to
 * `bq.serve()` and then `await node.start()`. The order matters: a clustered
 * node cannot find out who holds `bus` until Raft is running, and Raft runs on
 * the listener `serve()` opens.
 */
import { homeOf } from "../../../db/src/cluster/index.ts";
import type { Bql, Mount } from "../../../db/src/embedded.ts";
import { type Logger, silentLogger } from "./log";
import { createServer, type BusServer, type ServerOptions } from "./server";
import {
  type Ack,
  bqlStorage,
  enableForeignKeys,
  ensureBusDatabase,
  isContention,
  retryContention,
} from "./storage";
import { BusStore, type StoreOptions } from "./store";

export type BusNodeRole = "starting" | "primary" | "replica";

export interface BusNodeOptions
  extends Omit<
    ServerOptions,
    "store" | "listen" | "basePath" | "primaryUrl" | "port" | "hostname"
  > {
  bq: Bql;
  /** The bql.sh database holding the bus tables. Default `bus`. */
  database?: string;
  /** Publish durability when a publish names none. Default `fsync`. */
  ack?: Ack;
  /** Where the routes are mounted. Default `/bus`. */
  prefix?: string;
  /** Store options. Bodies over `inlineMaxBytes` always go to `blobs_data`. */
  store?: Omit<StoreOptions, "replica">;
  /** The sweep (and the scheduler inside it) on a primary, the cache reload on a replica. */
  tickMs?: number;
  logger?: Logger;
}

export interface BusNode {
  /** Hand to `bq.serve({ mount: [node.mount] })`. */
  readonly mount: Mount;
  readonly role: BusNodeRole;
  /** Null until `start()` has opened it. */
  readonly store: BusStore | null;
  /** The route handler, once started. */
  readonly server: BusServer | null;
  /** Find or create the database, open the store in this node's role, start the timers. */
  start(): Promise<void>;
  /** Drain long polls, stop the timers and close the store. The `Bql` stays open. */
  close(): Promise<void>;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export function busNode(options: BusNodeOptions): BusNode {
  const {
    bq,
    database = "bus",
    ack,
    prefix = "/bus",
    store: storeOptions = {},
    tickMs = 1000,
    logger,
    ...serverOptions
  } = options;
  const log = logger ?? silentLogger();
  let role: BusNodeRole = "starting";
  let store: BusStore | null = null;
  let server: BusServer | null = null;
  let closed = false;
  let starting: Promise<void> | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];
  let offRole: (() => void) | null = null;
  /** One role change at a time; a promotion migrates, which may wait out a snapshot. */
  let changing: Promise<void> = Promise.resolve();

  /** The bus URL of the node holding the primary, from bql.sh's own answer. */
  const primaryUrl = (): string | null => {
    const http = bq.runtime.primaryHttpFor(database);
    return http ? `${http}${prefix}` : null;
  };

  const mount: Mount = {
    prefix,
    fetch(request, host) {
      if (server) return server.fetch(request, host as Bun.Server<unknown>);
      // Starting, or this node holds no copy (`rf` below the node count). A
      // client treats it as any other NOT_PRIMARY and goes elsewhere.
      const primary = primaryUrl();
      return json(
        {
          error: closed ? "the bus is closing" : "the bus is starting",
          code: "NOT_PRIMARY",
          ...(primary ? { primary } : {}),
        },
        503,
        primary ? { "BQL-Primary": primary } : {},
      );
    },
  };

  const cluster = () => bq.runtime.cluster;

  /** Every configured peer has joined, so placement gives every node the same answer. */
  const membershipComplete = (): boolean => {
    const node = cluster();
    if (!node) return true;
    const expected = bq.config.cluster.peers.length + 1;
    return Object.keys(node.state.nodes).length >= expected;
  };

  /**
   * Create database `bus` on the node placement names, through `bq.create`
   * (the create gate, then the first lease claim). Every other node waits for
   * its replica copy to arrive. Placement is decided here rather than left to
   * the gate because the gate refuses nothing while a node is still joining.
   */
  const ensureDatabase = async (): Promise<void> => {
    let waited = 0;
    while (!closed) {
      if (bq.runtime.registry.has(database)) return;
      const node = cluster();
      if (!node) {
        // A standalone node, or a statically configured replica.
        if (bq.runtime.role !== "replica") {
          await ensureBusDatabase(bq, database);
          return;
        }
      } else if (membershipComplete()) {
        const members = Object.entries(node.state.nodes).map(([id, info]) => ({
          id,
          zone: info.zone,
        }));
        const home = node.primaryOf(database) ?? homeOf(database, members);
        if (home === node.id) {
          // `bq.create` runs the create gate and waits for this node's
          // lease, as `POST /v1/db` does.
          try {
            await bq.create(database);
          } catch (error) {
            if (!bq.runtime.registry.has(database)) throw error;
          }
          return;
        }
      }
      if (waited % 100 === 0)
        log.info("waiting for the bus database", {
          database,
          primary: primaryUrl(),
        });
      waited++;
      await Bun.sleep(100);
    }
  };

  /** A replica copy can be registered before its first snapshot has the tables. */
  const tablesArrived = (): boolean => {
    try {
      return (
        bq
          .db(database)
          .sync.read((d) =>
            d
              .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
              .get(),
          ) !== null
      );
    } catch {
      return false;
    }
  };

  const liveRole = (): "primary" | "replica" => bq.role(database);

  const becomePrimary = async (opened: BusStore) => {
    // `foreign_keys` is a per-node catalog setting, so the node taking over
    // writes sets it for itself. A no-op when it is already on.
    enableForeignKeys(bq, database);
    await retryContention(() => opened.becomePrimary(), 30_000);
    role = "primary";
    log.info("this node is the bus primary", { database });
  };

  const becomeReplica = (opened: BusStore) => {
    opened.becomeReplica();
    role = "replica";
    log.info("this node holds a bus replica", {
      database,
      primary: primaryUrl(),
    });
  };

  /** Bring the store's role in line with bql.sh's. Serialised; idempotent. */
  const reconcile = (): Promise<void> => {
    changing = changing.then(async () => {
      const opened = store;
      if (!opened || closed) return;
      const want = liveRole();
      if (want === role) return;
      try {
        if (want === "primary") await becomePrimary(opened);
        else becomeReplica(opened);
      } catch (error) {
        // The next tick tries again.
        log.warn("the bus could not change role", {
          to: want,
          error: String(error),
        });
      }
    });
    return changing;
  };

  const tick = () => {
    const opened = store;
    if (!opened || closed) return;
    if (liveRole() !== role) {
      void reconcile();
      return;
    }
    if (role === "replica") {
      opened.reloadCaches();
      return;
    }
    try {
      opened.sweep();
    } catch (error) {
      if (isContention(error)) return;
      // The lease lapsed between the role check and the write; the role
      // event follows.
      if ((error as { code?: string }).code === "NOT_PRIMARY") return;
      log.warn("the sweep failed", { error: String(error) });
    }
  };

  const open = async (): Promise<void> => {
    await ensureDatabase();
    if (closed) return;
    // A node restarting after a failover still has `bus` marked primary in its
    // own catalog until the control plane fences it. Wait until it holds the
    // lease or has been told it is a replica.
    const unsettled = () => {
      const node = cluster();
      return (
        node !== null &&
        liveRole() === "primary" &&
        node.knows(database) &&
        !node.holdsLease(database)
      );
    };
    while (!closed && unsettled()) await Bun.sleep(100);
    // A database this node created is primary here; one that arrived is not.
    while (!closed && liveRole() === "replica" && !tablesArrived()) await Bun.sleep(100);
    if (closed) return;
    const asReplica = liveRole() === "replica";
    if (!asReplica) enableForeignKeys(bq, database);
    const storage = bqlStorage(bq, { database, ...(ack ? { ack } : {}) });
    const opened = await retryContention(
      () =>
        new BusStore(storage, {
          ...storeOptions,
          ...(asReplica ? { replica: true } : {}),
        }),
      30_000,
    );
    store = opened;
    role = asReplica ? "replica" : "primary";
    server = createServer({
      ...serverOptions,
      store: opened,
      listen: false,
      basePath: prefix,
      primaryUrl,
      ...(logger ? { logger } : {}),
    });
    offRole = bq.on("role", (event) => {
      if (event.db === database) void reconcile();
    });
    timers.push(setInterval(tick, tickMs));
    // Blob collection touches every blob row, so it runs on its own slower
    // interval, as on a single node.
    timers.push(
      setInterval(() => {
        if (role !== "primary" || !store) return;
        void store.collectBlobs().catch((error: unknown) => {
          log.warn("blob collection failed", { error: String(error) });
        });
      }, 60_000),
    );
    log.info("the bus is open", { database, role, prefix });
    // A flip that landed between opening and subscribing.
    await reconcile();
  };

  return {
    mount,
    get role() {
      return role;
    },
    get store() {
      return store;
    },
    get server() {
      return server;
    },
    start() {
      starting ??= open();
      return starting;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      offRole?.();
      await starting?.catch(() => {});
      await changing;
      await server?.shutdown({ timeoutMs: 5000 });
      store?.close();
    },
  };
}
