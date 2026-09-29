// Builds the libsqlite3 the driver needs, from the official amalgamation, with the compile flags
// `src/sqlite/lib.ts` resolves symbols against.
//
// Invariant: the artefact is reproducible from two pinned things and nothing else — an exact
// SQLite version whose archive is verified against a hash published by sqlite.org, and a fixed
// flag list. A download that does not match its hash is deleted and the build refuses to proceed;
// a change to either pin invalidates the cached artefact, so an out-of-date library is never
// silently reused.
//
// Usage:
//   bun run sqlite:build              build if needed, print the path
//   bun run sqlite:build --force      rebuild even when the stamp matches
//   bun run sqlite:build --explain    print the flag list and why each flag is there
//   bun run sqlite:build --out DIR    write somewhere other than vendor/sqlite

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { inflateRawSync } from "node:zlib"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cbuf, cstr, loadFrom, vendoredName, type SqliteLibrary } from "../src/sqlite/lib.ts"

// ── the pins ─────────────────────────────────────────────────────────────────────────────────

/**
 * `sha3` is the hash sqlite.org publishes for this archive on its download page; `sha256` is the
 * same bytes under the digest the rest of this repo speaks. Both are checked. To move to a new
 * release, take all five fields from the `PRODUCT,` line in https://sqlite.org/download.html and
 * recompute `sha256` from the archive that matches `sha3`.
 */
const PIN = {
  version: "3.53.4",
  /** The zero-padded form sqlite.org uses in filenames: 3.53.4 → 3530400. */
  id: "3530400",
  /** Release year, which is the directory sqlite.org files the archive under. */
  year: "2026",
  bytes: 2_946_650,
  sha3: "628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e",
  sha256: "1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d",
} as const

const ARCHIVE = `sqlite-amalgamation-${PIN.id}.zip`
const URL_ = `https://sqlite.org/${PIN.year}/${ARCHIVE}`

/**
 * sqlite-vec, compiled into the same artefact and registered on every connection by
 * `scripts/native/ext.c`. `sha256` is the digest GitHub publishes for the release asset, and was
 * recomputed from the download before it was written here. To move to a new release, take the
 * `…-amalgamation.zip` asset of a non-prerelease tag, and both fields from it.
 */
const VEC_PIN = {
  version: "0.1.9",
  bytes: 54_035,
  sha256: "b87cdda12112657ba5ab8842f0088a4090982eaf41f22b2bd6d495b81765a8c9",
} as const

const VEC_ARCHIVE = `sqlite-vec-${VEC_PIN.version}-amalgamation.zip`
const VEC_URL = `https://github.com/asg017/sqlite-vec/releases/download/v${VEC_PIN.version}/${VEC_ARCHIVE}`

/**
 * Every flag, with the reason it is here. `docs/c6-packaging.md` explains the four groups; the
 * short version is that a capability flag is safe to add because `features` reports it and the
 * driver checks, while a flag that changes what a SQL statement *means* is not — the driver can
 * still end up on a system library, and a query must not depend on which one was found.
 */
const FLAGS: readonly { flag: string; why: string }[] = [
  // Required: the driver resolves these symbol families and the server is built on them.
  {
    flag: "-DSQLITE_ENABLE_PREUPDATE_HOOK",
    why: "sqlite3_preupdate_* — row-level change capture in src/realtime/capture.ts",
  },
  {
    flag: "-DSQLITE_ENABLE_SESSION",
    why: "sqlite3session_* — changesets; also requires the preupdate hook above",
  },

  // Wanted by design §4.1 and shipped by no distribution build we measured.
  {
    flag: "-DSQLITE_ENABLE_SNAPSHOT",
    why: "sqlite3_snapshot_* — the one family lib.ts declares that Debian and Ubuntu both omit",
  },
  {
    flag: "-DSQLITE_ENABLE_STAT4",
    why: "better query plans after ANALYZE; no API to bind, the planner just uses it",
  },

  // Parity: the vendored library goes ahead of the system one in the search path, so anything the
  // distribution build offers and this one did not would be a capability lost by installing it.
  { flag: "-DSQLITE_ENABLE_COLUMN_METADATA", why: "sqlite3_column_table_name and friends" },
  { flag: "-DSQLITE_ENABLE_FTS5", why: "features.fts5" },
  { flag: "-DSQLITE_ENABLE_FTS4", why: "implies FTS3; opens an imported database that uses either" },
  { flag: "-DSQLITE_ENABLE_RTREE", why: "features.rtree" },
  { flag: "-DSQLITE_ENABLE_DBSTAT_VTAB", why: "features.dbstat" },
  { flag: "-DSQLITE_ENABLE_DBPAGE_VTAB", why: "raw page access; design §4.5 mechanism A wants it" },
  { flag: "-DSQLITE_ENABLE_STMTVTAB", why: "the sqlite_stmt table, for introspecting a connection" },
  { flag: "-DSQLITE_ENABLE_MATH_FUNCTIONS", why: "features.math" },
  { flag: "-DSQLITE_ENABLE_UNLOCK_NOTIFY", why: "design §4.1; nothing binds it yet" },
  { flag: "-DSQLITE_ENABLE_UPDATE_DELETE_LIMIT", why: "UPDATE/DELETE ... LIMIT, which Debian ships" },
  { flag: "-DSQLITE_THREADSAFE=1", why: "features.threadsafe; bun:ffi calls are not pinned to one thread" },

  // A default that matches what the tenant sets on every connection anyway, so a bare
  // Database.open() through `bql/sqlite` has the same durability as one the server opened.
  { flag: "-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1", why: "src/tenant/tenant.ts runs `pragma synchronous = normal`" },

  // sqlite-vec, compiled in rather than loaded (docs/x1-search.md).
  { flag: "-DSQLITE_CORE", why: "sqlite-vec.c binds SQLite's API directly, not through a load_extension thunk" },
  { flag: "-DSQLITE_VEC_STATIC", why: "sqlite3_vec_init stays internal; ext.c registers it for every connection" },
  {
    flag: "-DSQLITE_VEC_OMIT_FS",
    why: "no vec_npy_each: a server running client SQL must not read files named in it",
  },

  { flag: "-O2", why: "" },
  // PE code is position-independent by construction, and clang refuses the flag outright on a
  // Windows target rather than ignoring it. Observed: `docs/e1-windows.md` §3.
  ...(process.platform === "win32"
    ? []
    : [{ flag: "-fPIC", why: "" }]),
]

// ── main ─────────────────────────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "..")

async function main(argv: string[]): Promise<number> {
  const force = argv.includes("--force")
  const quiet = argv.includes("--quiet")
  if (argv.includes("--explain")) {
    explain()
    return 0
  }
  const outIndex = argv.indexOf("--out")
  const outDir = outIndex >= 0 ? resolve(argv[outIndex + 1] ?? "") : join(ROOT, "vendor", "sqlite")

  const target = libraryName()
  const artefact = join(outDir, target)
  const stampPath = `${artefact}.stamp`
  const stamp = currentStamp()

  if (!force && existsSync(artefact) && existsSync(stampPath)) {
    if (readFileSync(stampPath, "utf8").trim() === stamp) {
      report(artefact, `already built (SQLite ${PIN.version})`, quiet)
      return 0
    }
  }

  mkdirSync(outDir, { recursive: true })
  const cache = join(outDir, "cache")
  mkdirSync(cache, { recursive: true })

  const zip = join(cache, ARCHIVE)
  if (!existsSync(zip)) await download(URL_, zip, quiet)
  verify(zip)
  const vecZip = join(cache, VEC_ARCHIVE)
  if (!existsSync(vecZip)) await download(VEC_URL, vecZip, quiet)
  verifyVec(vecZip)

  const src = join(outDir, "src")
  mkdirSync(src, { recursive: true })
  const files = extract(readFileSync(zip))
  for (const name of ["sqlite3.c", "sqlite3.h", "sqlite3ext.h"]) {
    const body = files.get(`sqlite-amalgamation-${PIN.id}/${name}`)
    if (!body) throw new Error(`${ARCHIVE} does not contain ${name}`)
    writeFileSync(join(src, name), body)
  }
  const vecFiles = extract(readFileSync(vecZip))
  for (const name of ["sqlite-vec.c", "sqlite-vec.h"]) {
    const body = vecFiles.get(name)
    if (!body) throw new Error(`${VEC_ARCHIVE} does not contain ${name}`)
    writeFileSync(join(src, name), body)
  }
  log(quiet, `extracted the amalgamation and sqlite-vec to ${src}`)

  compile(
    [join(src, "sqlite3.c"), join(src, "sqlite-vec.c"), ...helperSources()],
    src,
    artefact,
    quiet,
  )
  check(artefact)
  writeFileSync(stampPath, `${stamp}\n`)
  report(artefact, `built SQLite ${PIN.version}`, quiet)
  return 0
}

/** Identifies the artefact by everything that can change it. A mismatch forces a rebuild. */
function currentStamp(): string {
  const h = new Bun.CryptoHasher("sha256")
  h.update(`${PIN.version} ${PIN.sha256} ${process.platform} ${process.arch} `)
  h.update(`sqlite-vec ${VEC_PIN.version} ${VEC_PIN.sha256} `)
  h.update(FLAGS.map((f) => f.flag).join(" "))
  // An edit to bql.sh's own C has to force a rebuild exactly as a changed flag does.
  for (const source of helperSources()) h.update(readFileSync(source))
  return h.digest("hex")
}

function libraryName(): string {
  const name = vendoredName()
  if (name) return name
  throw new Error(
    `${process.platform} is not a platform this script knows how to build for. ` +
      "Build libsqlite3 by hand with the flags in `bun run sqlite:build --explain` and point " +
      "BQL_SQLITE_LIB at it.",
  )
}

/** A plain `fetch`: no headers beyond the runtime's own, nothing that identifies who is building. */
async function download(url: string, to: string, quiet: boolean): Promise<void> {
  log(quiet, `fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText}`)
  writeFileSync(to, new Uint8Array(await res.arrayBuffer()))
}

/** Both digests, because one is upstream's word for it and the other is the one we can recompute. */
function verify(zip: string): void {
  const bytes = readFileSync(zip)
  const fail = (what: string, got: string, want: string) => {
    rmSync(zip, { force: true })
    throw new Error(
      `${ARCHIVE} does not match its pin (${what}: got ${got}, expected ${want}). The download ` +
        "has been deleted. This is either a corrupted transfer or a tampered archive — do not " +
        "work around it by relaxing the pin.",
    )
  }
  if (bytes.length !== PIN.bytes) fail("size", String(bytes.length), String(PIN.bytes))
  const sha3 = new Bun.CryptoHasher("sha3-256").update(bytes).digest("hex")
  if (sha3 !== PIN.sha3) fail("sha3-256", sha3, PIN.sha3)
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (sha256 !== PIN.sha256) fail("sha256", sha256, PIN.sha256)
}

/** sqlite-vec has no sha3 published beside it, so one digest: GitHub's, recomputed here. */
function verifyVec(zip: string): void {
  const bytes = readFileSync(zip)
  const fail = (what: string, got: string, want: string) => {
    rmSync(zip, { force: true })
    throw new Error(
      `${VEC_ARCHIVE} does not match its pin (${what}: got ${got}, expected ${want}). The download ` +
        "has been deleted. This is either a corrupted transfer or a tampered archive — do not " +
        "work around it by relaxing the pin.",
    )
  }
  if (bytes.length !== VEC_PIN.bytes) fail("size", String(bytes.length), String(VEC_PIN.bytes))
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (sha256 !== VEC_PIN.sha256) fail("sha256", sha256, VEC_PIN.sha256)
}

/**
 * bql.sh's own C, compiled into the same artefact as the amalgamation so that there is one library,
 * one `dlopen` and one capability check. `src/sqlite/lib.ts` resolves its symbols optionally, so a
 * node on a system libsqlite3 simply does not get them. `walsum.c` is the WAL checksum
 * (`docs/p3-wal-checksum.md`); `ext.c` registers sqlite-vec and the geo functions on every
 * connection (`docs/x1-search.md`).
 */
function helperSources(): string[] {
  // `fileURLToPath`, not `.pathname`: on Windows the latter is `/D:/a/…`, which no file API takes.
  // Observed rather than reasoned about — it is what stopped the first Windows CI run dead
  // (`docs/e1-windows.md` §3).
  return ["walsum.c", "ext.c"].map((name) =>
    fileURLToPath(new URL(`./native/${name}`, import.meta.url)),
  )
}

function compile(sources: string[], include: string, artefact: string, quiet: boolean): void {
  const cc = compiler()
  // `-I`: sqlite-vec.c and ext.c include "sqlite3.h", which is extracted beside the amalgamation.
  const args = [cc, ...FLAGS.map((f) => f.flag), `-I${include}`]
  if (process.platform === "darwin") {
    args.push("-dynamiclib", "-install_name", `@rpath/${libraryName()}`)
  } else if (process.platform === "win32") {
    // A DLL exports nothing unless it is told to. SQLite routes every public function through
    // `SQLITE_API`, so defining that is the whole of it; `walsum.c` marks its own with
    // `BQL_API`, defined the same way here and to nothing elsewhere.
    args.push(
      "-shared",
      "-DSQLITE_API=__declspec(dllexport)",
      "-DBQL_API=__declspec(dllexport)",
    )
  } else {
    // -lm for the math functions, -lpthread for THREADSAFE=1, -ldl for load_extension. All three
    // are inside libc on a current glibc and harmless to ask for anyway.
    args.push("-shared", "-lm", "-lpthread", "-ldl")
  }
  args.push("-o", artefact, ...sources)

  log(quiet, `${args[0]} … -o ${artefact}`)
  const built = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" })
  if (built.exitCode !== 0) throw new Error(`${cc} exited ${built.exitCode}`)
}

function compiler(): string {
  // `clang` first on Windows: the image ships LLVM on PATH, `cc` does not exist, and `gcc` there
  // is a MinGW one whose CRT is not the one Bun's `dlopen` loads the DLL into.
  const order =
    process.platform === "win32"
      ? [process.env.CC, "clang", "gcc"]
      : [process.env.CC, "cc", "clang", "gcc"]
  for (const cc of order) {
    if (!cc) continue
    if (Bun.spawnSync([cc, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
      return cc
    }
  }
  throw new Error(
    "No C compiler. Install one and run this again:\n" +
      "  macOS          xcode-select --install\n" +
      "  Debian/Ubuntu  apt-get install -y build-essential\n" +
      "  Alpine         apk add build-base\n" +
      "  Windows        winget install LLVM.LLVM\n" +
      "Or set CC to the compiler you want used.",
  )
}

/**
 * Loads what was just built and insists it has the capabilities the flags asked for. A library
 * that compiled but did not gain them is worse than no library at all: the driver would load it,
 * report the features as absent, and quietly drop back to a degraded realtime path.
 */
function check(artefact: string): void {
  const lib = loadFrom([artefact])
  const missing = (["preupdate", "session", "snapshot", "walsum", "vec", "geo"] as const).filter(
    (f) => !lib.features[f],
  )
  if (missing.length > 0) {
    throw new Error(
      `${artefact} built but reports no ${missing.join(", ")}. The flag list, the amalgamation ` +
        "and scripts/native/{walsum,ext}.c disagree, which should not be possible — do not ship this " +
        "artefact.",
    )
  }
  // `features` says the symbols resolved; this says a fresh connection really has what they
  // register, which is the claim the helpers in `bql.sh/search` rely on.
  const probe = "select vec_version(), bql_haversine(0, 0, 0, 1), bql_bbox_min_lat(0, 0, 1000)"
  const failed = probeConnection(lib, probe)
  if (failed) {
    throw new Error(`${artefact} built, but a new connection cannot run \`${probe}\`: ${failed}`)
  }
  console.log(
    `  SQLite ${lib.version} · preupdate ✓ session ✓ snapshot ✓ walsum ✓ vec ✓ geo ✓ ` +
      `fts5 ${mark(lib.features.fts5)} ` +
      `rtree ${mark(lib.features.rtree)} math ${mark(lib.features.math)} ` +
      `dbstat ${mark(lib.features.dbstat)} threadsafe=${lib.features.threadsafe}`,
  )
}

const mark = (b: boolean) => (b ? "✓" : "✗")

/** Opens `:memory:` through the raw symbols and runs `sql`. Null on success, else the message. */
function probeConnection(lib: SqliteLibrary, sql: string): string | null {
  const s = lib.symbols
  const out = new BigUint64Array(1)
  // SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
  const rc = s.sqlite3_open_v2(cbuf(":memory:"), out, 0x02 | 0x04, null)
  const db = Number(out[0])
  try {
    if (rc !== 0) return `open failed (${rc})`
    if (s.sqlite3_exec(db, cbuf(sql), null, null, null) !== 0) return cstr(s.sqlite3_errmsg(db))
    return null
  } finally {
    if (db) s.sqlite3_close_v2(db)
  }
}

function explain(): void {
  console.log(`SQLite ${PIN.version} (${URL_})`)
  console.log(`sqlite-vec ${VEC_PIN.version} (${VEC_URL})\n`)
  const width = Math.max(...FLAGS.map((f) => f.flag.length))
  for (const { flag, why } of FLAGS) {
    console.log(why ? `  ${flag.padEnd(width)}  ${why}` : `  ${flag}`)
  }
  console.log(
    "\nDeliberately not set: SQLITE_ENABLE_JSON1 (a no-op since 3.38, JSON is in core), " +
      "\nSQLITE_ENABLE_STMT_SCANSTATUS (costs per-statement work for an API nothing binds), " +
      "\nSQLITE_DQS=0 and SQLITE_USE_URI (see docs/c6-packaging.md), " +
      "\nSQLITE_ENABLE_FTS3_TOKENIZER (fts3_tokenizer() takes a function pointer from SQL), " +
      "\nSQLITE_VEC_ENABLE_NEON/AVX (per-CPU code paths; an artefact is copied between machines, " +
      "\nand the speed-up has not been measured here — docs/x1-search.md).",
  )
}

function report(artefact: string, what: string, quiet: boolean): void {
  if (quiet) {
    console.log(artefact)
    return
  }
  console.log(`\n${what}\n  ${artefact}\n\n  BQL_SQLITE_LIB=${artefact}\n`)
}

function log(quiet: boolean, message: string): void {
  if (!quiet) console.log(`  ${message}`)
}

// ── zip ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Reads the archive's central directory and returns every entry. There is no `unzip` in
 * `oven/bun` and no zip reader in Bun, and shelling out to a tool that may not exist is how a
 * build script becomes machine-dependent — which is the thing this script is here to stop.
 */
function extract(zip: Buffer): Map<string, Uint8Array> {
  const eocd = findEocd(zip)
  const entries = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  if (p === 0xffff_ffff) throw new Error(`${ARCHIVE} is zip64, which this reader does not handle`)

  const out = new Map<string, Uint8Array>()
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(p) !== 0x0201_4b50) throw new Error(`${ARCHIVE}: bad central directory`)
    const method = zip.readUInt16LE(p + 10)
    const compressed = zip.readUInt32LE(p + 20)
    const plain = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith("/")) continue
    if (zip.readUInt32LE(local) !== 0x0403_4b50) throw new Error(`${ARCHIVE}: bad local header`)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const body = zip.subarray(start, start + compressed)
    const bytes = method === 0 ? Uint8Array.from(body) : new Uint8Array(inflateRawSync(body))
    if (method !== 0 && method !== 8) throw new Error(`${ARCHIVE}: ${name} uses method ${method}`)
    if (bytes.length !== plain) throw new Error(`${ARCHIVE}: ${name} unpacked to the wrong size`)
    out.set(name, bytes)
  }
  return out
}

function findEocd(zip: Buffer): number {
  // The end-of-central-directory record is last, but a trailing comment can push it back by up
  // to 64 KiB. Scan backwards for its signature.
  const floor = Math.max(0, zip.length - 0x1_0000 - 22)
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip.readUInt32LE(i) === 0x0605_4b50) return i
  }
  throw new Error(`${ARCHIVE} is not a zip archive`)
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (err) {
    console.error(`\nsqlite:build failed\n  ${(err as Error).message}\n`)
    process.exit(1)
  }
}
