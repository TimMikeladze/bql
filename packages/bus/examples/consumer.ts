/**
 * A consumer, in about twenty lines.
 *
 * It handles two kinds of message with the same loop: plain work (do the thing,
 * ack) and requests (do the thing, return a value, which the bus records as the
 * response). Nothing here is agent-specific — an agent consumer differs only in
 * what `handle` does with the body.
 */
import { hostname } from "node:os";
import { BusClient, BusConsumer, FatalError } from "../src/client/bus";
import type { Json } from "../src/shared/protocol";

const flag = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
};

const client = new BusClient({
  url: process.env.BUS_URL ?? "http://127.0.0.1:4317",
  token: process.env.BUS_TOKEN ?? "",
});

const id = flag("id", `${hostname()}-consumer`);
const consumer = new BusConsumer({
  client,
  id,
  subscription: flag("subscription", "work"),
  host: hostname(),
  prefetch: Number(flag("prefetch", "2")),
  log: (message) => console.log(message),
  async handle({ message }): Promise<Json> {
    const body = message.body as Record<string, Json> | string | null;
    switch (message.subject.split(".")[1]) {
      case "slow": {
        const ms = Number((body as { ms?: number })?.ms ?? 500);
        await Bun.sleep(ms);
        return { sleptMs: ms, by: id };
      }
      case "upper":
        return String(body).toUpperCase();
      case "fail":
        throw new Error("this message always fails");
      case "poison":
        // Nothing will ever make this work, so do not spend the retries.
        throw new FatalError("unsupported payload");
      default:
        return { handled: message.subject, by: id };
    }
  },
});

process.on("SIGTERM", () => consumer.stop());
process.on("SIGINT", () => consumer.stop());
await consumer.start();
