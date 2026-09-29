// Invariant: exactly one libsqlite3 is loaded per process, and every capability beyond the
// baseline C API is proven present before it is offered — either by a symbol that resolved or
// by a flag reported in PRAGMA compile_options. Nothing here guesses.
//
// The search order is deliberate: an explicit `BQL_SQLITE_LIB`, then the library
// `bun run sqlite:build` vendors into `vendor/sqlite/`, then whatever the system has. The
// vendored build sits ahead of the system one because it is the only one we know the flags of;
// a distribution build is a guess that happens to be right most of the time. When nothing loads,
// or the one that loads is too old for the core API, the error names the library, the reason and
// the fix — see `MIN_VERSION` and `remedy()`.

import { dlopen, FFIType as T, ptr, CString } from "bun:ffi"
import { SQLITE_OK, SQLITE_ROW } from "./constants.ts"

/**
 * The oldest SQLite whose symbols satisfy `CORE`. `sqlite3_changes64` and
 * `sqlite3_total_changes64` arrived in 3.37.0 and set the floor; a library older than that fails
 * to `dlopen` at all, which reads as "no library" unless we say otherwise.
 */
export const MIN_VERSION = "3.37.0"

/** The file `bun run sqlite:build` produces on this platform. One definition, used by both. */
export function vendoredName(): string | null {
  if (process.platform === "darwin") return "libsqlite3.dylib"
  if (process.platform === "linux") return "libsqlite3.so"
  if (process.platform === "win32") return "sqlite3.dll"
  return null
}

/** Where `bun run sqlite:build` puts its artefact, relative to the package root. */
function vendoredPath(): string | null {
  const name = vendoredName()
  if (!name) return null
  const url = new URL(`../../vendor/sqlite/${name}`, import.meta.url)
  // `URL.pathname` on Windows is `/C:/…`, which no file API accepts. `fileURLToPath` is the only
  // thing that knows that, and it is a no-op everywhere else.
  return process.platform === "win32"
    ? (require("node:url") as typeof import("node:url")).fileURLToPath(url)
    : url.pathname
}

/** Candidate paths tried in order when `BQL_SQLITE_LIB` is unset. */
export function candidatePaths(): string[] {
  const out: string[] = []
  const env = process.env.BQL_SQLITE_LIB
  if (env) out.push(env)
  const vendored = vendoredPath()
  if (vendored) out.push(vendored)
  // **No system candidate on Windows**, deliberately — and that is enforced here rather than
  // stated below, which is what it used to be. Every path after this point is a POSIX one, and a
  // Windows run was listing all of them in its "Tried:" report, so the remedy for a missing
  // library read `libc.so.6: Failed to open library "libc.so.6"` on a platform that has no such
  // file. See the note at the end of this function for why there is no Windows equivalent to add.
  if (process.platform === "win32") return out
  out.push(
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    "libsqlite3.so.0",
  )
  // Debian/Ubuntu and Fedora multiarch directories.
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    for (const dir of fs.readdirSync("/usr/lib")) {
      const p = `/usr/lib/${dir}/libsqlite3.so.0`
      if (fs.existsSync(p)) out.push(p)
    }
  } catch {
    // /usr/lib is absent or unreadable; the fixed candidates still apply.
  }
  out.push("/usr/lib/libsqlite3.so.0", "libsqlite3.so", "/usr/lib/libsqlite3.dylib")
  // Why Windows gets none of these and nothing of its own: it ships no libsqlite3, and a bare
  // `"sqlite3.dll"` is not a name — it is a request to the loader to search System32 and every
  // directory on PATH, which found *something* on a CI runner and segfaulted at address 0 on the
  // first call into it (`docs/e1-windows.md` §3). A clean "no library, run `bun run sqlite:build`"
  // is the honest answer, and it is what the absence of a candidate produces.
  return out
}

const CORE = {
  sqlite3_libversion: { args: [], returns: T.cstring },
  sqlite3_libversion_number: { args: [], returns: T.i32 },
  sqlite3_open_v2: { args: [T.ptr, T.ptr, T.i32, T.ptr], returns: T.i32 },
  sqlite3_close_v2: { args: [T.ptr], returns: T.i32 },
  sqlite3_exec: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
  sqlite3_errmsg: { args: [T.ptr], returns: T.cstring },
  sqlite3_errstr: { args: [T.i32], returns: T.cstring },
  sqlite3_extended_errcode: { args: [T.ptr], returns: T.i32 },
  sqlite3_extended_result_codes: { args: [T.ptr, T.i32], returns: T.i32 },
  sqlite3_prepare_v3: { args: [T.ptr, T.ptr, T.i32, T.u32, T.ptr, T.ptr], returns: T.i32 },
  sqlite3_finalize: { args: [T.ptr], returns: T.i32 },
  sqlite3_step: { args: [T.ptr], returns: T.i32 },
  sqlite3_reset: { args: [T.ptr], returns: T.i32 },
  sqlite3_clear_bindings: { args: [T.ptr], returns: T.i32 },
  sqlite3_stmt_readonly: { args: [T.ptr], returns: T.i32 },
  sqlite3_stmt_busy: { args: [T.ptr], returns: T.i32 },
  sqlite3_stmt_status: { args: [T.ptr, T.i32, T.i32], returns: T.i32 },
  sqlite3_sql: { args: [T.ptr], returns: T.cstring },
  sqlite3_bind_parameter_count: { args: [T.ptr], returns: T.i32 },
  sqlite3_bind_parameter_index: { args: [T.ptr, T.ptr], returns: T.i32 },
  sqlite3_bind_parameter_name: { args: [T.ptr, T.i32], returns: T.ptr },
  sqlite3_bind_int: { args: [T.ptr, T.i32, T.i32], returns: T.i32 },
  sqlite3_bind_int64: { args: [T.ptr, T.i32, T.i64], returns: T.i32 },
  sqlite3_bind_double: { args: [T.ptr, T.i32, T.f64], returns: T.i32 },
  sqlite3_bind_text: { args: [T.ptr, T.i32, T.ptr, T.i32, T.i64], returns: T.i32 },
  sqlite3_bind_blob: { args: [T.ptr, T.i32, T.ptr, T.i32, T.i64], returns: T.i32 },
  sqlite3_bind_null: { args: [T.ptr, T.i32], returns: T.i32 },
  sqlite3_column_count: { args: [T.ptr], returns: T.i32 },
  sqlite3_column_name: { args: [T.ptr, T.i32], returns: T.ptr },
  sqlite3_column_decltype: { args: [T.ptr, T.i32], returns: T.ptr },
  sqlite3_column_type: { args: [T.ptr, T.i32], returns: T.i32 },
  sqlite3_column_int64: { args: [T.ptr, T.i32], returns: T.i64_fast },
  sqlite3_column_double: { args: [T.ptr, T.i32], returns: T.f64 },
  sqlite3_column_text: { args: [T.ptr, T.i32], returns: T.ptr },
  sqlite3_column_blob: { args: [T.ptr, T.i32], returns: T.ptr },
  sqlite3_column_bytes: { args: [T.ptr, T.i32], returns: T.i32 },
  sqlite3_changes64: { args: [T.ptr], returns: T.i64_fast },
  sqlite3_total_changes64: { args: [T.ptr], returns: T.i64_fast },
  sqlite3_last_insert_rowid: { args: [T.ptr], returns: T.i64_fast },
  sqlite3_set_last_insert_rowid: { args: [T.ptr, T.i64], returns: T.void },
  sqlite3_get_autocommit: { args: [T.ptr], returns: T.i32 },
  sqlite3_busy_timeout: { args: [T.ptr, T.i32], returns: T.i32 },
  sqlite3_limit: { args: [T.ptr, T.i32, T.i32], returns: T.i32 },
  sqlite3_db_filename: { args: [T.ptr, T.ptr], returns: T.ptr },
  sqlite3_db_readonly: { args: [T.ptr, T.ptr], returns: T.i32 },
  sqlite3_file_control: { args: [T.ptr, T.ptr, T.i32, T.ptr], returns: T.i32 },
  sqlite3_wal_checkpoint_v2: { args: [T.ptr, T.ptr, T.i32, T.ptr, T.ptr], returns: T.i32 },
  sqlite3_update_hook: { args: [T.ptr, T.ptr, T.ptr], returns: T.ptr },
  sqlite3_commit_hook: { args: [T.ptr, T.ptr, T.ptr], returns: T.ptr },
  sqlite3_rollback_hook: { args: [T.ptr, T.ptr, T.ptr], returns: T.ptr },
  sqlite3_wal_hook: { args: [T.ptr, T.ptr, T.ptr], returns: T.ptr },
  sqlite3_set_authorizer: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  sqlite3_progress_handler: { args: [T.ptr, T.i32, T.ptr, T.ptr], returns: T.void },
  sqlite3_interrupt: { args: [T.ptr], returns: T.void },
  sqlite3_free: { args: [T.ptr], returns: T.void },
  sqlite3_value_type: { args: [T.ptr], returns: T.i32 },
  sqlite3_value_int64: { args: [T.ptr], returns: T.i64_fast },
  sqlite3_value_double: { args: [T.ptr], returns: T.f64 },
  sqlite3_value_text: { args: [T.ptr], returns: T.ptr },
  sqlite3_value_blob: { args: [T.ptr], returns: T.ptr },
  sqlite3_value_bytes: { args: [T.ptr], returns: T.i32 },
} as const

/**
 * The same integer-returning entry points redeclared as strict `i64`. `i64_fast` hands back a
 * JS number whenever the value fits in a double, which is what we want by default; `safeIntegers`
 * callers need the bigint every time, so they go through these.
 */
const WIDE = {
  sqlite3_column_int64: { args: [T.ptr, T.i32], returns: T.i64 },
  sqlite3_value_int64: { args: [T.ptr], returns: T.i64 },
  sqlite3_last_insert_rowid: { args: [T.ptr], returns: T.i64 },
  sqlite3_changes64: { args: [T.ptr], returns: T.i64 },
  sqlite3_total_changes64: { args: [T.ptr], returns: T.i64 },
} as const

const PREUPDATE = {
  sqlite3_preupdate_hook: { args: [T.ptr, T.ptr, T.ptr], returns: T.ptr },
  sqlite3_preupdate_count: { args: [T.ptr], returns: T.i32 },
  sqlite3_preupdate_depth: { args: [T.ptr], returns: T.i32 },
  sqlite3_preupdate_old: { args: [T.ptr, T.i32, T.ptr], returns: T.i32 },
  sqlite3_preupdate_new: { args: [T.ptr, T.i32, T.ptr], returns: T.i32 },
} as const

const SESSION = {
  sqlite3session_create: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  sqlite3session_attach: { args: [T.ptr, T.ptr], returns: T.i32 },
  sqlite3session_changeset: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  sqlite3session_patchset: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  sqlite3session_delete: { args: [T.ptr], returns: T.void },
  sqlite3session_enable: { args: [T.ptr, T.i32], returns: T.i32 },
  sqlite3changeset_apply: { args: [T.ptr, T.i32, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
  sqlite3changeset_invert: { args: [T.i32, T.ptr, T.ptr, T.ptr], returns: T.i32 },
} as const

/**
 * **Bound on purpose and wired nowhere on purpose.** These are not unfinished work.
 *
 * Design §11 asked for "snapshot reads across requests (`sqlite3_snapshot`)". P8 measured it and
 * refused it: `experiments/snapshot.ts` (about four seconds) shows that *every* checkpoint mode
 * invalidates a handle, PASSIVE included — a handle held outside a read transaction has no read
 * mark, so SQLite backfills over it — and that suppressing all checkpointing to keep one alive
 * leaves the WAL at exactly the same 12 304 KiB over 3 000 writes as simply holding a read
 * transaction does. It buys one pooled connection, and costs the whole checkpoint policy, a
 * second WAL-pinning mechanism to keep in step with SQLite's, and a correctness hole on a replica,
 * where the page applier writes straight into the database file and there is no old page version
 * for a snapshot to name.
 *
 * The consistent read across requests that §11 wanted is built instead on the read transaction of
 * `docs/r10-read-transactions.md`, surfaced at `POST /v1/db/{db}/read`. `docs/p8-read-sessions.md`
 * is the measurement and the argument. They stay bound because re-deriving the spike needs them.
 */
const SNAPSHOT = {
  sqlite3_snapshot_get: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  sqlite3_snapshot_open: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  sqlite3_snapshot_free: { args: [T.ptr], returns: T.void },
  sqlite3_snapshot_cmp: { args: [T.ptr, T.ptr], returns: T.i32 },
} as const

/**
 * Not SQLite's. `scripts/native/walsum.c` is compiled into the vendored artefact, so these resolve
 * there and nowhere else — a system libsqlite3 simply does not have them and `src/wal/native.ts`
 * keeps the JavaScript. `docs/p3-wal-checksum.md`.
 */
const WALSUM = {
  bql_wal_checksum: { args: [T.ptr, T.u32, T.i32, T.ptr], returns: T.void },
  bql_wal_check_frame: {
    args: [T.ptr, T.u32, T.u32, T.u32, T.u32, T.u32, T.i32, T.ptr],
    returns: T.void,
  },
  /** The non-variadic shim over `sqlite3_db_config`; see `scripts/native/walsum.c`. */
  bql_db_config_int: { args: [T.ptr, T.i32, T.i32, T.ptr], returns: T.i32 },
} as const

/**
 * Also not SQLite's: `scripts/native/ext.c`, which registers sqlite-vec and bql.sh's geo functions
 * as an auto-extension. `loadFrom` calls `bql_ext_init` once, before anything opens a connection.
 * `docs/x1-search.md`.
 */
const EXT = {
  bql_ext_init: { args: [], returns: T.i32 },
  bql_ext_features: { args: [], returns: T.i32 },
} as const

/** The bits `bql_ext_features` reports. */
const EXT_VEC = 1
const EXT_GEO = 2

/**
 * bun:ffi hands pointers back as plain numbers and accepts a number, a typed array or null
 * wherever C wants a `void *`. The symbol tables below are declared by hand in those terms:
 * inferring them from `dlopen` loses the pointer types and makes every call site `any`.
 */
type Ptr = number
type PtrArg = number | ArrayBufferView | null
/** `i64_fast`: a JS number when the value fits in a double, a bigint otherwise. */
type I64Fast = number | bigint

export interface CoreSymbols {
  sqlite3_libversion(): CString
  sqlite3_libversion_number(): number
  sqlite3_open_v2(filename: PtrArg, ppDb: PtrArg, flags: number, vfs: PtrArg): number
  sqlite3_close_v2(db: Ptr): number
  sqlite3_exec(db: Ptr, sql: PtrArg, cb: PtrArg, ctx: PtrArg, errmsg: PtrArg): number
  sqlite3_errmsg(db: Ptr): CString
  sqlite3_errstr(rc: number): CString
  sqlite3_extended_errcode(db: Ptr): number
  sqlite3_extended_result_codes(db: Ptr, on: number): number
  sqlite3_prepare_v3(
    db: Ptr,
    sql: PtrArg,
    nBytes: number,
    flags: number,
    ppStmt: PtrArg,
    pzTail: PtrArg,
  ): number
  sqlite3_finalize(stmt: Ptr): number
  sqlite3_step(stmt: Ptr): number
  sqlite3_reset(stmt: Ptr): number
  sqlite3_clear_bindings(stmt: Ptr): number
  sqlite3_stmt_readonly(stmt: Ptr): number
  sqlite3_stmt_busy(stmt: Ptr): number
  sqlite3_stmt_status(stmt: Ptr, op: number, reset: number): number
  sqlite3_sql(stmt: Ptr): CString
  sqlite3_bind_parameter_count(stmt: Ptr): number
  sqlite3_bind_parameter_index(stmt: Ptr, name: PtrArg): number
  sqlite3_bind_parameter_name(stmt: Ptr, index: number): Ptr | null
  sqlite3_bind_int(stmt: Ptr, index: number, value: number): number
  sqlite3_bind_int64(stmt: Ptr, index: number, value: bigint): number
  sqlite3_bind_double(stmt: Ptr, index: number, value: number): number
  sqlite3_bind_text(
    stmt: Ptr,
    index: number,
    text: PtrArg,
    nBytes: number,
    destructor: bigint,
  ): number
  sqlite3_bind_blob(
    stmt: Ptr,
    index: number,
    blob: PtrArg,
    nBytes: number,
    destructor: bigint,
  ): number
  sqlite3_bind_null(stmt: Ptr, index: number): number
  sqlite3_column_count(stmt: Ptr): number
  sqlite3_column_name(stmt: Ptr, i: number): Ptr | null
  sqlite3_column_decltype(stmt: Ptr, i: number): Ptr | null
  sqlite3_column_type(stmt: Ptr, i: number): number
  sqlite3_column_int64(stmt: Ptr, i: number): I64Fast
  sqlite3_column_double(stmt: Ptr, i: number): number
  sqlite3_column_text(stmt: Ptr, i: number): Ptr | null
  sqlite3_column_blob(stmt: Ptr, i: number): Ptr | null
  sqlite3_column_bytes(stmt: Ptr, i: number): number
  sqlite3_changes64(db: Ptr): I64Fast
  sqlite3_total_changes64(db: Ptr): I64Fast
  sqlite3_last_insert_rowid(db: Ptr): I64Fast
  sqlite3_set_last_insert_rowid(db: Ptr, rowid: bigint): void
  sqlite3_get_autocommit(db: Ptr): number
  sqlite3_busy_timeout(db: Ptr, ms: number): number
  sqlite3_limit(db: Ptr, id: number, value: number): number
  sqlite3_db_filename(db: Ptr, name: PtrArg): Ptr | null
  sqlite3_db_readonly(db: Ptr, name: PtrArg): number
  sqlite3_file_control(db: Ptr, name: PtrArg, op: number, arg: PtrArg): number
  sqlite3_wal_checkpoint_v2(
    db: Ptr,
    name: PtrArg,
    mode: number,
    pnLog: PtrArg,
    pnCkpt: PtrArg,
  ): number
  sqlite3_update_hook(db: Ptr, cb: PtrArg, ctx: PtrArg): Ptr | null
  sqlite3_commit_hook(db: Ptr, cb: PtrArg, ctx: PtrArg): Ptr | null
  sqlite3_rollback_hook(db: Ptr, cb: PtrArg, ctx: PtrArg): Ptr | null
  sqlite3_wal_hook(db: Ptr, cb: PtrArg, ctx: PtrArg): Ptr | null
  sqlite3_set_authorizer(db: Ptr, cb: PtrArg, ctx: PtrArg): number
  sqlite3_progress_handler(db: Ptr, ops: number, cb: PtrArg, ctx: PtrArg): void
  sqlite3_interrupt(db: Ptr): void
  sqlite3_free(p: PtrArg): void
  sqlite3_value_type(value: Ptr): number
  sqlite3_value_int64(value: Ptr): I64Fast
  sqlite3_value_double(value: Ptr): number
  sqlite3_value_text(value: Ptr): Ptr | null
  sqlite3_value_blob(value: Ptr): Ptr | null
  sqlite3_value_bytes(value: Ptr): number
}

export interface WideSymbols {
  sqlite3_column_int64(stmt: Ptr, i: number): bigint
  sqlite3_value_int64(value: Ptr): bigint
  sqlite3_last_insert_rowid(db: Ptr): bigint
  sqlite3_changes64(db: Ptr): bigint
  sqlite3_total_changes64(db: Ptr): bigint
}

export interface PreupdateSymbols {
  sqlite3_preupdate_hook(db: Ptr, cb: PtrArg, ctx: PtrArg): Ptr | null
  sqlite3_preupdate_count(db: Ptr): number
  sqlite3_preupdate_depth(db: Ptr): number
  sqlite3_preupdate_old(db: Ptr, i: number, ppValue: PtrArg): number
  sqlite3_preupdate_new(db: Ptr, i: number, ppValue: PtrArg): number
}

export interface SessionSymbols {
  sqlite3session_create(db: Ptr, name: PtrArg, ppSession: PtrArg): number
  sqlite3session_attach(session: Ptr, table: PtrArg): number
  sqlite3session_changeset(session: Ptr, pnSize: PtrArg, ppData: PtrArg): number
  sqlite3session_patchset(session: Ptr, pnSize: PtrArg, ppData: PtrArg): number
  sqlite3session_delete(session: Ptr): void
  sqlite3session_enable(session: Ptr, on: number): number
  sqlite3changeset_apply(
    db: Ptr,
    nChangeset: number,
    pChangeset: PtrArg,
    xFilter: PtrArg,
    xConflict: PtrArg,
    ctx: PtrArg,
  ): number
  sqlite3changeset_invert(nIn: number, pIn: PtrArg, pnOut: PtrArg, ppOut: PtrArg): number
}

export interface SnapshotSymbols {
  sqlite3_snapshot_get(db: Ptr, schema: PtrArg, ppSnapshot: PtrArg): number
  sqlite3_snapshot_open(db: Ptr, schema: PtrArg, snapshot: PtrArg): number
  sqlite3_snapshot_free(snapshot: Ptr): void
  sqlite3_snapshot_cmp(a: Ptr, b: Ptr): number
}

/** bql.sh's own C, from `scripts/native/walsum.c`. `docs/p3-wal-checksum.md` §3.2. */
export interface WalsumSymbols {
  /** `io[0]`, `io[1]` are the chain, in and out. */
  bql_wal_checksum(a: PtrArg, n: number, native: number, io: PtrArg): void
  /** `out` is five `u32`: valid, pgno, commitSize, s0, s1. */
  bql_wal_check_frame(
    frame: PtrArg,
    pageSize: number,
    salt1: number,
    salt2: number,
    s0: number,
    s1: number,
    native: number,
    out: PtrArg,
  ): void
  /**
   * `sqlite3_db_config(db, op, v, &out)` with an arity bun:ffi can express. `v` is 1, 0, or -1 to
   * read without changing; `out` is one `i32` receiving the setting as it stands afterwards.
   * Returns an SQLite result code.
   */
  bql_db_config_int(db: Ptr, op: number, v: number, out: PtrArg): number
}

/** bql.sh's own C, from `scripts/native/ext.c`. */
export interface ExtSymbols {
  /** Registers the auto-extension; an SQLite result code. Idempotent. */
  bql_ext_init(): number
  /** `1` sqlite-vec, `2` geo functions. */
  bql_ext_features(): number
}

export interface SqliteFeatures {
  /** `sqlite3_preupdate_*` present (built with `SQLITE_ENABLE_PREUPDATE_HOOK`). */
  readonly preupdate: boolean
  /** `sqlite3session_*` present (built with `SQLITE_ENABLE_SESSION`). */
  readonly session: boolean
  /** `sqlite3_snapshot_*` present (built with `SQLITE_ENABLE_SNAPSHOT`). */
  readonly snapshot: boolean
  /** `bql_wal_*` present: the artefact `bun run sqlite:build` produced, not a system library. */
  readonly walsum: boolean
  /** sqlite-vec (`vec0`, `vec_*`) on every connection: the vendored build's `ext.c`. */
  readonly vec: boolean
  /** `bql_haversine` and `bql_bbox_*` on every connection: the vendored build's `ext.c`. */
  readonly geo: boolean
  readonly fts5: boolean
  readonly rtree: boolean
  readonly dbstat: boolean
  readonly json: boolean
  readonly math: boolean
  readonly threadsafe: number
}

export interface SqliteLibrary {
  /** Absolute path or soname that was actually loaded. */
  readonly path: string
  readonly version: string
  readonly versionNumber: number
  readonly symbols: CoreSymbols
  readonly wide: WideSymbols
  readonly preupdate: PreupdateSymbols | null
  readonly session: SessionSymbols | null
  readonly snapshot: SnapshotSymbols | null
  readonly walsum: WalsumSymbols | null
  readonly features: SqliteFeatures
  readonly compileOptions: readonly string[]
}

let loaded: SqliteLibrary | null = null

/** Loads libsqlite3 once per process and returns the shared handle. */
export function sqlite(): SqliteLibrary {
  if (loaded) return loaded
  loaded = loadFrom(candidatePaths())
  return loaded
}

/**
 * Loads the first candidate that opens. Exported for tests; callers should use `sqlite()`, which
 * memoizes and uses the real candidate list.
 */
export function loadFrom(candidates: readonly string[]): SqliteLibrary {
  const tried: Attempt[] = []
  let core: { symbols: unknown } | null = null
  let path = ""
  for (const candidate of candidates) {
    try {
      core = dlopen(candidate, CORE)
      path = candidate
      break
    } catch (err) {
      tried.push(describeFailure(candidate, err as Error))
    }
  }
  if (!core) throw noLibraryError(tried)

  const wide = dlopen(path, WIDE).symbols as unknown as WideSymbols
  const preupdate = tryOpen<PreupdateSymbols>(path, PREUPDATE)
  const session = tryOpen<SessionSymbols>(path, SESSION)
  const snapshot = tryOpen<SnapshotSymbols>(path, SNAPSHOT)
  const walsum = tryOpen<WalsumSymbols>(path, WALSUM)
  const ext = tryOpen<ExtSymbols>(path, EXT)
  // Registered here, before any caller can have opened a connection, so every connection has it.
  const extBits = ext && ext.bql_ext_init() === 0 ? ext.bql_ext_features() : 0

  const s = core.symbols as unknown as CoreSymbols
  const compileOptions = readCompileOptions(s)
  const has = (needle: string) => compileOptions.some((o) => o === needle || o.startsWith(`${needle}=`))
  const threadsafeOpt = compileOptions.find((o) => o.startsWith("THREADSAFE="))

  return {
    path,
    version: cstr(s.sqlite3_libversion()) ?? "unknown",
    versionNumber: s.sqlite3_libversion_number(),
    symbols: s,
    wide,
    preupdate,
    session,
    snapshot,
    walsum,
    compileOptions,
    features: {
      preupdate: preupdate !== null && has("ENABLE_PREUPDATE_HOOK"),
      session: session !== null && has("ENABLE_SESSION"),
      snapshot: snapshot !== null,
      walsum: walsum !== null,
      vec: (extBits & EXT_VEC) !== 0,
      geo: (extBits & EXT_GEO) !== 0,
      fts5: has("ENABLE_FTS5"),
      rtree: has("ENABLE_RTREE"),
      dbstat: has("ENABLE_DBSTAT_VTAB"),
      json: !has("OMIT_JSON"),
      math: has("ENABLE_MATH_FUNCTIONS"),
      threadsafe: threadsafeOpt ? Number(threadsafeOpt.slice("THREADSAFE=".length)) : 1,
    },
  }
}

/** One candidate that did not work out. The three cases read very differently to a human. */
interface Attempt {
  readonly path: string
  /**
   * `"absent"`: nothing to open. `"foreign"`: a shared library, but not a libsqlite3.
   * `"stale"`: a real libsqlite3, missing a symbol `CORE` needs — so older than `MIN_VERSION`.
   */
  readonly kind: "absent" | "foreign" | "stale"
  readonly detail: string
}

function describeFailure(path: string, err: Error): Attempt {
  const message = err.message.split("\n")[0] ?? err.message
  // bun:ffi says `Symbol "x" not found in "lib"` when the file opened but a symbol did not
  // resolve. That is a library that exists, which is a different problem from one that is not
  // installed; and within it, a file with no `sqlite3_libversion` at all is not SQLite, while one
  // that has it but lacks a later addition is SQLite that predates the addition.
  const symbol = /Symbol "([^"]+)" not found/.exec(message)?.[1]
  if (symbol === "sqlite3_libversion") {
    return { path, kind: "foreign", detail: "opened, but it is not a libsqlite3" }
  }
  if (symbol) return { path, kind: "stale", detail: `loaded, but has no ${symbol}` }
  return { path, kind: "absent", detail: message }
}

function noLibraryError(tried: readonly Attempt[]): Error {
  const stale = tried.find((a) => a.kind === "stale")
  const lead = stale
    ? `bql.sh found a libsqlite3 but it is too old: ${stale.path} ${stale.detail}. ` +
      `The driver's core API needs SQLite ${MIN_VERSION} or newer.`
    : "bql.sh could not load a libsqlite3 shared library."
  return new Error(
    `${lead}\n\n${remedy()}\n\nTried:\n  ` +
      tried.map((a) => `${a.path}: ${a.detail}`).join("\n  "),
  )
}

/**
 * What to actually do about a library that is missing or under-built. One definition, because
 * every such failure wants the same three sentences and they should not drift apart.
 */
export function remedy(): string {
  const vendored = vendoredPath()
  return (
    "Build the library bql.sh needs:\n" +
    "  bun run sqlite:build\n" +
    (vendored ? `and it will be found at ${vendored}.\n` : "") +
    "Or point BQL_SQLITE_LIB at a libsqlite3 of your own — it must be built with " +
    "SQLITE_ENABLE_PREUPDATE_HOOK and SQLITE_ENABLE_SESSION. On macOS, Homebrew's " +
    "(brew install sqlite, /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib) qualifies. Apple's " +
    "/usr/lib/libsqlite3.dylib declares both on macOS 26 and still is not the one to use: it " +
    "defaults cache_size to 2000 pages rather than -2000 KiB, which changes when dirty pages " +
    "reach the -wal."
  )
}

/**
 * The message for a library that loaded but cannot do what a caller asked of it. Names the
 * capability, the file that was actually loaded, and the fix — a bare "built without
 * SQLITE_ENABLE_SESSION" tells someone what is wrong and nothing about what to do next.
 */
export function capabilityDetail(lib: SqliteLibrary, buildFlag: string): string {
  return `${lib.path} (SQLite ${lib.version}) was built without ${buildFlag}.\n\n${remedy()}`
}

function tryOpen<S>(path: string, defs: Record<string, unknown>): S | null {
  try {
    return dlopen(path, defs as never).symbols as unknown as S
  } catch {
    return null
  }
}

/**
 * Runs `PRAGMA compile_options` on a throwaway in-memory connection using the raw symbols. This
 * happens once, before any Database exists, so it cannot go through the higher-level API.
 */
function readCompileOptions(s: CoreSymbols): string[] {
  const out = new BigUint64Array(1)
  const flags = 0x02 | 0x04 // READWRITE | CREATE
  if (s.sqlite3_open_v2(cbuf(":memory:"), ptr(out), flags, null) !== SQLITE_OK) return []
  const db = Number(out[0])
  try {
    const sql = cbuf("pragma compile_options")
    if (s.sqlite3_prepare_v3(db, sql, -1, 0, ptr(out), null) !== SQLITE_OK) return []
    const stmt = Number(out[0])
    const options: string[] = []
    try {
      while (s.sqlite3_step(stmt) === SQLITE_ROW) {
        const p = s.sqlite3_column_text(stmt, 0)
        const n = s.sqlite3_column_bytes(stmt, 0)
        if (p && n > 0) options.push(new CString(p, 0, n).toString())
      }
    } finally {
      s.sqlite3_finalize(stmt)
    }
    return options
  } finally {
    s.sqlite3_close_v2(db)
  }
}

/** UTF-8 bytes plus a terminating NUL, ready to pass to a `const char *` parameter. */
export function cbuf(s: string): Uint8Array {
  const bytes = Buffer.from(s, "utf8")
  const out = new Uint8Array(bytes.length + 1)
  out.set(bytes)
  return out
}

/** Reads a NUL-terminated string from a pointer, or null when the pointer is null. */
export function cstr(p: number | CString | null): string | null {
  if (p === null || p === 0) return null
  return typeof p === "number" ? new CString(p).toString() : p.toString()
}
