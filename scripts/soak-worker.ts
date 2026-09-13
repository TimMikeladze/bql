/**
 * A soak consumer. Deliberately dumb: claim, write a receipt, ack.
 *
 * The receipt is appended with `appendFileSync` *before* the handler returns,
 * so it records what was actually handled even when this process is SIGKILLed
 * a microsecond later — a write(2) that has returned survives the kill, and
 * nothing here is buffered in userspace waiting for a flush that never comes.
 *
 * Receipts are files rather than messages on a `receipts.>` subject on purpose:
 * a receipt that travels through the bus is a second thing that can fail, and
 * it would double the load the soak is trying to measure.
 */
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { BusClient, BusConsumer } from "../src/client/bus";

const flag = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
};

const id = flag("id", "soak-0");
const receipts = flag("receipts", "./receipts");
const holdMs = Number(flag("hold-ms", "15"));

const client = new BusClient({
  url: process.env.BUS_URL ?? "http://127.0.0.1:4317",
  token: process.env.BUS_TOKEN ?? "",
  timeoutMs: 20_000,
});

const consumer = new BusConsumer({
  client,
  id,
  subscription: flag("subscription", "soak"),
  host: hostname(),
  prefetch: Number(flag("prefetch", "4")),
  waitMs: 2000,
  log: () => {},
  async handle({ message, delivery }) {
    appendFileSync(
      `${receipts}/${id}.jsonl`,
      `${JSON.stringify({
        seq: message.seq,
        key: message.key,
        attempt: delivery.attempt,
        by: id,
        // Sub-millisecond, and still comparable across processes on one
        // machine — two handlers of the same key can land in one millisecond,
        // and `Date.now()` would make that look like an ordering violation.
        at: performance.timeOrigin + performance.now(),
      })}\n`,
    );
    // A little real work, jittered, so consumers are genuinely overlapping
    // rather than taking strict turns.
    if (holdMs > 0) await Bun.sleep(Math.floor(Math.random() * holdMs));
    // A poison message fails every time, on purpose. The receipt above is
    // written *before* the failure, so the harness can count how many times
    // each poison message was actually handled — which is the only way to tell
    // "retried with backoff" from "hot-looped through its whole budget".
    const body = message.body as { poison?: boolean } | null;
    if (body && typeof body === "object" && body.poison === true)
      throw new Error(`poison message ${message.seq}`);
    return undefined;
  },
});

process.on("SIGTERM", () => consumer.stop());
process.on("SIGINT", () => consumer.stop());
await consumer.start();
