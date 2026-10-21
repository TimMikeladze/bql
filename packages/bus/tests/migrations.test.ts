import { expect, test } from "bun:test";
import { freshDatabase, testStore } from "./helpers";
import { SCHEMA_VERSION } from "../src/bus/store";

test("a fresh database is stamped with the current version", () => {
  const store = testStore();
  expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
  store.close();
});

test("reopening applies nothing twice", async () => {
  const database = freshDatabase();
  const store = testStore({ database });
  await store.publish("default", { subject: "work.a", body: 1 });
  store.close();
  const reopened = testStore({ database });
  expect(reopened.schemaVersion()).toBe(SCHEMA_VERSION);
  expect(
    (reopened.raw().query("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n,
  ).toBe(SCHEMA_VERSION);
  expect((await reopened.log("default")).length).toBe(1);
  reopened.close();
});

test("a database from a newer build is refused rather than guessed at", () => {
  const database = freshDatabase();
  const store = testStore({ database });
  store.raw().run("INSERT INTO schema_version (version, applied_at) VALUES (?,?)", [
    SCHEMA_VERSION + 7,
    Date.now(),
  ]);
  store.close();

  expect(() => testStore({ database })).toThrow(/only knows/i);
});
