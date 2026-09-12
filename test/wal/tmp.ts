// Scratch directories and shared fixtures for the WAL tests. Every test gets its own directory
// under the OS temp dir; `cleanupTempDirs()` removes them all, so a failing test never leaves a
// database, a WAL or a segment file behind.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "../../src/sqlite/index.ts"

const created: string[] = []

export function tempDir(prefix = "bunql-wal-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A primary database in its own directory, with the pragmas design §4.2 sets on every tenant:
 * WAL journal, no autocheckpoint (we own checkpoints, which is what makes tailing safe).
 */
export function openPrimary(dir: string, name = "main.db"): { db: Database; dbPath: string } {
  const dbPath = path.join(dir, name)
  const db = Database.open(dbPath)
  db.exec("pragma synchronous = normal")
  db.exec("pragma wal_autocheckpoint = 0")
  return { db, dbPath }
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

/** Opens a read-only connection, dumps it, closes it. */
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
    const row = db.prepare("pragma integrity_check").get()
    return row?.integrity_check === "ok"
  } finally {
    db.close()
  }
}

/** Deterministic PRNG, so a failing property test can be replayed from its seed. */
export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0
    return ((z ^ (z >>> 15)) >>> 0) / 0x100000000
  }
}
