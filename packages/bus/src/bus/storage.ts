/**
 * Where the bus store keeps its tables: a bql.sh database, `bus` unless named
 * otherwise. Every write goes through the tenant's write path, so it lands in
 * the database's log and can be shipped, acked by replicas and restored to a
 * txid. The store never touches a connection directly; it asks for `write`
 * and `read`.
 *
 * This module imports bql.sh for types only. The engine itself is opened by
 * whoever runs the bus (`bql bus serve`, `bql serve --bus`, or an embedder).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Ack } from "../../../db/src/client/protocol.ts";
import { BqlClientError } from "../../../db/src/client/errors.ts";
import type { Bql } from "../../../db/src/embedded.ts";
import type { Database, RunResult } from "../../../db/src/sqlite/index.ts";

export type { Ack };
export const ACK_LEVELS: readonly Ack[] = ["local", "fsync", "replica", "quorum"];

export function isAck(value: unknown): value is Ack {
  return typeof value === "string" && (ACK_LEVELS as readonly string[]).includes(value);
}

/** A failure the backend raises with a status and extra body fields for the HTTP answer. */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface StorageWriteOptions {
  /** Durability of this commit. Defaults to the storage's own. */
  ack?: Ack;
}

/** Database `bus` as the store sees it. `bqlStorage` makes one. */
export interface BusStorage {
  /** The database file, for free-space probes. */
  readonly path: string;
  /** What a publish waits for when the request names no `ack`. */
  readonly defaultAck: Ack;
  /** Run `fn` in one write transaction and commit it. */
  write<T>(
    fn: (d: Database) => T,
    options?: StorageWriteOptions,
  ): { value: T; txid: number };
  /** Run `fn` against committed state. */
  read<T>(fn: (d: Database) => T): T;
  /** Throws before anything is written when `ack` cannot be met here. */
  assertAck(ack: Ack): void;
  /** Resolves once `ack` covers `txid`. */
  replicated(txid: number, ack: Ack): Promise<void>;
  sizes(): { dbBytes: number; walBytes: number };
  close(): void;
}

export interface BqlStorageOptions {
  /** The database holding the bus tables. Default `bus`. */
  database?: string;
  /**
   * A publish's ack when the request names none. Every other write (claims,
   * acks, renewals, the sweep) commits at `local` when this is `local` and at
   * `fsync` otherwise, and waits for nothing more.
   */
  ack?: Ack;
  /** Called by `close()`. The `Bql` itself belongs to whoever opened it. */
  onClose?: () => void;
}

/** True for the two errors bql.sh answers instead of waiting for its writer. */
export function isContention(error: unknown): boolean {
  return (
    error instanceof BqlClientError &&
    (error.code === "BUSY" || error.code === "TX_BUSY")
  );
}

/** One attempt at a request, for deciding whether it may run again. */
export interface Attempt {
  /** Top-level writes this attempt committed. */
  commits: number;
  /** True from the second attempt on. */
  retry: boolean;
}

/** The attempt the current async call chain belongs to, if any. */
export const attempts = new AsyncLocalStorage<Attempt>();

/**
 * Run `fn` again after a short sleep while bql.sh's writer is held by a
 * snapshot or an interactive transaction. `sync.write` refuses rather than
 * waits, and a synchronous call cannot wait, so the waiting happens here.
 * After `deadlineMs` the last refusal is thrown.
 */
export async function retryContention<T>(
  fn: () => T | Promise<T>,
  deadlineMs = 5000,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isContention(error) || Date.now() >= deadline) throw error;
      await Bun.sleep(Math.min(50, 2 ** attempt));
    }
  }
}

/**
 * Make sure database `name` exists with foreign keys on, which the bus's
 * cascades depend on. Call before `bqlStorage`.
 */
export async function ensureBusDatabase(bq: Bql, name = "bus"): Promise<void> {
  if (!bq.list().some((row) => row.name === name)) await bq.create(name);
  enableForeignKeys(bq, name);
}

/**
 * `foreign_keys` is a connection property bql.sh sets per database; a
 * statement inside `sync.write` cannot change it. Setting it releases the
 * tenant so it reopens with the pragma, so it is done only when needed.
 */
export function enableForeignKeys(bq: Bql, name: string): void {
  const registry = bq.runtime.registry;
  const row = registry.catalog.getTenant(name);
  if (!row) throw new StorageError(`database '${name}' does not exist`, 500);
  if (row.foreignKeys === true) return;
  if (row.foreignKeys === null && bq.config.sqlite.foreignKeys) return;
  registry.setForeignKeys(name, true);
}

/** The bus tables in bql.sh database `options.database` (default `bus`). */
export function bqlStorage(
  bq: Bql,
  options: BqlStorageOptions = {},
): BusStorage {
  const name = options.database ?? "bus";
  if (!bq.list().some((row) => row.name === name))
    throw new StorageError(
      `bql.sh database '${name}' does not exist; await ensureBusDatabase(bq, '${name}') first`,
      500,
    );
  enableForeignKeys(bq, name);
  const defaultAck = options.ack ?? "fsync";
  const writeAck: Ack = defaultAck === "local" ? "local" : "fsync";
  // Looked up per call: a role flip evicts and reopens the tenant.
  const handle = () => bq.db(name);
  const tenant = () => bq.tenantOf(name);
  return {
    get path() {
      return tenant().dbPath;
    },
    defaultAck,
    write: (fn, writeOptions = {}) =>
      handle().sync.write(fn, { ack: writeOptions.ack ?? writeAck }),
    read: (fn) => handle().sync.read(fn),
    assertAck(ack) {
      try {
        bq.assertReplicas(name, ack);
      } catch (error) {
        throw toStorageError(error);
      }
    },
    async replicated(txid, ack) {
      try {
        await bq.replicated(name, txid, { ack });
      } catch (error) {
        throw toStorageError(error);
      }
    },
    sizes() {
      const t = tenant();
      return { dbBytes: t.sizeBytes, walBytes: t.walBytes };
    },
    close: () => options.onClose?.(),
  };
}

/** `NO_REPLICAS` and `ACK_TIMEOUT` keep their code and numbers on the way out. */
function toStorageError(error: unknown): unknown {
  if (!(error instanceof BqlClientError)) return error;
  if (error.code !== "NO_REPLICAS" && error.code !== "ACK_TIMEOUT") return error;
  return new StorageError(error.message, error.status || 503, {
    code: error.code,
    ...(error.txid !== undefined ? { txid: error.txid } : {}),
    ...(error.acks !== undefined ? { acks: error.acks } : {}),
    ...(error.needed !== undefined ? { needed: error.needed } : {}),
  });
}

// ------------------------------------------------------------- the handle

/** The part of a prepared statement the store uses. */
export interface StatementLike {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * The connection-shaped object the store, `SqliteBlobStore` and `raw()` use.
 *
 * Inside a `write` every call goes to the writer the storage handed out, so a
 * read sees the transaction's own writes and a nested `transaction` is a
 * SAVEPOINT. Outside one, a read goes through `read` (a pooled reader) and a
 * bare `run` is a write of its own.
 */
export class StoreDb {
  /** The writer, while a write is running. */
  private tx: Database | null = null;
  constructor(readonly backend: BusStorage) {}

  /** The connection a handler should write through, inside `write`. */
  get writer(): Database | null {
    return this.tx;
  }

  get inWrite(): boolean {
    return this.tx !== null;
  }

  query(sql: string): StatementLike {
    if (this.tx) return this.tx.query(sql) as unknown as StatementLike;
    const backend = this.backend;
    return {
      get: (...params: unknown[]) =>
        backend.read((d) => (d.query(sql) as unknown as StatementLike).get(...params)),
      all: (...params: unknown[]) =>
        backend.read((d) => (d.query(sql) as unknown as StatementLike).all(...params)),
    };
  }

  /** Alias for `query`, matching the driver. */
  prepare(sql: string): StatementLike {
    return this.query(sql);
  }

  run(sql: string, params?: unknown[]): RunResult {
    const bind = params as Parameters<Database["run"]>[1];
    if (this.tx) return this.tx.run(sql, bind);
    return this.write((d) => d.run(sql, bind)).value;
  }

  /** Always `BEGIN IMMEDIATE` at the top level; nested, a SAVEPOINT. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => this.write(() => fn(...args)).value;
  }

  /**
   * One write. Nested inside another it joins it as a SAVEPOINT and has no
   * txid of its own.
   */
  write<T>(
    fn: (d: Database) => T,
    options: StorageWriteOptions = {},
  ): { value: T; txid?: number } {
    const open = this.tx;
    if (open) return { value: open.transaction(() => fn(open))() };
    const result = this.backend.write((d) => {
      this.tx = d;
      try {
        return fn(d);
      } finally {
        this.tx = null;
      }
    }, options);
    const attempt = attempts.getStore();
    if (attempt) attempt.commits++;
    return result;
  }

  close(): void {
    this.backend.close();
  }
}
