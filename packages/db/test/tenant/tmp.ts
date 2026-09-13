// Scratch directories and fixtures for the tenant tests. Every test gets its own data root under
// the OS temp dir, and `cleanupTempDirs()` removes them all, so a failing test never leaves a
// database, a WAL, a segment or a catalog behind.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "../../src/sqlite/index.ts"
import { decodeHeader, TxnLog, WalApplier } from "../../src/wal/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const created: string[] = []

export function tempDir(prefix = "bunql-tenant-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) removeTempDir(dir)
  }
}

/** Every user table and its rows, ordered, as one comparable string. */
export function dump(db: Database): string {
  const tables = db
    .prepare(
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all()
  const parts: string[] = []
  for (const row of tables) {
    const name = row.name as string
    const rows = db.prepare(`select * from "${name}" order by rowid`).values()
    parts.push(`## ${name}\n${rows.map((r) => JSON.stringify(r)).join("\n")}`)
  }
  return parts.join("\n")
}

export function dumpFile(dbPath: string): string {
  const db = Database.open(dbPath, { readonly: true, wal: false })
  try {
    return dump(db)
  } finally {
    db.close()
  }
}

export function integrityOk(dbPath: string): boolean {
  const db = Database.open(dbPath, { readonly: true, wal: false })
  try {
    return db.prepare("pragma integrity_check").get()?.integrity_check === "ok"
  } finally {
    db.close()
  }
}

/**
 * Replays a tenant's whole log into a fresh database with the M3 applier — the replica's view of
 * everything the tenant recorded. Returns the path of the rebuilt database.
 */
export function replayLog(tenantDir: string, into: string): string {
  fs.mkdirSync(into, { recursive: true })
  const dbPath = path.join(into, "main.db")
  const log = TxnLog.open({ dir: tenantDir, fsync: "never" })
  const first = log.read(log.firstTxid ?? 1n)
  // An empty file has no header, so SQLite would not know it is in WAL mode and would ignore
  // everything the applier writes. One header page in the right page size is the seed.
  const seed = Database.open(dbPath, { wal: false })
  seed.exec(`pragma page_size = ${first?.pageSize ?? 4096}`)
  seed.exec("pragma journal_mode = wal")
  seed.close()
  const applier = new WalApplier({ dbPath, dir: into, fsync: "rename" })
  try {
    applier.seed({
      txid: 0n,
      epoch: 0,
      postChecksum: 0n,
      dbSizePages: 0,
      pageSize: first?.pageSize ?? 4096,
    })
    for (const record of log.iterate(1n)) applier.apply(record)
    applier.checkpoint("TRUNCATE")
  } finally {
    applier.close()
    log.close()
  }
  return dbPath
}

/** Txids the log currently holds, in order. */
export function loggedTxids(tenantDir: string): bigint[] {
  const log = TxnLog.open({ dir: tenantDir, fsync: "never" })
  try {
    const first = log.firstTxid
    if (first === null) return []
    return [...log.iterate(first)].map((record) => record.txid)
  } finally {
    log.close()
  }
}

/**
 * Cuts the log back so its newest record is `txid`, the way a crash between the commit and the
 * log append leaves it. Returns the number of records removed.
 */
export function truncateLogAfter(tenantDir: string, txid: bigint): number {
  const logDir = path.join(tenantDir, "log")
  const names = fs
    .readdirSync(logDir)
    .filter((name) => name.endsWith(".seg"))
    .sort()
  let removed = 0
  for (const name of names) {
    const file = path.join(logDir, name)
    const bytes = new Uint8Array(fs.readFileSync(file))
    let at = 0
    let cut = -1
    while (at < bytes.byteLength) {
      const head = decodeHeader(bytes, at)
      if (!head) break
      if (head.header.txid > txid && cut < 0) cut = at
      if (head.header.txid > txid) removed += 1
      at += head.byteLength
    }
    if (cut >= 0) fs.truncateSync(file, cut)
  }
  return removed
}

/**
 * A connection held open across a tenant's close, so SQLite cannot take the exclusive lock its
 * close-time checkpoint needs. That leaves the WAL exactly as the last commit wrote it, which is
 * what a crash looks like; a clean close would have backfilled it into the database file.
 */
export function crashKeeper(dbPath: string): Database {
  const db = Database.open(dbPath, { wal: false })
  // Touch the database so the pager actually opens the WAL and takes its shared lock.
  db.prepare("pragma quick_check(1)").get()
  return db
}
