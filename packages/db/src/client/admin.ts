// The control plane of design §6.5, as methods rather than as hand-written fetch calls:
// `client.admin.create("acme")` instead of a `POST /v1/db` a caller builds, and the same
// `BqlClientError` on the way back out.
//
// Invariant: every request here goes through the same `HttpClient` a statement does, so the token,
// the headers and the error mapping of §6.6 stay in the one place `http.ts` claims them.
//
// Second invariant (C2): **no admin request is ever replayed against another node.** `http.ts`
// allows one replay on `NOT_PRIMARY`, and only where the caller opts in; admin never does.
// `promote` addresses the node that should become the primary, `snapshot` and `checkpoint` are
// node-local, and an operator who typed a URL meant that URL. A `NOT_PRIMARY` therefore reaches
// the caller as a throw whose `.primary` names where to go instead.
//
// `docs/m9-client-admin.md` is the plan of record.

import { BqlClientError } from "./errors.ts"
import { HttpClient, readJson, type RawBody } from "./http.ts"
import { HEADERS } from "./protocol.ts"
import type {
  BackupGenerations,
  BackupStatus,
  BackupVerification,
  CheckpointMode,
  CheckpointResult,
  ClusterView,
  CreateDatabaseOptions,
  DatabaseDump,
  DatabaseInfo,
  DatabaseSettings,
  DatabaseStats,
  DeleteResult,
  MintedToken,
  PromoteResult,
  ReplicationStatus,
  RestoreOptions,
  RestoreResult,
  Revision,
  RevokedToken,
  S3RestoreResult,
  SnapshotInfo,
  TokenOptions,
  VerifyBackupOptions,
} from "./protocol.ts"

/** A SQLite file on its way into `POST /v1/db/{db}/import`. */
export type FileBody = Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>

/** A database name in a path. Valid names encode to themselves; anything else cannot escape. */
function seg(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw BqlClientError.client("a database name is required")
  }
  return encodeURIComponent(name)
}

/**
 * The admin routes of design §6.5, reached through `client.admin`. Every one of them needs the
 * admin key, except `stat` and `replication`, which a read token can also see.
 */
export class Admin {
  #http: HttpClient

  constructor(http: HttpClient) {
    this.#http = http
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  /** Every database on this node. */
  async list(): Promise<DatabaseInfo[]> {
    const body = await this.#http.json<{ databases: DatabaseInfo[] }>("/v1/db")
    return body.databases
  }

  /** Create a database, or — with `from` — fork one, which is O(1) where the filesystem reflinks. */
  create(name: string, options: CreateDatabaseOptions = {}): Promise<DatabaseStats> {
    return this.#http.json<DatabaseStats>("/v1/db", {
      method: "POST",
      body: {
        name,
        ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
        ...(options.quotaBytes !== undefined ? { quotaBytes: options.quotaBytes } : {}),
        ...(options.from
          ? {
              from: {
                db: options.from.db,
                ...(options.from.at !== undefined ? { at: options.from.at } : {}),
              },
            }
          : {}),
      },
    })
  }

  /** `at` is a txid or an instant, so a fork can be taken from a point in the past. */
  fork(name: string, from: string, at?: Revision): Promise<DatabaseStats> {
    return this.create(name, { from: { db: from, ...(at !== undefined ? { at } : {}) } })
  }

  /**
   * Puts a branch back to its parent's head, under the same name (`docs/x2-branching.md`).
   * Refused for a database that was created rather than forked, or whose parent was deleted.
   */
  reset(db: string): Promise<DatabaseStats> {
    return this.#http.json<DatabaseStats>(`/v1/db/${seg(db)}/reset`, { method: "POST" })
  }

  /** Size, position, subscribers and replicas. A read token can see this one. */
  stat(db: string): Promise<DatabaseStats> {
    return this.#http.json<DatabaseStats>(`/v1/db/${seg(db)}`)
  }

  /** Change one database's settings. Null on a field follows the node's config again. */
  configure(db: string, settings: DatabaseSettings): Promise<DatabaseStats> {
    return this.#http.json<DatabaseStats>(`/v1/db/${seg(db)}`, {
      method: "PATCH",
      body: settings,
    })
  }

  /** Moves the database to the trash, which `[durability] retention` sweeps. */
  delete(db: string): Promise<DeleteResult> {
    return this.#http.json<DeleteResult>(`/v1/db/${seg(db)}`, { method: "DELETE" })
  }

  /** Force a snapshot. A node that neither ships nor serves a replica takes none on its own. */
  snapshot(db: string): Promise<SnapshotInfo> {
    return this.#http.json<SnapshotInfo>(`/v1/db/${seg(db)}/snapshot`, { method: "POST" })
  }

  /**
   * Point-in-time restore, from the local log or — with `from: "s3"` — from the backup bucket.
   * Always into a **new** database: the log behind this one still describes the timeline it had.
   */
  restore(db: string, options: RestoreOptions & { from: "s3" }): Promise<S3RestoreResult>
  restore(db: string, options?: RestoreOptions): Promise<RestoreResult>
  restore(db: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    return this.#http.json<RestoreResult>(`/v1/db/${seg(db)}/restore`, {
      method: "POST",
      body: { ...options },
    })
  }

  /** Checkpoint the WAL. `TRUNCATE` and `RESTART` need the database quiet. */
  checkpoint(db: string, mode: CheckpointMode = "PASSIVE"): Promise<CheckpointResult> {
    return this.#http.json<CheckpointResult>(`/v1/db/${seg(db)}/checkpoint`, {
      method: "POST",
      body: { mode },
    })
  }

  /** The SQLite file, as of a snapshot taken now, with the txid it is consistent at. */
  async dump(db: string): Promise<DatabaseDump> {
    const path = `/v1/db/${seg(db)}/dump`
    const response = await this.#http.send(path)
    // `readJson` throws the server's own error; a body it never returns from is not read here,
    // because the successful answer is the file itself.
    if (!response.ok) await readJson(response, `GET ${path}`)
    if (!response.body) throw BqlClientError.client(`${path} answered without a body`)
    const length = response.headers.get("content-length")
    return {
      txid: Number(response.headers.get(HEADERS.txid) ?? 0),
      bytes: length === null ? null : Number(length),
      stream: response.body,
    }
  }

  /** Create a database from a raw SQLite file. The name must not exist. */
  import(name: string, file: FileBody): Promise<DatabaseStats> {
    return this.#http.json<DatabaseStats>(`/v1/db/${seg(name)}/import`, {
      method: "POST",
      raw: file as RawBody,
      headers: { "content-type": "application/vnd.sqlite3" },
    })
  }

  // ── replication and the cluster ──────────────────────────────────────────────────────────────

  /** Where this database is and who is following it. The shape differs by role. */
  replication(db: string): Promise<ReplicationStatus> {
    return this.#http.json<ReplicationStatus>(`/v1/db/${seg(db)}/replication`)
  }

  /**
   * Make the node this client addresses the primary for one database (C2). The URL is the
   * candidate, not the cluster: the promotion is this node's own copy being accepted.
   */
  promote(db: string, options: { force?: boolean } = {}): Promise<PromoteResult> {
    return this.#http.json<PromoteResult>(`/v1/db/${seg(db)}/promote`, {
      method: "POST",
      body: { force: options.force === true },
    })
  }

  /** The control plane's observable state: the leader, the members and each database's lease. */
  cluster(): Promise<ClusterView> {
    return this.#http.json<ClusterView>("/v1/cluster")
  }

  // ── backup ───────────────────────────────────────────────────────────────────────────────────

  /** The shipper's position and what the bucket holds. */
  backup(db: string): Promise<BackupStatus> {
    return this.#http.json<BackupStatus>(`/v1/db/${seg(db)}/backup`)
  }

  /** Can the bucket restore to a point? Writes nothing. */
  verifyBackup(db: string, options: VerifyBackupOptions = {}): Promise<BackupVerification> {
    return this.#http.json<BackupVerification>(`/v1/db/${seg(db)}/backup/verify`, {
      method: "POST",
      body: { ...options },
    })
  }

  /** The timelines the bucket holds for this database, newest first. */
  generations(db: string): Promise<BackupGenerations> {
    return this.#http.json<BackupGenerations>(`/v1/db/${seg(db)}/backup/generations`)
  }

  // ── tokens ───────────────────────────────────────────────────────────────────────────────────

  /** Mint a scoped token. `dbs` takes globs; `tables` narrows it further, per table. */
  mintToken(options: TokenOptions): Promise<MintedToken> {
    const dbs = options.dbs ?? (options.db !== undefined ? [options.db] : [])
    if (dbs.length === 0) {
      throw BqlClientError.client("a token needs at least one database or glob in `dbs`")
    }
    return this.#http.json<MintedToken>("/v1/tokens", {
      method: "POST",
      body: {
        dbs,
        scope: options.scope ?? "ro",
        ...(options.tables ? { tables: options.tables } : {}),
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options.sub !== undefined ? { sub: options.sub } : {}),
      },
    })
  }

  /** Revoke one by its `jti`. The revocation is the node's, and replicates with the catalog. */
  revokeToken(jti: string): Promise<RevokedToken> {
    return this.#http.json<RevokedToken>(`/v1/tokens/${encodeURIComponent(jti)}`, {
      method: "DELETE",
    })
  }
}
