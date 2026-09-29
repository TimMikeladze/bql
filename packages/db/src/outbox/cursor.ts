// X6: where each outbox rule stands in one database's log — `<tenant dir>/outbox.json`.
//
// Invariant: the file only ever moves forward to a txid the bus has acknowledged every message up
// to, and it is replaced whole — a temp file, an fsync, a rename — so a crash leaves either the old
// cursor or the new one and never half of either. An old cursor is safe: the relay re-publishes
// from it and the bus's dedupe keys turn the repeat into no-ops.
//
// It lives in the tenant directory on purpose. A deleted database takes its cursor to the trash
// with it, so a database created later under the same name starts from its own first record.

import fs from "node:fs"
import path from "node:path"

export const CURSOR_FILE = "outbox.json"

interface CursorFile {
  v: 1
  /**
   * Rule name → `"<txid>"` or `"<txid>:<postChecksum hex>"`: the last txid fully published, and the
   * database's checksum after it. The checksum is what lets a relay tell "the log I left" from "a
   * log that reached the same txid by another history", and it is optional so a file written before
   * it existed still reads.
   */
  cursors: Record<string, string>
}

export interface Cursor {
  txid: bigint
  /** The record's `postChecksum` at `txid`, or null when it was not known. */
  checksum: bigint | null
}

export function cursorPath(tenantDir: string): string {
  return path.join(tenantDir, CURSOR_FILE)
}

/** Every rule's cursor for one database. A missing or unreadable file is "nothing published". */
export function readCursors(tenantDir: string): Map<string, Cursor> {
  const out = new Map<string, Cursor>()
  let parsed: CursorFile
  try {
    parsed = JSON.parse(fs.readFileSync(cursorPath(tenantDir), "utf8")) as CursorFile
  } catch {
    return out
  }
  if (!parsed || parsed.v !== 1 || typeof parsed.cursors !== "object") return out
  for (const [name, value] of Object.entries(parsed.cursors)) {
    try {
      const [txid, checksum] = String(value).split(":")
      out.set(name, {
        txid: BigInt(txid as string),
        checksum: checksum ? BigInt(`0x${checksum}`) : null,
      })
    } catch {
      // A value that is not a txid is treated as absent: republishing is safe, skipping is not.
    }
  }
  return out
}

/** Sets one rule's cursor, keeping the others, atomically. */
export function writeCursor(
  tenantDir: string,
  rule: string,
  txid: bigint,
  checksum: bigint | null = null,
): void {
  const cursors = readCursors(tenantDir)
  cursors.set(rule, { txid, checksum })
  const body: CursorFile = { v: 1, cursors: {} }
  for (const [name, at] of cursors) {
    body.cursors[name] =
      at.checksum === null ? at.txid.toString() : `${at.txid}:${at.checksum.toString(16)}`
  }
  const file = cursorPath(tenantDir)
  const temp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(temp, "w")
  try {
    fs.writeSync(fd, JSON.stringify(body))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
}
