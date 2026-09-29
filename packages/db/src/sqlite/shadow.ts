// Which ordinary tables are really a virtual table's storage.
//
// Invariant: a shadow table is a module's private state, not a set of rows anyone asked for. An
// insert into an FTS5 table writes four of them; a vec0 insert writes three or more. Surfacing
// those rows — as Data API tables, change-feed events or live-query dependencies — would publish
// the module's internals under names nobody created, and a per-table token ACL has to let a module
// reach its own storage. So every surface that lists, reports or authorizes tables asks here.
// `docs/x1-search.md`.
//
// Second invariant: a table is a shadow only if the module **actually created** it for this
// virtual table's options — never on its name alone. `docs_fts_content` beside an external-content
// `docs_fts` is a real table (external content has no `_content`), as is `emb_auxiliary` beside a
// vec0 `emb` with no `+aux` column; treating either as storage would hide it from the Data API,
// drop its rows from the change feed and the outbox, and hand it to any token granted the index.
// A name the module did create cannot be taken by a real table first — the `CREATE VIRTUAL TABLE`
// would have failed — so an exact per-options set is exact.
//
// Why not `PRAGMA table_list`'s `type = 'shadow'`: it is name-based too (each module's
// `xShadowName` is asked only about the suffix), so it calls both examples above `shadow`, and it
// misses vec0's `_vector_chunksNN`, which sqlite-vec 0.1.9's `xShadowName` omits. Measured.
//
// When the options cannot be read with certainty, the answer errs towards "not a shadow": a
// shadow table that shows up in a listing is noise; a real table that disappears is a leak.

export interface VirtualTable {
  /** Module name, lower-cased. */
  module: string
  /** Shadow-table suffixes (after `<name>_`) this table's options make the module create. */
  suffixes: ReadonlySet<string>
}

const USING = /^\s*create\s+virtual\s+table\s+.*?\busing\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(([\s\S]*)\))?\s*;?\s*$/i

/** The module a `CREATE VIRTUAL TABLE` statement names, lower-cased; null for anything else. */
export function virtualModule(sql: string | null | undefined): string | null {
  if (!sql) return null
  return USING.exec(sql)?.[1]?.toLowerCase() ?? null
}

/** Virtual table name → module and shadow suffixes, from `sqlite_schema` rows (`name`, `sql`). */
export function virtualTables(rows: Iterable<{ name?: unknown; sql?: unknown }>): Map<string, VirtualTable> {
  const out = new Map<string, VirtualTable>()
  for (const row of rows) {
    if (typeof row.name !== "string" || typeof row.sql !== "string") continue
    const match = USING.exec(row.sql)
    if (!match) continue
    const module = (match[1] as string).toLowerCase()
    out.set(row.name, { module, suffixes: shadowSuffixes(module, splitArgs(match[3] ?? "")) })
  }
  return out
}

/**
 * The virtual table `name` is a shadow of, or null. Identifiers compare case-insensitively, as
 * SQLite compares them.
 */
export function shadowOwner(name: string, vtabs: ReadonlyMap<string, VirtualTable>): string | null {
  const lower = name.toLowerCase()
  for (const [vtab, { suffixes }] of vtabs) {
    const prefix = `${vtab.toLowerCase()}_`
    if (lower.startsWith(prefix) && suffixes.has(lower.slice(prefix.length))) return vtab
  }
  return null
}

const KNOWN = new Set(["fts5", "fts4", "fts3", "rtree", "rtree_i32", "geopoly", "vec0"])

/**
 * For a caller that also has SQLite's own (name-based) `type = 'shadow'`: true when `name` is a
 * shadow by this module's rules, false when a virtual table this module understands has the
 * prefix but did not create it — a real table, whatever `table_list` says — and null when only a
 * module this file does not know could claim it, so SQLite's word is the best there is.
 */
export function shadowVerdict(name: string, vtabs: ReadonlyMap<string, VirtualTable>): boolean | null {
  if (shadowOwner(name, vtabs) !== null) return true
  const lower = name.toLowerCase()
  let known = false
  for (const [vtab, { module }] of vtabs) {
    if (!lower.startsWith(`${vtab.toLowerCase()}_`)) continue
    if (!KNOWN.has(module)) return null
    known = true
  }
  return known ? false : null
}

/** The query every caller runs to feed `virtualTables`. */
export const VIRTUAL_TABLES_SQL =
  "select name, sql from sqlite_schema where type = 'table' and sql like 'create virtual table%'"

// ── per module, from each module's source ──────────────────────────────────────────────────────

function shadowSuffixes(module: string, args: string[]): Set<string> {
  switch (module) {
    case "fts5":
      return fts5(args)
    case "fts3":
    case "fts4":
      return fts34(module, args)
    case "rtree":
    case "rtree_i32":
    case "geopoly":
      return new Set(["node", "parent", "rowid"])
    case "vec0":
      return vec0(args)
    default:
      return new Set()
  }
}

/** `key = value` arguments, keys lower-cased and values unquoted; anything else is a column. */
function options(args: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const arg of args) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?)\s*$/.exec(arg)
    if (m) out.set((m[1] as string).toLowerCase(), unquote(m[2] as string))
  }
  return out
}

/**
 * fts5_config.c / fts5_storage.c: `_data`, `_idx`, `_config` always; `_docsize` unless
 * `columnsize=0`; `_content` for a normal table, or a contentless one with
 * `contentless_unindexed=1` — never for external content.
 */
function fts5(args: string[]): Set<string> {
  const o = options(args)
  const out = new Set(["data", "idx", "config"])
  if (o.get("columnsize") !== "0") out.add("docsize")
  const content = o.get("content")
  if (content === undefined || (content === "" && o.get("contentless_unindexed") === "1")) out.add("content")
  return out
}

/** fts3.c: `_segments`, `_segdir`; `_content` unless `content=`; FTS4 adds `_stat`, `_docsize`. */
function fts34(module: string, args: string[]): Set<string> {
  const o = options(args)
  const out = new Set(["segments", "segdir"])
  if (module === "fts3" || !o.has("content")) out.add("content")
  if (module === "fts4") {
    out.add("stat")
    if (o.get("matchinfo") !== "fts3") out.add("docsize")
  }
  return out
}

/**
 * sqlite-vec.c `vec0_init`: `_info`, `_chunks`, `_rowids` always; `_vector_chunksNN` per vector
 * column; `_metadatachunksNN` per metadata column plus `_metadatatextNN` for a text one;
 * `_auxiliary` when there is any `+column`. Partition keys, the primary key and table options
 * (`chunk_size=…`) make no table. An argument none of those rules recognises adds nothing.
 */
function vec0(args: string[]): Set<string> {
  const out = new Set(["info", "chunks", "rowids"])
  let vectors = 0
  let metadata = 0
  let aux = false
  for (const raw of args) {
    const arg = raw.trim()
    if (arg.startsWith("+")) {
      aux = true
    } else if (/^\S+\s+(?:float32|float|f32|int8|i8|bit)\s*\[/i.test(arg)) {
      out.add(`vector_chunks${pad(vectors++)}`)
    } else if (/\b(?:partition\s+key|primary\s+key)\b/i.test(arg) || /^\S+\s*=/.test(arg)) {
      // No table of its own.
    } else {
      const type = /^\S+\s+(boolean|bool|integer64|integer|int64|int|float64|float|double|f64|text)\b/i.exec(arg)?.[1]?.toLowerCase()
      if (!type) continue
      const n = pad(metadata++)
      out.add(`metadatachunks${n}`)
      if (type === "text") out.add(`metadatatext${n}`)
    }
  }
  if (aux) out.add("auxiliary")
  return out
}

const pad = (n: number) => String(n).padStart(2, "0")

function unquote(value: string): string {
  const q = value[0]
  if ((q === "'" || q === '"' || q === "`") && value.endsWith(q) && value.length >= 2) {
    return value.slice(1, -1).replaceAll(`${q}${q}`, q)
  }
  if (q === "[" && value.endsWith("]")) return value.slice(1, -1)
  return value
}

/** Splits a module argument list on top-level commas, respecting quotes and brackets. */
function splitArgs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") quote = c
    else if (c === "(" || c === "[") depth++
    else if (c === ")" || c === "]") depth--
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  if (text.trim().length > 0) out.push(text.slice(start))
  return out
}
