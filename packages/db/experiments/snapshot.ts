// P8's spike: is `sqlite3_snapshot` worth wiring for a consistent read held across requests?
// The answer is no, and this is the measurement that says so. `docs/plan-phase3.md` P8.
//
//   bun run experiments/snapshot.ts
//
// Two questions, in order:
//
//   1. What invalidates a snapshot handle? Every checkpoint mode, PASSIVE included — a handle
//      held outside a read transaction has no read mark, so SQLite backfills over it.
//   2. Does suppressing every checkpoint to keep one alive cost less WAL than just holding a
//      read transaction? No: identical to the kilobyte, because a PASSIVE checkpoint cannot
//      backfill past the oldest read mark either.
//
// Needs the vendored build (`bun run sqlite:build`); no distribution libsqlite3 has the family.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database, sqlite } from "../src/sqlite/index.ts"

const lib = sqlite()
if (!lib.snapshot) {
  console.log(`no sqlite3_snapshot_* in ${lib.path} — run \`bun run sqlite:build\``)
  process.exit(1)
}
const snap = lib.snapshot
const MAIN = Buffer.from("main\0", "utf8")

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-snapshot-"))
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }))
const file = path.join(dir, "s.db")
const walKiB = (): number => {
  try {
    return fs.statSync(`${file}-wal`).size / 1024
  } catch {
    return 0
  }
}

/** A fresh database with one row, and SQLite's autocheckpoint off as a bql.sh tenant has it. */
function fresh(): Database {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const w = Database.open(file)
  w.exec("pragma synchronous = normal")
  w.exec("pragma wal_autocheckpoint = 0")
  w.exec("create table t(k integer primary key, v text)")
  w.exec("insert into t values (1, 'one')")
  return w
}

/** Takes a handle inside a read transaction, then ends it — which is the whole point. */
function take(r: Database): number | null {
  r.exec("begin deferred")
  r.prepare("select v from t where k = 1").get()
  const out = new BigUint64Array(1)
  const rc = snap.sqlite3_snapshot_get(r.handle, MAIN, out)
  r.exec("commit")
  return rc === 0 ? Number(out[0]) : null
}

console.log("\n1. what invalidates a handle  (769 = SQLITE_ERROR_SNAPSHOT)\n")
console.log("   after                      snapshot_open")
for (const mode of [null, "PASSIVE", "FULL", "RESTART", "TRUNCATE"] as const) {
  const w = fresh()
  const r = Database.open(file, { readonly: true })
  const h = take(r)
  if (h === null) throw new Error("snapshot_get failed on a fresh WAL database")
  w.exec("insert into t values (2, 'two')")
  if (mode) w.walCheckpoint(mode)
  r.exec("begin deferred")
  const rc = snap.sqlite3_snapshot_open(r.handle, MAIN, h)
  console.log(`   ${(mode ?? "no checkpoint").padEnd(26)} ${String(rc).padStart(4)}  ${rc === 0 ? "valid" : "invalid"}`)
  try {
    r.exec("commit")
  } catch {}
  snap.sqlite3_snapshot_free(h)
  r.close()
  w.close()
}

console.log("\n2. what a consistent read costs in WAL, 3000 writes\n")
const WRITES = 3_000
const PAD = "padding-padding-padding-padding"

// A: R10's mechanism — a read transaction held open, PASSIVE checkpoints running underneath it.
{
  const w = fresh()
  const r = Database.open(file, { readonly: true })
  r.exec("begin deferred")
  const before = (r.prepare("select count(*) as c from t").get() as { c: number }).c
  for (let i = 2; i < WRITES; i++) {
    w.exec(`insert into t values (${i}, '${PAD}')`)
    if (i % 200 === 0) w.walCheckpoint("PASSIVE")
  }
  const after = (r.prepare("select count(*) as c from t").get() as { c: number }).c
  console.log(
    `   A  held read transaction, PASSIVE every 200   isolated=${before === after}   WAL ${walKiB().toFixed(0)} KiB`,
  )
  r.exec("commit")
  r.close()
  w.close()
}

// B: a snapshot handle, holding no reader, with every checkpoint suppressed to keep it alive.
{
  const w = fresh()
  const r = Database.open(file, { readonly: true })
  const h = take(r)
  if (h === null) throw new Error("snapshot_get failed")
  for (let i = 2; i < WRITES; i++) w.exec(`insert into t values (${i}, '${PAD}')`)
  r.exec("begin deferred")
  const rc = snap.sqlite3_snapshot_open(r.handle, MAIN, h)
  const seen = rc === 0 ? (r.prepare("select count(*) as c from t").get() as { c: number }).c : -1
  console.log(
    `   B  snapshot handle, no checkpoint at all      isolated=${seen === 1}   WAL ${walKiB().toFixed(0)} KiB`,
  )
  try {
    r.exec("commit")
  } catch {}
  snap.sqlite3_snapshot_free(h)
  r.close()
  w.close()
}

console.log(
  "\n   Identical. A held reader pins the WAL exactly as completely as a suppressed checkpoint,\n" +
    "   because a PASSIVE pass cannot backfill past the oldest read mark either. The snapshot\n" +
    "   API buys one pooled connection and costs the whole checkpoint policy.\n",
)
