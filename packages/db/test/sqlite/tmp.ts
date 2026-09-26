// Scratch directories for driver tests. Each caller gets its own directory under the OS temp
// dir and registers it for removal, so a failing test never leaves a WAL behind.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { removeTempDir } from "../tmpdir.ts"

const created: string[] = []

/** A fresh empty directory that will be removed when `cleanupTempDirs()` runs. */
export function tempDir(prefix = "bql-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** A path inside a fresh temp directory, for a database that does not exist yet. */
export function tempDb(name = "test.db"): string {
  return path.join(tempDir(), name)
}

export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) removeTempDir(dir)
  }
}
