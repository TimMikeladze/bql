/**
 * Deterministic crash points.
 *
 * `--kill-bus` in the soak kills at a random moment, which proves the bus
 * survives *a* crash but never proves it survives *the* crash — the one in the
 * window between writing a blob and committing the row that names it. These
 * are those windows, named, and armed only by an environment variable the soak
 * sets. Unset, each call is a string comparison against `undefined`.
 *
 * The kill is SIGKILL rather than `process.exit`: no flush, no `atexit`, no
 * graceful anything. A durability claim that only holds for a polite shutdown
 * is not a durability claim.
 */

export type FaultPoint =
  /** Blob bytes are on disk; the message row has not been inserted. */
  | "blob-write"
  /** Inside the publish transaction, after the row insert, before commit. */
  | "mid-txn"
  /** The ack is committed; the HTTP response has not been written. */
  | "post-ack";

const armed = process.env.BUS_FAULT as FaultPoint | undefined;
let countdown = Math.max(1, Number(process.env.BUS_FAULT_AFTER ?? 1));

/** True when this build is running with a fault armed. Used for logging only. */
export const faultArmed = (): FaultPoint | undefined => armed;

export function fault(at: FaultPoint): void {
  if (at !== armed) return;
  if (--countdown > 0) return;
  process.kill(process.pid, "SIGKILL");
}
