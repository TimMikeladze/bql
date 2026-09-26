import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "bun:test";
import { BusStore, SCHEMA_VERSION } from "../src/bus/store";

const scratch = await mkdtemp(`${tmpdir()}/bql-bus-migrations-`);
afterAll(() => rm(scratch, { recursive: true, force: true }));

/**
 * The schema exactly as it shipped before there was a version table, written
 * out by hand rather than imported from `MIGRATIONS`.
 *
 * Importing it would make this test agree with itself: the point is that a
 * database some earlier build actually wrote still opens, so the earlier
 * build's DDL has to be spelled out here and left alone.
 */
function writeLegacyDatabase(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode=WAL");
  for (const statement of [
    `CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      workspace TEXT NOT NULL, subject TEXT NOT NULL, key TEXT,
      headers TEXT NOT NULL, body TEXT, body_blob TEXT,
      published_at INTEGER NOT NULL, expires_at INTEGER, dedupe_key TEXT)`,
    "CREATE UNIQUE INDEX messages_dedupe ON messages(workspace, dedupe_key) WHERE dedupe_key IS NOT NULL",
    "CREATE INDEX messages_log ON messages(workspace, seq)",
    `CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL,
      pattern TEXT NOT NULL, cursor_seq INTEGER NOT NULL DEFAULT 0,
      ack_wait_ms INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      ordered INTEGER NOT NULL DEFAULT 0, dlq_subject TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`,
    "CREATE UNIQUE INDEX subscriptions_name ON subscriptions(workspace, name)",
    `CREATE TABLE deliveries (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
      status TEXT NOT NULL, consumer_id TEXT, generation INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
      available_at INTEGER NOT NULL DEFAULT 0, key TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(subscription_id, message_seq))`,
    "CREATE INDEX deliveries_ready ON deliveries(subscription_id, status, available_at, message_seq)",
    "CREATE INDEX deliveries_lease ON deliveries(status, lease_until)",
    "CREATE INDEX deliveries_key ON deliveries(subscription_id, status, key)",
    `CREATE TABLE responses (
      workspace TEXT NOT NULL, correlation TEXT NOT NULL,
      message_seq INTEGER NOT NULL, headers TEXT NOT NULL, body TEXT,
      created_at INTEGER NOT NULL, PRIMARY KEY (workspace, correlation))`,
    "CREATE TABLE blobs (handle TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
    `CREATE TABLE consumers (id TEXT PRIMARY KEY, workspace TEXT NOT NULL,
      last_seen INTEGER NOT NULL, data TEXT NOT NULL)`,
  ])
    db.run(statement);

  // A message and a subscription that already existed, so the check is that
  // real data survives rather than that an empty file opens.
  db.run(
    `INSERT INTO messages (id, workspace, subject, key, headers, body, published_at)
     VALUES ('legacy-1','default','orders.eu.created',NULL,'{}','{"old":true}',1)`,
  );
  db.run(
    `INSERT INTO subscriptions (id, workspace, name, pattern, cursor_seq, ack_wait_ms, max_attempts, dlq_subject, created_at, updated_at)
     VALUES ('sub-1','default','orders','orders.>',0,30000,3,'dlq.orders',1,1)`,
  );
  db.close();
}

test("a database written before schema versioning opens and keeps working", async () => {
  const path = `${scratch}/legacy.db`;
  writeLegacyDatabase(path);

  const store = new BusStore(path);
  expect(store.schemaVersion()).toBe(SCHEMA_VERSION);

  // The pre-existing row is still there, and the pre-existing subscription
  // still delivers it — the cursor it was saved with is honoured.
  const claimed = await store.claim("default", "orders", "worker-1", 10);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.message.body).toEqual({ old: true });

  // And the migrated database still takes new work.
  const published = await store.publish("default", {
    subject: "orders.us.created",
    body: { fresh: true },
  });
  expect(published.seq).toBeGreaterThan(1);
  store.close();

  // Re-opening does not re-apply anything.
  const reopened = new BusStore(path);
  expect(reopened.schemaVersion()).toBe(SCHEMA_VERSION);
  expect((await reopened.log("default")).length).toBe(2);
  reopened.close();
});

test("a database from a newer build is refused rather than guessed at", () => {
  const path = `${scratch}/future.db`;
  const store = new BusStore(path);
  store.close();

  const db = new Database(path, { strict: true });
  db.run("INSERT INTO schema_version (version, applied_at) VALUES (?,?)", [
    SCHEMA_VERSION + 7,
    Date.now(),
  ]);
  db.close();

  expect(() => new BusStore(path)).toThrow(/only knows/i);
});

test("a fresh database is stamped with the current version", () => {
  const store = new BusStore(":memory:");
  expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
  store.close();
});
