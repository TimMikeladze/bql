// Full-text search over FTS5: an index, the triggers that keep an external-content index in step
// with its source table, and a query escaper for text nobody vetted.
//
// Invariant: an external-content index is only ever written by its three triggers (and by
// `rebuild`). FTS5 cannot tell when its content table changed, and a row deleted from the source
// without the matching `'delete'` command leaves stale tokens that match forever — so the helper
// installs all three or none, in the same batch as the table.

import { BqlClientError } from "../client/errors.ts"
import type { JsValue } from "../client/values.ts"
import { ident, literal, positiveInt, requireFeatures, run, runAll, type SearchDb } from "./run.ts"

export interface FtsIndexOptions {
  /** The FTS5 virtual table. */
  table: string
  /** Indexed columns. With `source`, columns of the source table of the same names. */
  columns: string[]
  /**
   * A table to index. The FTS5 table becomes external-content — it stores tokens, not a second
   * copy of the text — and triggers on the source keep it in step.
   */
  source?: string
  /** The source's integer key, which becomes the index's rowid. Default `"rowid"`. */
  sourceKey?: string
  /** FTS5's `tokenize` option, e.g. `"porter unicode61"` or `"trigram"`. Default FTS5's own. */
  tokenizer?: string
}

export interface FtsMarkup {
  /** Default the first indexed column. */
  column?: string
  /** Default `<b>`. */
  open?: string
  /** Default `</b>`. */
  close?: string
}

export interface FtsSnippet extends Omit<FtsMarkup, "column"> {
  /** Default: whichever column matched best. */
  column?: string
  /** Default `…`. */
  ellipsis?: string
  /** Tokens in the snippet, 1 to 64. Default 12. */
  tokens?: number
}

export interface FtsSearchOptions {
  /** Default 20. */
  limit?: number
  offset?: number
  /** Adds a `highlight` column: the whole column text with each match wrapped. */
  highlight?: boolean | FtsMarkup
  /** Adds a `snippet` column: a short window around the matches. */
  snippet?: boolean | FtsSnippet
}

/**
 * One hit. `rank` is FTS5's bm25, where **lower is better** (it is negative); rows come back
 * sorted by it. The indexed columns ride along — from the source table, for an external index.
 */
export type FtsMatch = { rowid: number; rank: number; highlight?: string; snippet?: string } & Record<
  string,
  JsValue
>

export class FtsIndex {
  readonly table: string
  readonly columns: readonly string[]
  readonly source: string | null
  readonly #db: SearchDb
  readonly #t: string
  readonly #cols: string[]
  readonly #key: string
  readonly #tokenizer: string | null

  constructor(db: SearchDb, options: FtsIndexOptions) {
    this.#db = db
    this.#t = ident(options.table, "table")
    this.table = options.table
    if (!Array.isArray(options.columns) || options.columns.length === 0) {
      throw BqlClientError.client("an FTS index needs at least one column")
    }
    this.#cols = options.columns.map((c) => ident(c, "column"))
    this.columns = [...options.columns]
    this.source = options.source ?? null
    if (this.source !== null) ident(this.source, "source table")
    const key = options.sourceKey ?? "rowid"
    this.#key = key === "rowid" ? "rowid" : ident(key, "sourceKey")
    this.#tokenizer = options.tokenizer ?? null
  }

  /** The DDL `create()` runs: the table, and for an external index its three triggers. */
  get ddl(): string[] {
    const options = [...this.#cols]
    if (this.source !== null) {
      options.push(`content=${literal(this.source)}`)
      options.push(`content_rowid=${literal(this.#key === "rowid" ? "rowid" : this.#key.slice(1, -1))}`)
    }
    if (this.#tokenizer !== null) options.push(`tokenize=${literal(this.#tokenizer)}`)
    const out = [`create virtual table if not exists ${this.#t} using fts5(${options.join(", ")})`]
    if (this.source === null) return out

    const src = ident(this.source)
    const cols = this.#cols.join(", ")
    const as = (row: "new" | "old") => this.#cols.map((c) => `${row}.${c}`).join(", ")
    const add = `insert into ${this.#t}(rowid, ${cols}) values (new.${this.#key}, ${as("new")});`
    const remove =
      `insert into ${this.#t}(${this.#t}, rowid, ${cols}) ` +
      `values ('delete', old.${this.#key}, ${as("old")});`
    const trigger = (suffix: string) => ident(`${this.table}_${suffix}`, "trigger")
    out.push(
      `create trigger if not exists ${trigger("ai")} after insert on ${src} begin ${add} end`,
      `create trigger if not exists ${trigger("ad")} after delete on ${src} begin ${remove} end`,
      // Only when an indexed column (or the key) changed: an update to anything else would
      // otherwise re-tokenize the row for nothing.
      `create trigger if not exists ${trigger("au")} after update of ${
        this.#key === "rowid" ? "" : `${this.#key}, `
      }${cols} on ${src} begin ${remove} ${add} end`,
    )
    return out
  }

  /**
   * Creates the index. An external index is filled from the source's existing rows the first
   * time, in the same batch, so it never starts out missing them.
   */
  async create(): Promise<void> {
    await requireFeatures(this.#db, "fts5")
    const statements = this.ddl.map((sql) => ({ sql }))
    if (this.source !== null) {
      const exists = await run(this.#db, "select 1 from sqlite_schema where type = 'table' and name = ?", [
        this.table,
      ])
      if (exists.length === 0) statements.push({ sql: this.#rebuildSql() })
    }
    await runAll(this.#db, statements)
  }

  async drop(): Promise<void> {
    const statements = [{ sql: `drop table if exists ${this.#t}` }]
    if (this.source !== null) {
      for (const suffix of ["ai", "ad", "au"]) {
        statements.push({ sql: `drop trigger if exists ${ident(`${this.table}_${suffix}`)}` })
      }
    }
    await runAll(this.#db, statements)
  }

  /** Re-derives the whole index from its content: the source table, or its own stored text. */
  async rebuild(): Promise<void> {
    await run(this.#db, this.#rebuildSql())
  }

  /** Adds or replaces a document. Only for an index without `source`; that one follows its table. */
  async upsert(rowid: number, doc: Record<string, string | null>): Promise<void> {
    this.#standalone("upsert")
    const key = this.#rowid(rowid)
    const values = this.columns.map((c) => doc[c] ?? null)
    await runAll(this.#db, [
      { sql: `delete from ${this.#t} where rowid = ?`, args: [key] },
      {
        sql: `insert into ${this.#t}(rowid, ${this.#cols.join(", ")}) values (?${", ?".repeat(values.length)})`,
        args: [key, ...values],
      },
    ])
  }

  async delete(rowid: number): Promise<void> {
    this.#standalone("delete")
    await run(this.#db, `delete from ${this.#t} where rowid = ?`, [this.#rowid(rowid)])
  }

  /** Matches for an FTS5 query, best first. Untrusted text goes through `ftsQuote` first. */
  async search(query: string, options: FtsSearchOptions = {}): Promise<FtsMatch[]> {
    if (typeof query !== "string") throw BqlClientError.client("an FTS query is a string")
    const limit = positiveInt(options.limit ?? 20, "limit", 10_000)
    const offset = options.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0) throw BqlClientError.client("offset must be >= 0")

    const select = ["rowid", "rank", ...this.#cols]
    const args: unknown[] = []
    if (options.highlight) {
      const h = options.highlight === true ? {} : options.highlight
      select.push(`highlight(${this.#t}, ${this.#index(h.column ?? this.columns[0])}, ?, ?) as highlight`)
      args.push(h.open ?? "<b>", h.close ?? "</b>")
    }
    if (options.snippet) {
      const s = options.snippet === true ? {} : options.snippet
      const column = s.column === undefined ? -1 : this.#index(s.column)
      const tokens = positiveInt(s.tokens ?? 12, "snippet.tokens", 64)
      select.push(`snippet(${this.#t}, ${column}, ?, ?, ?, ${tokens}) as snippet`)
      args.push(s.open ?? "<b>", s.close ?? "</b>", s.ellipsis ?? "…")
    }
    args.push(query, limit, offset)
    const rows = await run(
      this.#db,
      `select ${select.join(", ")} from ${this.#t} where ${this.#t} match ? order by rank limit ? offset ?`,
      args,
    )
    return rows as FtsMatch[]
  }

  #rebuildSql(): string {
    return `insert into ${this.#t}(${this.#t}) values ('rebuild')`
  }

  #standalone(what: string): void {
    if (this.source !== null) {
      throw BqlClientError.client(
        `${this.table} follows ${this.source} through triggers; write to ${this.source} instead of calling ${what}()`,
      )
    }
  }

  #rowid(rowid: number): number {
    if (!Number.isSafeInteger(rowid)) throw BqlClientError.client(`rowid must be an integer, got ${rowid}`)
    return rowid
  }

  #index(column: string | undefined): number {
    const i = column === undefined ? -1 : this.columns.indexOf(column)
    if (i < 0) throw BqlClientError.client(`${this.table} does not index a column ${JSON.stringify(column)}`)
    return i
  }
}

export function ftsIndex(db: SearchDb, options: FtsIndexOptions): FtsIndex {
  return new FtsIndex(db, options)
}

export interface FtsQuoteOptions {
  /** `"all"` (default) matches every word, `"any"` at least one, `"phrase"` the words in order. */
  mode?: "all" | "any" | "phrase"
  /** Treat the last word as a prefix, for search-as-you-type. */
  prefix?: boolean
}

/**
 * Untrusted text as an FTS5 query that means only "these words". Every word becomes a quoted
 * string, so `AND`, `NEAR(`, `col:`, `*` and a stray `"` are text, not syntax — which also means
 * user input can never make MATCH throw a syntax error. Empty input gives `""`, which matches
 * nothing.
 */
export function ftsQuote(text: string, options: FtsQuoteOptions = {}): string {
  const words = String(text).split(/\s+/u).filter((w) => w.length > 0)
  if (words.length === 0) return '""'
  const quote = (w: string) => `"${w.replaceAll('"', '""')}"`
  const star = options.prefix ? "*" : ""
  if (options.mode === "phrase") return `${quote(words.join(" "))}${star}`
  const parts = words.map(quote)
  parts[parts.length - 1] += star
  return parts.join(options.mode === "any" ? " OR " : " ")
}
