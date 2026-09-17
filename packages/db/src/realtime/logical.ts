// P9: what rides inside a version-2 transaction record's logical section — one transaction's row
// changes, already sliced into the statements L8 keys events by.
//
// Invariant: this is the only module that knows what those bytes mean. `src/wal/record.ts` frames
// them, hashes them and hands them back; it never looks inside. So the record format and the
// change-feed shape can move independently, and `src/wal/` keeps knowing nothing about §6.4.
//
// The encoding is JSON in UTF-8. It is not the cheap choice and it is the right one here: the
// values are *already* the wire shapes `encodeValue` produces (`{"$i": "…"}` for a big integer,
// `{"$b": "…"}` for a blob), so a replica publishes what it decodes with no second conversion, and
// the body's zstd — which the pages pay for anyway — takes the redundancy out. `docs/performance.md`
// §9 carries the measured size ratio.

import type { IncludeLevel, IntValue, ObjectRow, RowChange } from "../client/protocol.ts"
import { encodeInteger, encodeValue } from "../server/json.ts"
import type { SqliteValue } from "../sqlite/values.ts"
import type { CapturedRow, ValueRow } from "./capture.ts"

/** The payload version, independent of the record's: this shape can move without the frame moving. */
const LOGICAL_VERSION = 1

interface LogicalPayload {
  v: number
  /** How much of each row the primary recorded; a replica cannot show more than this. */
  level: IncludeLevel
  /** One entry per statement that changed rows, in order. The index is the event's `seq`. */
  stmts: RowChange[][]
  /** The transaction changed more rows than `maxRowsPerTxn` and `stmts` is short. */
  truncated?: true
}

export interface LogicalChanges {
  level: IncludeLevel
  statements: RowChange[][]
  truncated: boolean
}

function encodeRow(row: ValueRow): ObjectRow {
  const out: ObjectRow = {}
  for (const key in row) out[key] = encodeValue(row[key] as SqliteValue)
  return out
}

/** Driver-native capture row → the wire shape (design §6.4). */
export function toRowChange(row: CapturedRow): RowChange {
  const change: RowChange = {
    table: row.table,
    op: row.op,
    rowid: row.rowid === null ? null : (encodeInteger(row.rowid) as number | IntValue),
  }
  if (row.pk) change.pk = encodeRow(row.pk)
  if (row.row) change.row = encodeRow(row.row)
  if (row.old) change.old = encodeRow(row.old)
  return change
}

/**
 * The same row, cut down to `level`. The primary captures at whatever its highest local subscriber
 * asked for, which can be more than `[replication] logicalChanges` said to record — `row+old` on
 * the wire is the whole row twice — so the recorded level caps what leaves the node rather than
 * whatever happened to be in the buffer.
 */
export function narrowRowChange(change: RowChange, level: IncludeLevel): RowChange {
  if (level === "row+old") return change
  const out: RowChange = { table: change.table, op: change.op, rowid: change.rowid }
  if (level === "none") return out
  if (change.pk) out.pk = change.pk
  if (level === "pk") return out
  if (change.row) out.row = change.row
  return out
}

/**
 * Where each statement's slice of the row list ends. `marks` is what the request layer recorded;
 * an unmarked transaction, and one whose last statement wrote rows after the final mark, both end
 * at `total` — so the tail is never dropped whatever the caller did or did not mark.
 *
 * Shared by `afterCommit` and by the record path on purpose: the primary's own feed and the bytes
 * a replica receives must slice the same list the same way, or the two feeds disagree on `seq`
 * while agreeing on every row, which is the worst of both.
 */
export function sliceEnds(marks: readonly number[], total: number): number[] {
  if (marks.length === 0) return [total]
  const ends = marks.filter((at) => at <= total)
  if (ends[ends.length - 1] !== total) ends.push(total)
  return ends
}

/** The record body's logical section, or null when the transaction changed no rows. */
export function encodeLogical(
  rows: readonly CapturedRow[],
  marks: readonly number[],
  level: IncludeLevel,
  truncated: boolean,
): Uint8Array | null {
  if (rows.length === 0 || level === "none") return null
  const all: RowChange[] = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    all[i] = narrowRowChange(toRowChange(rows[i] as CapturedRow), level)
  }
  const stmts: RowChange[][] = []
  let from = 0
  for (const to of sliceEnds(marks, all.length)) {
    if (to <= from) continue
    stmts.push(from === 0 && to === all.length ? all : all.slice(from, to))
    from = to
  }
  if (stmts.length === 0) return null
  const payload: LogicalPayload = { v: LOGICAL_VERSION, level, stmts }
  if (truncated) payload.truncated = true
  return new TextEncoder().encode(JSON.stringify(payload))
}

/**
 * Reads a record's logical section. Returns null for bytes this build cannot read — a payload
 * version from the future, or anything that is not the shape — because the alternative is
 * publishing a half-understood change list, and an empty feed a subscriber is told about is the
 * one failure mode P9 exists to remove.
 */
export function decodeLogical(bytes: Uint8Array): LogicalChanges | null {
  let payload: LogicalPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as LogicalPayload
  } catch {
    return null
  }
  if (!payload || payload.v !== LOGICAL_VERSION || !Array.isArray(payload.stmts)) return null
  return {
    level: payload.level ?? "row",
    statements: payload.stmts,
    truncated: payload.truncated === true,
  }
}
