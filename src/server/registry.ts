// Invariant: this file is the **only** place a `/v1` route exists. `src/server/app.ts` builds the
// `Bun.serve` table from it and `GET /v1/openapi.json` emits the document from it, so the route
// table and the published description cannot drift — which is the whole of `docs/plan-surfaces.md`
// milestone H6 and what `docs/h6-mount.md` is the plan of record for.
//
// What an operation here supplies is **routing and description, not the request pipeline.** Each
// `handler` is the `Handler` from `src/server/routes.ts`, unchanged, taking the `RouteContext`
// `app.ts` builds; it parses its own body exactly as it did before this file existed. The reason
// is stated in `docs/h6-mount.md` decision 1 and it is concrete: `app.ts`'s `wrap()` is the one
// place the four `BunQL-*` headers, CORS, the metrics tick and C2's same-origin `307` are applied,
// and the `307` has to know *which error code* a handler refused with — while `compileOperation`
// in `src/http/handler.ts` deliberately turns that error into a `Response`. Mounting through
// `mountRegistry` would therefore stop a promoted-away database redirecting. So `app.ts` mounts
// these with its own wrapper, and the generated data API — which needs the coercion and gets no
// `307` — goes through the real `src/http/` pipeline in `src/server/surfaces.ts`.
//
// Consequence, said plainly: the request schemas below are published and are *not* enforced by
// core's validator. They are written from the handler each describes and
// `test/server/registry.test.ts` checks the live answers against the response schemas, so a lie
// fails a test rather than living in the document. Migrating the handlers onto the validated
// pipeline is follow-up work, named in `docs/next.md`.
//
// `src/server/hrana/` stays out: `/v2/pipeline` carries libsql's RPC envelope, not BunQL's API,
// and an OpenAPI document of one opaque envelope helps nobody. `app.ts` mounts it separately.

import { type Operation, Registry, s, type Schema } from "../core/index.ts"
import { buildDocument } from "../openapi/index.ts"
import type { Handler, RouteContext } from "./routes.ts"
import * as handlers from "./routes.ts"
import type { Surfaces } from "./surfaces.ts"
import { VERSION } from "./surfaces.ts"

/** The version published in `GET /v1/openapi.json`. */
export const API_VERSION = VERSION

/** A route handler dressed as an operation handler. The input is unused: see the module header. */
type ServerOperation = Operation<unknown, unknown, RouteContext>

// ── shared schemas ─────────────────────────────────────────────────────────────────────────────

const Value = s.sqliteValue()

/** Positional or named parameters, as design §6.1 puts them on the wire. */
const Args = s
  .union([s.array(Value), s.record(Value)])
  .describe("Positional parameters as an array, or named ones as an object.")
  .id("Args")

const Statement = s
  .object({ sql: s.string(), args: Args.optional() })
  .id("Statement")

/** The `BunQL-*` options of design §6, which every statement route accepts in its body. */
const options = {
  ack: s.enum(["local", "fsync", "replica", "quorum"] as const).optional(),
  minTxid: s.int().optional(),
  consistency: s.enum(["primary", "any", "ryw"] as const).optional(),
  timeoutMs: s.int().optional(),
  rows: s.enum(["array", "object"] as const).optional(),
  maxRows: s.int().optional(),
}

const QueryResult = s
  .object({
    columns: s.array(s.string()),
    types: s.array(s.string()),
    rows: s.array(s.union([s.array(Value), s.record(Value)])),
    rowsAffected: s.int(),
    lastInsertRowid: s.union([s.int64(), s.null()]),
    txid: s.int(),
    durationUs: s.int(),
    vmSteps: s.int(),
  })
  .id("QueryResult")

const DbStats = s
  .object({
    name: s.string(),
    role: s.string(),
    sizeBytes: s.int(),
    walBytes: s.int(),
    logBytes: s.int(),
    txid: s.int(),
    epoch: s.int(),
    checksum: s.string().describe("The rolling database checksum, as a decimal string."),
    openConns: s.int(),
    liveQueries: s.int(),
    subscribers: s.int(),
    lastSnapshotTxid: s.union([s.int(), s.null()]),
    replicas: s.array(
      s.object({ node: s.string(), txid: s.int(), lag: s.int() }),
    ),
  })
  .id("DbStats")

const RowChange = s
  .object({
    op: s.enum(["insert", "update", "delete"] as const),
    table: s.string(),
    pk: s.array(Value).optional(),
    row: s.record(Value).optional(),
    old: s.record(Value).optional(),
  })
  .id("RowChange")

const ChangeEvent = s
  .object({
    txid: s.int(),
    atMs: s.int(),
    changes: s.array(RowChange),
  })
  .id("ChangeEvent")

/** Errors any authenticated route can produce, before it has done anything of its own. */
const COMMON = ["BAD_REQUEST", "UNAUTHENTICATED", "NOT_AUTHORIZED"] as const
/** Those, plus the ones that come from naming a database. */
const ON_DB = [...COMMON, "DB_NOT_FOUND"] as const
/**
 * Those, plus the ones a statement can raise. The `SQLITE_*` names are here because SQLite's own
 * diagnostics travel in `error.code` as well as BunQL's — `src/openapi/errors.ts` maps them
 * through the real `mapError()`, so `SQLITE_CONSTRAINT` documents the 409 a unique index answers.
 */
const ON_STATEMENT = [
  ...ON_DB,
  "SQLITE_ERROR",
  "SQLITE_CONSTRAINT",
  "QUERY_TIMEOUT",
  "TOO_MANY_ROWS",
  "PAYLOAD_TOO_LARGE",
  "TXID_NOT_AVAILABLE",
  "BUSY",
  "NOT_PRIMARY",
  "ACK_TIMEOUT",
  "NO_REPLICAS",
  "FORWARD_TIMEOUT",
  "QUOTA_EXCEEDED",
] as const

/** An answer this file does not describe field by field, because its shape is the subsystem's. */
function opaque(what: string): Schema {
  return s.record(s.unknown()).describe(what)
}

// ── the operations ─────────────────────────────────────────────────────────────────────────────

interface Spec {
  id: string
  method: ServerOperation["method"]
  path: string
  summary: string
  description?: string
  tags: string[]
  security: "bearer" | "admin" | "none"
  query?: Schema
  body?: Schema
  /**
   * Whether the body may be left out. Default false: most of these read a required field out of
   * it. The handlers accept an empty body and default it, so this is the document telling the
   * truth about what a *useful* request carries, not a gate (see the module header).
   */
  bodyOptional?: boolean
  /** Default 200. */
  status?: number
  response: Schema
  responseType?: string
  errors: readonly string[]
  handler: Handler
}

function define(spec: Spec): ServerOperation {
  const bound = spec.path.includes("/:")
  return {
    id: spec.id,
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    tags: spec.tags,
    security: spec.security,
    // None of these renders in GraphQL: `src/graphql/` generates a schema for a *database*, from
    // the data API's document, and never from this registry (`docs/plan-surfaces.md`).
    graphql: { kind: "none" },
    params: {
      ...(bound ? { path: pathSchemaFor(spec.path) } : {}),
      ...(spec.query ? { query: spec.query } : {}),
    },
    ...(spec.body ? { body: { schema: spec.body, required: spec.bodyOptional !== true } } : {}),
    response: {
      ...(spec.status !== undefined ? { status: spec.status } : {}),
      schema: spec.response,
      ...(spec.responseType ? { contentType: spec.responseType } : {}),
    },
    errors: [...spec.errors],
    handler: (_input: unknown, ctx: RouteContext) => spec.handler(ctx),
  }
}

/** `Registry.add` refuses a path parameter nothing declares, so the declaration is derived. */
function pathSchemaFor(path: string): Schema {
  const props: Record<string, Schema> = {}
  for (const segment of path.split("/")) {
    if (segment.startsWith(":")) props[segment.slice(1)] = s.string()
  }
  return s.object(props)
}

const statementBody = s.object({ sql: s.string(), args: Args.optional(), ...options })

const SPECS: Spec[] = [
  // ── statements ──────────────────────────────────────────────────────────────────────────────
  {
    id: "query",
    method: "post",
    path: "/v1/db/:db/query",
    summary: "Run one statement",
    description:
      "Design §6.1. On a replica a statement SQLite classifies as a write is forwarded to the " +
      "primary and its result comes back; a read never leaves the node.",
    tags: ["statements"],
    security: "bearer",
    body: statementBody,
    response: QueryResult,
    errors: ON_STATEMENT,
    handler: handlers.query,
  },
  {
    id: "batch",
    method: "post",
    path: "/v1/db/:db/batch",
    summary: "Run several statements",
    description:
      "Design §6.2. `atomic` (the default) is one transaction that rolls back as a whole and " +
      "carries one txid; `failedIndex` names the statement that failed either way.",
    tags: ["statements"],
    security: "bearer",
    body: s.object({ statements: s.array(Statement), atomic: s.boolean().optional(), ...options }),
    response: s.object({ results: s.array(QueryResult), txid: s.int() }),
    errors: ON_STATEMENT,
    handler: handlers.batch,
  },
  {
    id: "txBegin",
    bodyOptional: true,
    method: "post",
    path: "/v1/db/:db/tx",
    summary: "Open an interactive transaction",
    tags: ["transactions"],
    security: "bearer",
    body: s.object({
      mode: s.enum(["deferred", "immediate", "exclusive"] as const).optional(),
      ...options,
    }),
    response: s.object({ tx: s.string(), expiresInMs: s.int() }),
    errors: [...ON_DB, "TX_BUSY", "NOT_PRIMARY", "BUSY"],
    handler: handlers.txBegin,
  },
  {
    id: "txQuery",
    method: "post",
    path: "/v1/db/:db/tx/:tx",
    summary: "Run a statement inside an open transaction",
    tags: ["transactions"],
    security: "bearer",
    body: statementBody,
    response: QueryResult,
    errors: [...ON_STATEMENT, "TX_NOT_FOUND"],
    handler: handlers.txQuery,
  },
  {
    id: "txCommit",
    method: "post",
    path: "/v1/db/:db/tx/:tx/commit",
    summary: "Commit an open transaction",
    tags: ["transactions"],
    security: "bearer",
    response: s.object({ txid: s.int() }),
    errors: [...ON_DB, "TX_NOT_FOUND", "NOT_PRIMARY", "ACK_TIMEOUT", "NO_REPLICAS"],
    handler: handlers.txCommit,
  },
  {
    id: "txRollback",
    method: "post",
    path: "/v1/db/:db/tx/:tx/rollback",
    summary: "Roll an open transaction back",
    tags: ["transactions"],
    security: "bearer",
    response: s.object({ txid: s.int() }),
    errors: [...ON_DB, "TX_NOT_FOUND"],
    handler: handlers.txRollback,
  },

  // ── realtime ────────────────────────────────────────────────────────────────────────────────
  {
    id: "changes",
    method: "get",
    path: "/v1/db/:db/changes",
    summary: "The change feed",
    description:
      "Design §6.4. Server-sent events by default; `?wait=<ms>` turns it into a long poll that " +
      "answers with a JSON array, which is what an HTTP-only client or a CDN in front of one " +
      "gets. `Last-Event-ID` resumes from the ring.",
    tags: ["realtime"],
    security: "bearer",
    query: s.object({
      since: s.int().optional(),
      tables: s.string().optional().describe("Comma-separated table names."),
      include: s.enum(["none", "pk", "row", "row+old"] as const).optional(),
      wait: s.int().optional().describe("Long-poll instead of streaming, up to 60000 ms."),
    }),
    response: s.array(ChangeEvent),
    responseType: "text/event-stream",
    errors: [...ON_DB, "RESET_REQUIRED"],
    handler: handlers.changes,
  },
  {
    id: "live",
    method: "get",
    path: "/v1/db/:db/live",
    summary: "A live query, as server-sent events",
    description:
      "Re-runs `sql` whenever a commit touches a table it reads and sends the rows, or a diff " +
      "against what it last sent.",
    tags: ["realtime"],
    security: "bearer",
    query: s.object({
      sql: s.string(),
      args: s.string().optional().describe("A JSON array or object."),
      key: s.string().optional().describe("Primary-key column, which turns rows into diffs."),
      rows: s.enum(["array", "object"] as const).optional(),
      maxRows: s.int().optional(),
    }),
    response: opaque("A `rows` or `diff` event; see design §6.4."),
    responseType: "text/event-stream",
    errors: [...ON_DB, "TOO_MANY_ROWS", "QUERY_TIMEOUT"],
    handler: handlers.live,
  },

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────
  {
    id: "listDatabases",
    method: "get",
    path: "/v1/db",
    summary: "Every database on this node",
    tags: ["lifecycle"],
    security: "admin",
    response: s.object({
      databases: s.array(
        s.object({
          name: s.string(),
          createdAtMs: s.int(),
          pageSize: s.int(),
          quotaBytes: s.int(),
          epoch: s.int(),
          role: s.string(),
          txid: s.int(),
          open: s.boolean(),
        }),
      ),
    }),
    errors: COMMON,
    handler: handlers.listDbs,
  },
  {
    id: "createDatabase",
    method: "post",
    path: "/v1/db",
    summary: "Create a database",
    description: "`from` forks an existing one, optionally as of a txid or an instant.",
    tags: ["lifecycle"],
    security: "admin",
    body: s.object({
      name: s.string(),
      pageSize: s.int().optional(),
      quotaBytes: s.int().optional(),
      from: s
        .object({ db: s.string(), at: s.union([s.int(), s.string()]).optional() })
        .optional(),
    }),
    status: 201,
    response: DbStats,
    errors: [...COMMON, "CONFLICT", "NOT_PRIMARY", "DB_NOT_FOUND"],
    handler: handlers.createDb,
  },
  {
    id: "statDatabase",
    method: "get",
    path: "/v1/db/:db",
    summary: "One database's size, position and subscribers",
    tags: ["lifecycle"],
    security: "bearer",
    response: DbStats,
    errors: ON_DB,
    handler: handlers.statDb,
  },
  {
    id: "deleteDatabase",
    method: "delete",
    path: "/v1/db/:db",
    summary: "Delete a database",
    description: "Moves it to the trash, which `[durability] retention` sweeps.",
    tags: ["lifecycle"],
    security: "admin",
    response: s.object({ name: s.string(), deleted: s.boolean(), trash: s.string() }),
    errors: [...ON_DB, "NOT_PRIMARY"],
    handler: handlers.deleteDb,
  },
  {
    id: "dumpDatabase",
    method: "get",
    path: "/v1/db/:db/dump",
    summary: "Stream the database file out",
    description: "As of a snapshot taken now; `BunQL-Txid` is the txid it is consistent at.",
    tags: ["lifecycle"],
    security: "admin",
    response: s.string().describe("The raw SQLite file."),
    responseType: "application/vnd.sqlite3",
    errors: ON_DB,
    handler: handlers.dumpDb,
  },
  {
    id: "importDatabase",
    method: "post",
    path: "/v1/db/:db/import",
    summary: "Create a database from a raw SQLite file",
    tags: ["lifecycle"],
    security: "admin",
    body: s.string().describe("The raw SQLite file."),
    status: 201,
    response: DbStats,
    errors: [...COMMON, "CONFLICT", "PAYLOAD_TOO_LARGE", "NOT_PRIMARY"],
    handler: handlers.importDb,
  },
  {
    id: "snapshotDatabase",
    method: "post",
    path: "/v1/db/:db/snapshot",
    summary: "Take a local snapshot",
    tags: ["lifecycle"],
    security: "admin",
    response: s.object({
      snapshotId: s.string(),
      txid: s.int(),
      bytes: s.int(),
      checksum: s.string(),
      createdAtMs: s.int(),
    }),
    errors: ON_DB,
    handler: handlers.snapshotDb,
  },
  {
    id: "restoreDatabase",
    bodyOptional: true,
    method: "post",
    path: "/v1/db/:db/restore",
    summary: "Point-in-time restore, into a new database",
    description:
      "From the local log, or from the bucket with `from: \"s3\"`. Always into a new database: " +
      "the log behind this one still describes the timeline it actually had.",
    tags: ["lifecycle"],
    security: "admin",
    body: s.object({
      at: s.union([s.int(), s.string()]).optional(),
      into: s.string().optional(),
      from: s.string().optional(),
      bucket: s.string().optional(),
      prefix: s.string().optional(),
      generation: s.string().optional(),
    }),
    status: 201,
    response: opaque("The database created, its txid and where it was restored from."),
    errors: [...ON_DB, "CONFLICT", "NOT_PRIMARY"],
    handler: handlers.restoreDb,
  },
  {
    id: "checkpointDatabase",
    bodyOptional: true,
    method: "post",
    path: "/v1/db/:db/checkpoint",
    summary: "Checkpoint the WAL",
    tags: ["lifecycle"],
    security: "admin",
    body: s.object({
      mode: s.enum(["PASSIVE", "FULL", "RESTART", "TRUNCATE"] as const).optional(),
    }),
    response: opaque("The mode run, the frames it moved and the WAL size afterwards."),
    errors: [...ON_DB, "BUSY"],
    handler: handlers.checkpointDb,
  },

  // ── replication and the cluster ──────────────────────────────────────────────────────────────
  {
    id: "replicationStatus",
    method: "get",
    path: "/v1/db/:db/replication",
    summary: "Where this database is, and who is following it",
    description:
      "The shape differs by role: a primary lists its replicas, a replica reports where it " +
      "follows from and how far behind it is. The bucket's position is here too.",
    tags: ["replication"],
    security: "bearer",
    response: opaque("The role-dependent replication view of design §6.5."),
    errors: ON_DB,
    handler: handlers.replication,
  },
  {
    id: "promoteDatabase",
    bodyOptional: true,
    method: "post",
    path: "/v1/db/:db/promote",
    summary: "Make this node the primary for one database",
    description:
      "C2. A refusal changes nothing; the decision is taken on the Raft leader against the " +
      "leader's own clock. `force` overrides exactly three refusals.",
    tags: ["replication"],
    security: "admin",
    body: s.object({ force: s.boolean().optional() }),
    response: s.object({
      db: s.string(),
      promoted: s.boolean(),
      role: s.string(),
      epoch: s.int(),
      txid: s.int(),
      why: s.string(),
    }),
    errors: [...ON_DB, "CONFLICT", "NOT_PRIMARY", "BUSY"],
    handler: handlers.promoteDb,
  },
  {
    id: "clusterView",
    method: "get",
    path: "/v1/cluster",
    summary: "The control plane's observable state",
    tags: ["cluster"],
    security: "admin",
    response: opaque("The raft view: the leader, the members and each database's lease."),
    errors: [...COMMON, "CLUSTER_DISABLED"],
    handler: handlers.cluster,
  },

  // ── backup ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "backupStatus",
    method: "get",
    path: "/v1/db/:db/backup",
    summary: "The shipper's position, and what the bucket holds",
    tags: ["backup"],
    security: "admin",
    response: opaque("The shipper state and the bucket manifest, or `enabled: false`."),
    errors: ON_DB,
    handler: handlers.backupStatus,
  },
  {
    id: "backupVerify",
    bodyOptional: true,
    method: "post",
    path: "/v1/db/:db/backup/verify",
    summary: "Is the bucket restorable to a point? Writes nothing",
    tags: ["backup"],
    security: "admin",
    body: s.object({
      at: s.union([s.int(), s.string()]).optional(),
      bucket: s.string().optional(),
      prefix: s.string().optional(),
      generation: s.string().optional(),
    }),
    response: opaque("`ok`, and what is missing when it is not."),
    errors: [...ON_DB, "CONFLICT"],
    handler: handlers.backupVerify,
  },
  {
    id: "backupGenerations",
    method: "get",
    path: "/v1/db/:db/backup/generations",
    summary: "The timelines the bucket holds, newest first",
    tags: ["backup"],
    security: "admin",
    response: opaque("The generations in the bucket for this database."),
    errors: ON_DB,
    handler: handlers.backupGenerations,
  },

  // ── tokens ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "mintToken",
    method: "post",
    path: "/v1/tokens",
    summary: "Mint an EdDSA token",
    description: "`tables` narrows it further, per table, to `r` or `rw`.",
    tags: ["tokens"],
    security: "admin",
    body: s.object({
      dbs: s.array(s.string()).optional().describe("Database globs."),
      db: s.string().optional(),
      scope: s.enum(["ro", "rw"] as const).optional(),
      tables: s.record(s.enum(["r", "rw"] as const)).optional(),
      ttlMs: s.int().optional(),
      ttl: s.int().optional().describe("Seconds. `ttlMs` wins."),
      sub: s.string().optional(),
    }),
    status: 201,
    response: s.object({
      token: s.string(),
      jti: s.string(),
      exp: s.union([s.int(), s.null()]),
    }),
    errors: COMMON,
    handler: handlers.mintToken,
  },
  {
    id: "revokeToken",
    method: "delete",
    path: "/v1/tokens/:jti",
    summary: "Revoke a token by its id",
    tags: ["tokens"],
    security: "admin",
    response: s.object({ jti: s.string(), revoked: s.boolean() }),
    errors: COMMON,
    handler: handlers.revokeToken,
  },

  // ── operations ──────────────────────────────────────────────────────────────────────────────
  {
    id: "healthz",
    method: "get",
    path: "/healthz",
    summary: "Is this process alive?",
    tags: ["operations"],
    security: "none",
    response: s.object({
      ok: s.boolean(),
      node: s.string(),
      role: s.string(),
      uptimeMs: s.int(),
    }),
    errors: [],
    handler: handlers.healthz,
  },
  {
    id: "readyz",
    method: "get",
    path: "/readyz",
    summary: "Can this node serve?",
    description:
      "On a primary, the catalog being open. On a replica, also that the stream is up: a " +
      "replica that cannot reach its primary serves data that only gets staler.",
    tags: ["operations"],
    security: "none",
    response: s.object({
      ready: s.boolean(),
      node: s.string(),
      role: s.string(),
      connected: s.boolean().optional(),
      primary: s.string().optional(),
    }),
    errors: [],
    handler: handlers.readyz,
  },
  {
    id: "metrics",
    method: "get",
    path: "/metrics",
    summary: "Prometheus text exposition",
    description: "Admin-only when this node has an admin key, open when it has none.",
    tags: ["operations"],
    security: "admin",
    response: s.string(),
    responseType: "text/plain; version=0.0.4; charset=utf-8",
    errors: COMMON,
    handler: handlers.metrics,
  },
]

/** Which generated surfaces this node mounts. Both are decided once, at startup. */
export interface SurfaceSwitches {
  /** `[api] enabled`. False leaves the data API and the per-database document out entirely. */
  api: boolean
  /** `[graphql] enabled`, **and** both optional peers resolving. */
  graphql: boolean
}

/**
 * Every `/v1` operation this node serves. A surface that is off is *absent* rather than mounted
 * and refusing: the answer is then an ordinary 404 and the published document does not advertise
 * something this node will not do (`docs/h6-mount.md` decision 4).
 *
 * `GET /v1/openapi.json` is added last and emitted from the finished registry, so the document
 * describes itself as well as everything above it.
 */
export function serverRegistry(
  surfaces: Surfaces,
  switches: SurfaceSwitches,
): Registry<RouteContext> {
  const registry = new Registry<RouteContext>({
    title: "BunQL",
    version: API_VERSION,
    description:
      "SQLite as a multi-tenant database server for Bun. This document describes the node's " +
      "own API; a database's generated data API is at `GET /v1/db/{db}/openapi.json`.",
  })
  for (const spec of SPECS) registry.add(define(spec))

  // The generated surfaces. The data API is one wildcard route because its real paths carry table
  // names that differ per database, and a row route carries one segment per key column — so the
  // depth is the tenant's, not a constant this file could spell (`docs/h6-mount.md` decision 2).
  // The document publishes the route as the router matches it and points at the per-database
  // document for the real paths.
  const prefix = surfaces.prefix
  if (switches.api) {
    // Exactly the methods `src/dataapi/` generates. `PUT` is not one of them, so it is not
    // mounted: an unsupported verb then answers 405 from Bun's router rather than a 404 from a
    // dispatcher that matched the wildcard and found nothing.
    for (const method of ["get", "post", "patch", "delete"] as const) {
      registry.add(
        define({
          id: `dataApi${method[0]?.toUpperCase()}${method.slice(1)}`,
          method,
          path: `${prefix}/*`,
          summary: `The generated data API (${method.toUpperCase()})`,
          description:
            "A database's own tables as REST. The real paths carry table names and are described " +
            "by `GET /v1/db/{db}/openapi.json`, which is generated from that database's schema.",
          tags: ["data api"],
          security: "bearer",
          response: opaque("Rows, or the row written."),
          errors: ON_STATEMENT,
          handler: surfaces.dataApi,
        }),
      )
    }
    registry.add(
      define({
        id: "databaseOpenapi",
        method: "get",
        path: "/v1/db/:db/openapi.json",
        summary: "That database's OpenAPI 3.1 document",
        description: "Generated from the tenant's own tables, re-read when its schema changes.",
        tags: ["data api"],
        security: "bearer",
        response: opaque("An OpenAPI 3.1 document."),
        errors: ON_DB,
        handler: surfaces.tenantOpenapi,
      }),
    )
  }
  if (switches.api && switches.graphql) {
    const path = `/v1/db/:db/${surfaces.graphqlPath}`
    registry.add(
      define({
        id: "databaseGraphql",
        method: "post",
        path,
        summary: "GraphQL over that database's generated schema",
        description:
          "The schema is generated from the same OpenAPI document the REST surface publishes, " +
          "and every field resolves through this process rather than over a socket.",
        tags: ["data api"],
        security: "bearer",
        body: s.object({
          query: s.string(),
          variables: s.record(s.unknown()).optional(),
          operationName: s.string().optional(),
        }),
        response: opaque("The GraphQL `{data, errors}` envelope."),
        errors: ON_STATEMENT,
        handler: surfaces.graphql,
      }),
    )
    registry.add(
      define({
        id: "databaseGraphiql",
        method: "get",
        path,
        summary: "GraphiQL, or a GraphQL query in the URL",
        tags: ["data api"],
        security: "bearer",
        query: s.object({
          query: s.string().optional(),
          variables: s.string().optional(),
          operationName: s.string().optional(),
        }),
        response: opaque("The GraphQL envelope, or the GraphiQL page for a browser."),
        errors: ON_STATEMENT,
        handler: surfaces.graphql,
      }),
    )
  }

  // Last, so it describes every operation above it, itself included.
  registry.add(
    define({
      id: "openapi",
      method: "get",
      path: "/v1/openapi.json",
      summary: "This server's own OpenAPI 3.1 document",
      description:
        "Open, with no authentication: it names no database and carries no tenant data, and it " +
        "is the same document on every BunQL node.",
      tags: ["operations"],
      security: "none",
      response: opaque("An OpenAPI 3.1 document."),
      errors: [],
      handler: (ctx) => serverDocument(registry, ctx),
    }),
  )
  return registry
}

/** `GET /v1/openapi.json`, with the server URL the caller actually reached this node at. */
function serverDocument(registry: Registry<RouteContext>, ctx: RouteContext): Response {
  const document = buildDocument(registry, {
    servers: [{ url: `${ctx.url.protocol}//${ctx.url.host}` }],
  })
  return new Response(JSON.stringify(document), {
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}
