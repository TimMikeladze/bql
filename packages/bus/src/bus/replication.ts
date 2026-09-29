import { open, mkdir, rename, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Message, Subscription } from "../shared/protocol";
import { type BusClient, BusRequestError } from "../client/bus";
import type { Logger } from "./log";
import { silentLogger } from "./log";
import type { BusStore } from "./store";

/**
 * Continuity: ship the **bus log**, not the SQLite WAL.
 *
 * The bus already is a log with a monotonic `seq`, so a follower rebuilds by
 * reading `/api/log?after=N` plus the subscription cursors. No WAL frame
 * parsing, it survives a schema change on either side, and it is this file
 * rather than a project.
 *
 * What this buys and what it does not, stated once: **continuity and read
 * scale-out, not write scale-out.** There is still one writer. Replication is
 * asynchronous, so a failover can lose up to the current lag — which is why
 * the lag is a published gauge and a number in the README rather than a
 * property quietly implied to be free.
 */

export interface LeaseState {
  epoch: number;
  holder: string;
  at: number;
}

/**
 * A lease in storage both sides can see.
 *
 * This is the fence. Promotion is not "decide to be the leader"; it is "win
 * the lease, and stamp the epoch you won". The old leader reads the same
 * object and stops writing once the epoch has moved past its own — a fence
 * only one side checks is a suggestion.
 */
export interface Lease {
  read(): Promise<LeaseState | null>;
  /**
   * Take the lease at `expected.epoch + 1`. Fails if someone else moved it
   * first, which is the whole contract.
   */
  acquire(holder: string): Promise<LeaseState>;
}

/**
 * A lease as a file.
 *
 * Correct on a filesystem both machines genuinely share (NFS with working
 * `rename`, EFS, a shared volume). It is compare-and-set over read-then-write,
 * so it is not safe against two promotions in the same millisecond on a
 * filesystem with no atomic rename — which is stated here rather than
 * discovered. For object storage, implement `Lease` with a conditional put and
 * pass it in; the seam is the whole point.
 */
export function fileLease(path: string): Lease {
  const target = resolve(path);
  return {
    async read() {
      try {
        return JSON.parse(await readFile(target, "utf8")) as LeaseState;
      } catch {
        return null;
      }
    },
    async acquire(holder) {
      const current = await this.read();
      const next: LeaseState = {
        epoch: (current?.epoch ?? 0) + 1,
        holder,
        at: Date.now(),
      };
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.tmp`;
      const file = await open(temporary, "w");
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      // Read back: on a filesystem where two writers raced, the loser finds
      // someone else's holder here and refuses to promote.
      const settled = await this.read();
      if (!settled || settled.holder !== holder || settled.epoch !== next.epoch)
        throw new Error(
          `lost the race for the lease: it is at epoch ${settled?.epoch ?? "?"} held by ${settled?.holder ?? "?"}`,
        );
      return settled;
    },
  };
}

export interface FollowerOptions {
  store: BusStore;
  /** A client pointed at the upstream, with a reader token or better. */
  upstream: BusClient;
  upstreamUrl: string;
  /** Workspaces to replicate. Empty means every workspace the token can see. */
  workspaces?: string[];
  /** How often to poll when the upstream had nothing new. */
  idleMs?: number;
  /** Messages per page. */
  batch?: number;
  logger?: Logger;
  onLag?: (lag: { seqBehind: number; ms: number }) => void;
}

export interface Follower {
  stop(): Promise<void>;
  readonly done: Promise<void>;
  state(): { appliedSeq: number; lagSeq: number; lagMs: number };
}

export function follow(options: FollowerOptions): Follower {
  const log = options.logger ?? silentLogger();
  const idleMs = options.idleMs ?? 500;
  const batch = Math.min(1000, options.batch ?? 500);
  let stopping = false;
  let lagSeq = 0;
  let lagMs = 0;

  options.store.demote(options.upstreamUrl);

  const done = (async () => {
    while (!stopping) {
      try {
        // Schedules are read *before* the log. A fire commits its message and
        // its `next_at` move in one transaction, so every fire this snapshot
        // has recorded is already in the log read below — the mirrored row
        // can lag the log, never lead it. (Leading would carry a `next_at`
        // past a fire this replica never received; lagging is harmless, the
        // fire's dedupe key is already here.) An upstream from before
        // schedules answers 404, which is simply nothing to mirror.
        const schedules = await options.upstream
          .schedules()
          .catch((error: unknown) => {
            if (error instanceof BusRequestError && error.status === 404)
              return null;
            throw error;
          });
        const after = options.store.cluster().appliedSeq;
        const messages: Message[] = await options.upstream.log(after, batch);
        if (messages.length > 0) {
          await options.store.applyReplicated(messages);
          // Lag in *time* as well as sequence: "1,200 messages behind" means
          // nothing without knowing whether that is a second or an hour.
          lagMs = Math.max(0, Date.now() - messages[messages.length - 1]!.publishedAt);
        }
        const subscriptions: Subscription[] = await options.upstream.subscriptions();
        options.store.applyCursors(subscriptions);

        const stats = await options.upstream.stats();
        // Only once the log page came back short, i.e. this replica has every
        // message up to the moment the schedules were read. The workspace
        // comes from the upstream — the one the token actually resolves to —
        // so an empty list still deletes this replica's copies.
        if (schedules && messages.length < batch) {
          const workspace =
            stats.workspace ?? schedules[0]?.workspace ?? options.upstream.workspace;
          options.store.applySchedules(workspace, schedules);
        }

        const head = stats.lastSeq;
        lagSeq = Math.max(0, head - options.store.cluster().appliedSeq);
        if (lagSeq === 0) lagMs = 0;
        options.onLag?.({ seqBehind: lagSeq, ms: lagMs });
        if (messages.length < batch) await Bun.sleep(idleMs);
      } catch (error) {
        log.warn("the follower could not read from its upstream", {
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(Math.max(idleMs, 1000));
      }
    }
  })();

  return {
    async stop() {
      stopping = true;
      await done;
    },
    done,
    state: () => ({
      appliedSeq: options.store.cluster().appliedSeq,
      lagSeq,
      lagMs,
    }),
  };
}

/**
 * Win the lease, stamp the epoch, take the leader role.
 *
 * Order matters: the lease first, because it is the thing another machine can
 * also see. Recording a new epoch locally and *then* failing to win the lease
 * would leave a node that believes it is the leader.
 */
export async function promote(
  store: BusStore,
  lease: Lease,
  holder: string,
): Promise<{ epoch: number; holder: string }> {
  const won = await lease.acquire(holder);
  store.promote(won.epoch);
  return { epoch: won.epoch, holder: won.holder };
}

/**
 * The other half of the fence: a leader that notices it has been superseded.
 *
 * Polls the lease and puts the store into read-only as soon as the epoch there
 * is past its own. The node does not exit — a process that vanishes takes its
 * in-flight acks with it — it stops accepting writes and says why.
 */
export function fenceWatcher(options: {
  store: BusStore;
  lease: Lease;
  intervalMs?: number;
  logger?: Logger;
}): { stop(): void } {
  const log = options.logger ?? silentLogger();
  const timer = setInterval(
    () => {
      void (async () => {
        const state = await options.lease.read();
        if (!state) return;
        const mine = options.store.cluster().epoch;
        if (state.epoch <= mine) return;
        log.error("this node has been fenced out; refusing further writes", {
          epoch: mine,
          leaseEpoch: state.epoch,
          holder: state.holder,
        });
        options.store.setReadOnly(
          true,
          `fenced out at epoch ${mine}; the lease is at ${state.epoch} held by ${state.holder}`,
        );
      })();
    },
    options.intervalMs ?? 5000,
  );
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
  };
}
