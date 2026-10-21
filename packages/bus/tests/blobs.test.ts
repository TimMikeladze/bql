/**
 * Bodies over `inlineMaxBytes`, in `blobs_data` in the bus's own database.
 */
import { expect, test } from "bun:test";
import { freshDatabase, testStore } from "./helpers";
import type { BusStore } from "../src/bus/store";

let clock = 1_000_000;
const now = () => clock;
const W = "default";

const sub = (store: BusStore, name: string) =>
  store.subscribe(W, {
    name,
    pattern: "work.>",
    ackWaitMs: 1000,
    maxAttempts: 3,
    deliverFrom: "beginning",
    backoff: { baseMs: 0 },
  });

const count = (store: BusStore, table: string) =>
  (store.raw().query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("an oversized body is stored in blobs_data and read back", async () => {
  const store = testStore({ now, inlineMaxBytes: 32 });
  sub(store, "work");
  const body = { big: "x".repeat(200) };
  await store.publish(W, { subject: "work.do", body });
  // A deduplicated publish writes no bytes: the blob goes in with the row.
  await store.publish(W, { subject: "work.do", body, dedupeKey: "once" });
  await store.publish(W, { subject: "work.do", body, dedupeKey: "once" });
  expect(count(store, "blobs_data")).toBe(2);

  const [envelope] = await store.claim(W, "work", "c1", 1);
  expect(envelope!.message.body).toEqual(body);
  const row = store
    .raw()
    .query("SELECT body, body_blob, body_sha256 FROM messages ORDER BY seq LIMIT 1")
    .get() as { body: string | null; body_blob: string | null; body_sha256: string | null };
  expect(row.body).toBeNull();
  expect(row.body_blob).not.toBeNull();
  expect(row.body_sha256).toHaveLength(64);

  // Once nothing references them, collection removes the bytes and the handle.
  store.raw().run("DELETE FROM messages");
  expect(await store.collectBlobs()).toBe(2);
  expect(count(store, "blobs_data")).toBe(0);
  store.close();
});

test("a 4 MiB body survives a reopen", async () => {
  const database = freshDatabase();
  const body = { big: "é".repeat(2 * 1024 * 1024) };
  const store = testStore({ now, database });
  sub(store, "work");
  const { seq } = await store.publish(W, { subject: "work.do", body });
  store.close();

  const reopened = testStore({ now, database });
  expect((await reopened.message(W, seq)).body).toEqual(body);
  expect(await reopened.reconcileBlobs()).toEqual({ missing: 0, deadLettered: 0 });
  reopened.close();
});

test("a body shortened behind the bus's back is caught by its length and checksum", async () => {
  const store = testStore({ now, inlineMaxBytes: 32 });
  sub(store, "work");
  await store.publish(W, { subject: "work.do", body: { big: "x".repeat(200) } });
  // Still valid JSON, which is what makes the check worth having over a parse.
  store
    .raw()
    .run("UPDATE blobs_data SET bytes = ?", [
      new TextEncoder().encode(JSON.stringify({ big: "x".repeat(100) })),
    ]);
  // The one unreadable delivery is dead-lettered and the subscription moves on.
  expect(await store.claim(W, "work", "c1", 1)).toHaveLength(0);
  expect(store.stats(W).subscriptions.find((s) => s.name === "work")!.dead).toBe(1);
  store.close();
});

test("a message whose bytes are gone dead-letters instead of stalling", async () => {
  const store = testStore({ now, inlineMaxBytes: 32 });
  sub(store, "work");
  await store.publish(W, { subject: "work.do", body: { big: "x".repeat(200) } });
  await store.publish(W, { subject: "work.do", body: { big: "y".repeat(200) } });
  const first = store
    .raw()
    .query("SELECT body_blob FROM messages ORDER BY seq LIMIT 1")
    .get() as { body_blob: string };
  store.raw().run("DELETE FROM blobs_data WHERE handle = ?", [first.body_blob]);

  const claimed = await store.claim(W, "work", "c1", 2);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.message.body).toEqual({ big: "y".repeat(200) });
  expect(store.stats(W).subscriptions.find((s) => s.name === "work")!.dead).toBe(1);
  expect((await store.reconcileBlobs()).missing).toBe(1);
  store.close();
});
