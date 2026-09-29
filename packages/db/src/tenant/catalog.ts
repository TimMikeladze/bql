// The node's catalog: `<dataDir>/_system.db`, holding every tenant, the token revocation list and
// the snapshot index. Design §4.2 ("a local catalog data/_system.db … holds tenants, tokens,
// positions, placement").
//
// Invariant: the catalog is written *after* the transaction log, never before. A crash can
// therefore leave it one transaction behind the log, which the tenant's reconcile (design §4.3)
// repairs from the log's own records; it can never leave it ahead, which nothing could repair.
//
// txid and the rolling checksum are u64 and are stored as decimal TEXT: SQLite integers are
// signed and the checksum genuinely uses its top bit. `wal/snapshot.ts` makes the same choice.

import fs from "node:fs"
import path from "node:path"
import { Database } from "../sqlite/index.ts"
import type { RevocationList } from "../server/auth.ts"
import type { RecorderPosition } from "../wal/index.ts"

/** Whether this node authors this database's transactions or receives them (design §5.2). */
export type TenantRole = "primary" | "replica"

/** A tenant as the catalog stores it. */
export interface TenantRow {
  name: string
  createdAtMs: number
  pageSize: number
  /** Storage quota in bytes; 0 means unlimited. */
  quotaBytes: number
  /** When the tenant was deleted, or null while it is live. */
  deletedAtMs: number | null
  epoch: number
  txid: bigint
  /** Rolling database checksum at `txid`. */
  checksum: bigint
  dbSizePages: number
  /** WAL position the recorder had reached: salts and the last confirmed commit frame. */
  walSalt1: number
  walSalt2: number
  walFrame: number
  /** True when the tenant was closed cleanly, so a reopen can skip the expensive reconcile. */
  clean: boolean
  /** `"replica"` for a database this node follows rather than owns. */
  role: TenantRole
  /**
   * Per-database `PRAGMA foreign_keys`, or **null to follow `[sqlite] foreignKeys`**. Three states
   * rather than two: "nobody has said" is not the same fact as "off", and collapsing them would
   * mean a node that turned the switch on could not reach a database created before it did.
   */
  foreignKeys: boolean | null
  /**
   * Per-database `[replication] ackWithoutReplicas`, or **null to follow the node**. The same
   * three states as `foreignKeys`, for the same reason: a node with ten databases and a replica on
   * one of them should not have to answer for all ten the same way (`docs/r8-per-db-ack.md`).
   */
  ackWithoutReplicas: AckWithoutReplicas | null
  /**
   * X2 lineage: the database this one was forked from, or null for one that was created. By
   * name, so it still reads after the parent is deleted — a dangling edge, not a broken row.
   */
  parent: string | null
  /** The parent's txid the fork was taken at (the head at the last `reset`), or null. */
  forkedAt: bigint | null
}

/** What a node — or now one database — does when an ack level it cannot satisfy is asked for. */
export type AckWithoutReplicas = "error" | "allow"

export interface TenantInit {
  name: string
  pageSize: number
  quotaBytes?: number
  epoch?: number
  /** Default `"primary"`. A replica row is created by the replication client, not by a user. */
  role?: TenantRole
  /** Starting position, for a tenant forked from another one. */
  position?: Omit<RecorderPosition, "epoch">
  createdAtMs?: number
  /** Per-database `PRAGMA foreign_keys`; null or absent follows `[sqlite] foreignKeys`. */
  foreignKeys?: boolean | null
  /** Null or absent follows `[replication] ackWithoutReplicas`. */
  ackWithoutReplicas?: AckWithoutReplicas | null
  /** X2: the database this one was forked from, and the parent's txid it was taken at. */
  lineage?: { parent: string; forkedAt: bigint } | null
}

/** A token the node minted, as recorded for revocation and audit. */
export interface TokenRow {
  jti: string
  createdAtMs: number
  /** Expiry in seconds since the epoch, or null for a token that never expires. */
  expiresAtSec: number | null
  revokedAtMs: number | null
  claims: unknown
}

/** A reset caught mid-swap (`Catalog.beginReset`), with everything needed to finish it. */
export interface PendingReset {
  name: string
  /** Where the replacement was built; gone once it has been renamed into place. */
  staging: string
  /** Where the branch's own directory goes. */
  old: string
  pageSize: number
  position: Omit<RecorderPosition, "epoch">
}

export interface SnapshotRow {
  db: string
  txid: bigint
  path: string
  createdAtMs: number
}

const SCHEMA = `
create table if not exists tenants (
  name          text primary key,
  created_at    integer not null,
  page_size     integer not null,
  quota_bytes   integer not null default 0,
  deleted_at    integer,
  epoch         integer not null default 0,
  txid          text    not null default '0',
  checksum      text    not null default '0',
  db_size_pages integer not null default 0,
  wal_salt1     integer not null default 0,
  wal_salt2     integer not null default 0,
  wal_frame     integer not null default 0,
  clean         integer not null default 0,
  role          text    not null default 'primary',
  -- Nullable on purpose: null is "whatever [sqlite] foreignKeys says", which is not the same fact
  -- as "off". A database that has never been told keeps following the node.
  foreign_keys  integer,
  -- Nullable for the same reason: null is "whatever [replication] ackWithoutReplicas says".
  ack_no_replicas text,
  -- X2 lineage. Null for a database that was created rather than forked.
  parent        text,
  forked_at     text
) strict;

-- X2: a reset whose directory swap has begun and whose catalog row is not rewritten yet. Present
-- only across the swap; a row found at open is a crash in it, which \`TenantRegistry\` completes.
create table if not exists resets (
  name          text primary key,
  staging       text    not null,
  old           text    not null,
  page_size     integer not null,
  txid          text    not null,
  checksum      text    not null,
  db_size_pages integer not null
) strict;

create table if not exists tokens (
  jti        text primary key,
  created_at integer not null,
  expires_at integer,
  revoked_at integer,
  claims     text
) strict;

create table if not exists snapshots (
  db         text not null,
  txid       text not null,
  path       text not null,
  created_at integer not null,
  primary key (db, txid)
) strict;
`

interface RawTenant {
  name: string
  created_at: number
  page_size: number
  quota_bytes: number
  deleted_at: number | null
  epoch: number
  txid: string
  checksum: string
  db_size_pages: number
  wal_salt1: number
  wal_salt2: number
  wal_frame: number
  clean: number
  role: string
  foreign_keys: number | null
  ack_no_replicas: string | null
  parent: string | null
  forked_at: string | null
}

function toRow(raw: RawTenant): TenantRow {
  return {
    name: raw.name,
    createdAtMs: raw.created_at,
    pageSize: raw.page_size,
    quotaBytes: raw.quota_bytes,
    deletedAtMs: raw.deleted_at,
    epoch: raw.epoch,
    txid: BigInt(raw.txid),
    checksum: BigInt(raw.checksum),
    dbSizePages: raw.db_size_pages,
    walSalt1: raw.wal_salt1,
    walSalt2: raw.wal_salt2,
    walFrame: raw.wal_frame,
    clean: raw.clean !== 0,
    role: raw.role === "replica" ? "replica" : "primary",
    foreignKeys: raw.foreign_keys === null ? null : raw.foreign_keys !== 0,
    // Only the two values the column is ever written with are honoured; anything else a future
    // version wrote reads as "follow the node", which is the safe direction.
    ackWithoutReplicas:
      raw.ack_no_replicas === "error" || raw.ack_no_replicas === "allow"
        ? raw.ack_no_replicas
        : null,
    parent: raw.parent,
    forkedAt: raw.forked_at === null ? null : BigInt(raw.forked_at),
  }
}

/** Reads the position a tenant should resume from out of its catalog row. */
export function positionOf(row: TenantRow): RecorderPosition {
  return {
    txid: row.txid,
    epoch: row.epoch,
    checksum: row.checksum,
    dbSizePages: row.dbSizePages,
    wal: { salt1: row.walSalt1, salt2: row.walSalt2, frame: row.walFrame },
  }
}

/**
 * Columns added after the first release. `create table if not exists` leaves an existing table
 * alone, so a node that predates the column gets it here, with every existing row defaulted to
 * `"primary"` — which is what every database on a phase-0 node was.
 */
function migrate(db: Database): void {
  const columns = new Set(
    db
      .prepare("select name from pragma_table_info('tenants')")
      .all()
      .map((row) => row.name as string),
  )
  if (!columns.has("role")) {
    db.exec("alter table tenants add column role text not null default 'primary'")
  }
  // Nullable and with no default, so every existing row reads as "follow the node", which is what
  // every database did before there was a per-database setting.
  if (!columns.has("foreign_keys")) {
    db.exec("alter table tenants add column foreign_keys integer")
  }
  // Same again: nullable, no default, so every existing row follows the node.
  if (!columns.has("ack_no_replicas")) {
    db.exec("alter table tenants add column ack_no_replicas text")
  }
  // X2: nullable, so every existing row reads as a database that was created, not forked.
  if (!columns.has("parent")) db.exec("alter table tenants add column parent text")
  if (!columns.has("forked_at")) db.exec("alter table tenants add column forked_at text")
}

export class Catalog implements RevocationList {
  readonly path: string
  readonly db: Database

  /** jti of every revoked token, so `isRevoked` on the request path never touches SQLite. */
  #revoked = new Set<string>()
  #closed = false

  private constructor(dbPath: string, db: Database) {
    this.path = dbPath
    this.db = db
  }

  /** Opens (creating when missing) `<dataDir>/_system.db` and applies the schema. */
  static open(dataDir: string): Catalog {
    fs.mkdirSync(dataDir, { recursive: true })
    const dbPath = path.join(dataDir, "_system.db")
    const db = Database.open(dbPath, { busyTimeoutMs: 5000 })
    try {
      db.exec("pragma synchronous = normal")
      db.exec(SCHEMA)
      migrate(db)
    } catch (err) {
      db.close()
      throw err
    }
    const catalog = new Catalog(dbPath, db)
    catalog.#loadRevocations()
    return catalog
  }

  // ── tenants ──────────────────────────────────────────────────────────────────────────────────

  /** Inserts a tenant, or revives one whose row is tombstoned. Throws when it is already live. */
  createTenant(init: TenantInit): TenantRow {
    this.#assertOpen()
    const existing = this.getTenant(init.name, { includeDeleted: true })
    if (existing && existing.deletedAtMs === null) {
      throw new Error(`database ${init.name} already exists`)
    }
    const position = init.position
    const row: TenantRow = {
      name: init.name,
      createdAtMs: init.createdAtMs ?? Date.now(),
      pageSize: init.pageSize,
      quotaBytes: init.quotaBytes ?? 0,
      deletedAtMs: null,
      epoch: init.epoch ?? 0,
      txid: position?.txid ?? 0n,
      checksum: position?.checksum ?? 0n,
      dbSizePages: position?.dbSizePages ?? 0,
      walSalt1: position?.wal.salt1 ?? 0,
      walSalt2: position?.wal.salt2 ?? 0,
      walFrame: position?.wal.frame ?? 0,
      clean: true,
      role: init.role ?? "primary",
      // A new database follows the node until something says otherwise, and a revived tombstone
      // is a new database: its override does not survive the delete.
      foreignKeys: init.foreignKeys ?? null,
      ackWithoutReplicas: init.ackWithoutReplicas ?? null,
      parent: init.lineage?.parent ?? null,
      forkedAt: init.lineage?.forkedAt ?? null,
    }
    this.db.run(
      `insert into tenants
         (name, created_at, page_size, quota_bytes, deleted_at, epoch, txid, checksum,
          db_size_pages, wal_salt1, wal_salt2, wal_frame, clean, role, foreign_keys,
          ack_no_replicas, parent, forked_at)
       values (?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       on conflict(name) do update set
         created_at = excluded.created_at, page_size = excluded.page_size,
         quota_bytes = excluded.quota_bytes, deleted_at = null, epoch = excluded.epoch,
         txid = excluded.txid, checksum = excluded.checksum,
         db_size_pages = excluded.db_size_pages, wal_salt1 = excluded.wal_salt1,
         wal_salt2 = excluded.wal_salt2, wal_frame = excluded.wal_frame, clean = 1,
         role = excluded.role, foreign_keys = excluded.foreign_keys,
         ack_no_replicas = excluded.ack_no_replicas, parent = excluded.parent,
         forked_at = excluded.forked_at`,
      [
        row.name,
        row.createdAtMs,
        row.pageSize,
        row.quotaBytes,
        row.epoch,
        row.txid.toString(),
        row.checksum.toString(),
        row.dbSizePages,
        row.walSalt1,
        row.walSalt2,
        row.walFrame,
        row.role,
        row.foreignKeys === null ? null : row.foreignKeys ? 1 : 0,
        row.ackWithoutReplicas,
        row.parent,
        row.forkedAt === null ? null : row.forkedAt.toString(),
      ],
    )
    return row
  }

  /**
   * X2 `reset`: the branch now starts again at `position`, forked from its parent at
   * `position.txid`. One statement for the row, and the snapshot rows go with it — their files
   * went to the trash with the old directory. Name, settings, epoch and creation time stay.
   */
  resetTenant(name: string, pageSize: number, position: Omit<RecorderPosition, "epoch">): void {
    this.#assertOpen()
    this.db.exec("begin immediate")
    try {
      this.db.run(
        `update tenants set page_size = ?, txid = ?, checksum = ?, db_size_pages = ?,
           wal_salt1 = ?, wal_salt2 = ?, wal_frame = ?, clean = 1, forked_at = ?
         where name = ? and deleted_at is null`,
        [
          pageSize,
          position.txid.toString(),
          position.checksum.toString(),
          position.dbSizePages,
          position.wal.salt1,
          position.wal.salt2,
          position.wal.frame,
          position.txid.toString(),
          name,
        ],
      )
      this.db.run("delete from snapshots where db = ?", [name])
      // Same transaction as the row: a reset is either pending with the old row, or done.
      this.db.run("delete from resets where name = ?", [name])
      this.db.exec("commit")
    } catch (err) {
      this.db.exec("rollback")
      throw err
    }
  }

  /**
   * Records a reset *before* its first rename, so a crash anywhere in the swap is recognised at
   * the next open rather than leaving a directory the catalog's position does not describe. Fully
   * synchronous: `synchronous = normal` would let a power cut keep the renames and lose this row.
   */
  beginReset(reset: PendingReset): void {
    this.#assertOpen()
    this.db.exec("pragma synchronous = full")
    try {
      this.db.run(
        `insert or replace into resets
           (name, staging, old, page_size, txid, checksum, db_size_pages)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          reset.name,
          reset.staging,
          reset.old,
          reset.pageSize,
          reset.position.txid.toString(),
          reset.position.checksum.toString(),
          reset.position.dbSizePages,
        ],
      )
    } finally {
      this.db.exec("pragma synchronous = normal")
    }
  }

  /** The reset caught mid-swap for this database, or null — which is every database, normally. */
  pendingReset(name: string): PendingReset | null {
    this.#assertOpen()
    const raw = this.db.prepare("select * from resets where name = ?").get(name)
    if (!raw) return null
    return {
      name: raw.name as string,
      staging: raw.staging as string,
      old: raw.old as string,
      pageSize: raw.page_size as number,
      position: {
        txid: BigInt(raw.txid as string),
        checksum: BigInt(raw.checksum as string),
        dbSizePages: raw.db_size_pages as number,
        wal: { salt1: 0, salt2: 0, frame: 0 },
      },
    }
  }

  /** Forgets a reset that never moved anything; the branch's row and files still agree. */
  abandonReset(name: string): void {
    this.#assertOpen()
    this.db.run("delete from resets where name = ?", [name])
  }

  /** Switches a database between primary and replica mode, for bootstrap and for promotion. */
  setRole(name: string, role: TenantRole): void {
    this.#assertOpen()
    this.db.run("update tenants set role = ? where name = ?", [role, name])
  }

  /**
   * Per-database `PRAGMA foreign_keys`. `null` clears the override and the database follows
   * `[sqlite] foreignKeys` again.
   *
   * The pragma is per *connection*, so the caller has to release the tenant for the new value to
   * be reached — `TenantRegistry.setForeignKeys` is the entry point that does both.
   */
  setForeignKeys(name: string, value: boolean | null): void {
    this.#assertOpen()
    this.db.run("update tenants set foreign_keys = ? where name = ?", [
      value === null ? null : value ? 1 : 0,
      name,
    ])
  }

  /**
   * Per-database `[replication] ackWithoutReplicas`. `null` clears the override and the database
   * follows the node again.
   *
   * Unlike `foreign_keys` this is not a connection property: it is read at ack time, so no tenant
   * has to be released for the new value to be reached (`docs/r8-per-db-ack.md`).
   */
  setAckWithoutReplicas(name: string, value: AckWithoutReplicas | null): void {
    this.#assertOpen()
    this.db.run("update tenants set ack_no_replicas = ? where name = ?", [value, name])
  }

  getTenant(name: string, options: { includeDeleted?: boolean } = {}): TenantRow | null {
    this.#assertOpen()
    const raw = this.db.prepare("select * from tenants where name = ?").get(name)
    if (!raw) return null
    const row = toRow(raw as unknown as RawTenant)
    if (row.deletedAtMs !== null && options.includeDeleted !== true) return null
    return row
  }

  /** Every live tenant, by name. Pass `includeDeleted` to see tombstones too. */
  listTenants(options: { includeDeleted?: boolean } = {}): TenantRow[] {
    this.#assertOpen()
    const sql =
      options.includeDeleted === true
        ? "select * from tenants order by name"
        : "select * from tenants where deleted_at is null order by name"
    return this.db
      .prepare(sql)
      .all()
      .map((raw) => toRow(raw as unknown as RawTenant))
  }

  /** Tombstones a tenant. The files are the registry's to move; the row stays for audit. */
  deleteTenant(name: string, atMs = Date.now()): boolean {
    this.#assertOpen()
    const result = this.db.run("update tenants set deleted_at = ? where name = ? and deleted_at is null", [
      atMs,
      name,
    ])
    return Number(result.changes) > 0
  }

  /** Removes the row and everything filed under it. Used by tests and `bql db purge`. */
  purgeTenant(name: string): void {
    this.#assertOpen()
    this.db.run("delete from snapshots where db = ?", [name])
    this.db.run("delete from resets where name = ?", [name])
    this.db.run("delete from tenants where name = ?", [name])
  }

  // ── positions ────────────────────────────────────────────────────────────────────────────────

  /** Persists the recorder position reached by the last logged transaction. */
  savePosition(name: string, position: RecorderPosition, clean = false): void {
    this.#assertOpen()
    this.db.run(
      `update tenants set epoch = ?, txid = ?, checksum = ?, db_size_pages = ?,
         wal_salt1 = ?, wal_salt2 = ?, wal_frame = ?, clean = ?
       where name = ?`,
      [
        position.epoch,
        position.txid.toString(),
        position.checksum.toString(),
        position.dbSizePages,
        position.wal.salt1,
        position.wal.salt2,
        position.wal.frame,
        clean ? 1 : 0,
        name,
      ],
    )
  }

  /** The saved position, or null when the tenant has no row. */
  loadPosition(name: string): RecorderPosition | null {
    const row = this.getTenant(name, { includeDeleted: true })
    return row ? positionOf(row) : null
  }

  /** Clears the clean-shutdown flag, which is how the next crash becomes detectable. */
  markOpen(name: string): void {
    this.#assertOpen()
    this.db.run("update tenants set clean = 0 where name = ?", [name])
  }

  setEpoch(name: string, epoch: number): void {
    this.#assertOpen()
    this.db.run("update tenants set epoch = ? where name = ?", [epoch, name])
  }

  // ── snapshots ────────────────────────────────────────────────────────────────────────────────

  recordSnapshot(db: string, txid: bigint, snapshotPath: string, createdAtMs = Date.now()): void {
    this.#assertOpen()
    this.db.run(
      `insert into snapshots (db, txid, path, created_at) values (?, ?, ?, ?)
       on conflict(db, txid) do update set path = excluded.path, created_at = excluded.created_at`,
      [db, txid.toString(), snapshotPath, createdAtMs],
    )
  }

  listSnapshotRows(db: string): SnapshotRow[] {
    this.#assertOpen()
    return this.db
      .prepare("select * from snapshots where db = ? order by created_at")
      .all(db)
      .map((raw) => ({
        db: raw.db as string,
        txid: BigInt(raw.txid as string),
        path: raw.path as string,
        createdAtMs: raw.created_at as number,
      }))
      .sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0))
  }

  /** Newest snapshot txid for a tenant, or null when it has none. */
  lastSnapshotTxid(db: string): bigint | null {
    const rows = this.listSnapshotRows(db)
    return rows.length === 0 ? null : (rows.at(-1) as SnapshotRow).txid
  }

  removeSnapshotRow(db: string, txid: bigint): void {
    this.#assertOpen()
    this.db.run("delete from snapshots where db = ? and txid = ?", [db, txid.toString()])
  }

  // ── tokens ───────────────────────────────────────────────────────────────────────────────────

  /** Records a minted token so it can be revoked later. */
  putToken(token: {
    jti: string
    claims?: unknown
    expiresAtSec?: number | null
    createdAtMs?: number
  }): void {
    this.#assertOpen()
    this.db.run(
      `insert into tokens (jti, created_at, expires_at, revoked_at, claims)
       values (?, ?, ?, null, ?)
       on conflict(jti) do update set expires_at = excluded.expires_at, claims = excluded.claims`,
      [
        token.jti,
        token.createdAtMs ?? Date.now(),
        token.expiresAtSec ?? null,
        token.claims === undefined ? null : JSON.stringify(token.claims),
      ],
    )
  }

  /** Revokes a token, recording it even when the token itself was never stored. */
  revokeToken(jti: string, atMs = Date.now()): void {
    this.#assertOpen()
    this.db.run(
      `insert into tokens (jti, created_at, expires_at, revoked_at, claims)
       values (?, ?, null, ?, null)
       on conflict(jti) do update set revoked_at = excluded.revoked_at`,
      [jti, atMs, atMs],
    )
    this.#revoked.add(jti)
  }

  restoreToken(jti: string): void {
    this.#assertOpen()
    this.db.run("update tokens set revoked_at = null where jti = ?", [jti])
    this.#revoked.delete(jti)
  }

  /** `RevocationList` for `src/server/auth.ts`; answered from memory, never from disk. */
  isRevoked(jti: string): boolean {
    return this.#revoked.has(jti)
  }

  get revokedCount(): number {
    return this.#revoked.size
  }

  getToken(jti: string): TokenRow | null {
    this.#assertOpen()
    const raw = this.db.prepare("select * from tokens where jti = ?").get(jti)
    if (!raw) return null
    const claims = raw.claims as string | null
    return {
      jti: raw.jti as string,
      createdAtMs: raw.created_at as number,
      expiresAtSec: (raw.expires_at as number | null) ?? null,
      revokedAtMs: (raw.revoked_at as number | null) ?? null,
      claims: claims === null ? null : JSON.parse(claims),
    }
  }

  /** Drops revoked entries whose token has expired anyway; they can no longer be presented. */
  purgeExpiredTokens(nowSec = Math.floor(Date.now() / 1000)): number {
    this.#assertOpen()
    const result = this.db.run("delete from tokens where expires_at is not null and expires_at <= ?", [
      nowSec,
    ])
    this.#loadRevocations()
    return Number(result.changes)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.db.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  #loadRevocations(): void {
    this.#revoked = new Set(
      this.db
        .prepare("select jti from tokens where revoked_at is not null")
        .all()
        .map((row) => row.jti as string),
    )
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("catalog is closed")
  }
}
