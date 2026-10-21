/**
 * One bql.sh engine for the whole run, and a fresh database per store, so a
 * test gets the tables to itself without paying for an engine of its own.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bql } from "../../db/src/embedded.ts";
import { createBus, type EmbeddedBusOptions } from "../src/bus/embedded";
import { bqlStorage, enableForeignKeys } from "../src/bus/storage";
import { BusStore, type StoreOptions } from "../src/bus/store";

const dir = mkdtempSync(join(tmpdir(), "bql-bus-test-"));
export const bq = await Bql.open({ dir, data: { maxOpen: 100_000 } });
process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;

/**
 * Create a database for one store, or reuse `name` if it exists. `create`
 * does its work before its first await for a database that is not a fork,
 * which is what lets this stay synchronous for the many tests that build a
 * store at module scope.
 */
export function freshDatabase(
  name = `t${(++counter).toString(36).padStart(6, "0")}`,
): string {
  if (!bq.list().some((row) => row.name === name)) {
    void bq.create(name);
    if (!bq.list().some((row) => row.name === name))
      throw new Error(`bql.sh did not create ${name} synchronously`);
  }
  enableForeignKeys(bq, name);
  return name;
}

/**
 * A store on its own database. Pass `database` to open the same one again
 * after a close; without it the database is deleted when the store closes.
 */
export function testStore(
  options: StoreOptions & { database?: string } = {},
): BusStore {
  const { database, ...rest } = options;
  const name = freshDatabase(database);
  return new BusStore(
    bqlStorage(bq, {
      database: name,
      ...(database ? {} : { onClose: () => void bq.delete(name) }),
    }),
    rest,
  );
}

/** `createBus` on its own database. */
export function testBus(options: Omit<EmbeddedBusOptions, "bql"> = {}) {
  return createBus({
    ...options,
    bql: bq,
    database: freshDatabase(options.database),
  });
}
