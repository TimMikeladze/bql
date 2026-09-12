// Invariant: this module never decides what a statement *does* — only whether it is one of the
// four verbs that move a connection's transaction state, and where one statement ends and the
// next begins. Everything else is SQLite's job, through `sqlite3_stmt_readonly` and the
// authorizer, exactly as `../exec.ts` has it.
//
// Both jobs exist because Hrana hands us transaction control as ordinary statements. `BEGIN` sent
// to `executeStatement` would be wrapped in its own `BEGIN IMMEDIATE` and fail; `COMMIT` sent to
// `executeInTx` would commit behind the tenant's back and leave it believing a transaction is
// still open. So the four verbs are intercepted here and turned into `runtime.beginTx`/`endTx`.
//
// The splitter is `sqlite3_complete`'s rule rather than "split on semicolons": a semicolon inside
// a string, an identifier, a comment, or a `CREATE TRIGGER … BEGIN … END` body does not end a
// statement, and a migration script that got that wrong would apply half of itself.

export type TxVerb =
  /** `readonly` is `BEGIN TRANSACTION READONLY`, which is not SQLite syntax — see `txVerb`. */
  | { kind: "begin"; mode: "deferred" | "immediate" | "exclusive"; readonly: boolean }
  | { kind: "commit" }
  | { kind: "rollback" }
  | null

/** Index of the first character that is neither whitespace nor a comment. */
function skipBlanks(sql: string, from: number): number {
  let i = from
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i] as string)) i++
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i)
      if (nl < 0) return sql.length
      i = nl + 1
      continue
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      if (end < 0) return sql.length
      i = end + 2
      continue
    }
    return i
  }
}

/** The bare words of `sql`, lower-cased, up to `limit` of them. Quoted text is not a word. */
function leadingWords(sql: string, limit: number): string[] {
  const words: string[] = []
  let i = skipBlanks(sql, 0)
  while (words.length < limit && i < sql.length) {
    const start = i
    while (i < sql.length && /[A-Za-z_]/.test(sql[i] as string)) i++
    if (i === start) break
    words.push(sql.slice(start, i).toLowerCase())
    const next = skipBlanks(sql, i)
    if (next === i && i < sql.length) break
    i = next
  }
  return words
}

/**
 * The transaction verb a statement is, or null for everything else. `ROLLBACK TO <savepoint>` is
 * deliberately *not* a rollback: it unwinds to a savepoint inside a transaction that stays open,
 * so it belongs on the ordinary statement path.
 *
 * `BEGIN TRANSACTION READONLY` is `@libsql/client`'s read-transaction spelling and is not SQLite
 * syntax; it opens a deferred transaction here and reports `readonly`, which is what
 * `../hrana/execute.ts` needs to refuse a write inside it. A bare `BEGIN` is deferred, as SQLite
 * defines it.
 */
export function txVerb(sql: string): TxVerb {
  const words = leadingWords(sql, 4)
  const first = words[0]
  if (first === "begin") {
    let at = 1
    if (words[at] === "transaction") at++
    const mode = words[at]
    if (mode === "immediate") return { kind: "begin", mode: "immediate", readonly: false }
    if (mode === "exclusive") return { kind: "begin", mode: "exclusive", readonly: false }
    // "deferred", "readonly", or nothing at all.
    return { kind: "begin", mode: "deferred", readonly: mode === "readonly" }
  }
  if (first === "commit") return { kind: "commit" }
  if (first === "end") {
    // `END` closes a transaction; `END` inside a trigger body never reaches here as a statement.
    return { kind: "commit" }
  }
  if (first === "rollback") {
    if (words[1] === "to" || (words[1] === "transaction" && words[2] === "to")) return null
    return { kind: "rollback" }
  }
  return null
}

/** True when the statement is an `EXPLAIN` or `EXPLAIN QUERY PLAN`, for `describe`. */
export function isExplain(sql: string): boolean {
  return leadingWords(sql, 1)[0] === "explain"
}

/**
 * Splits a script into statements the way `sqlite3_complete` decides a statement is complete:
 * a `;` outside every quote and comment ends one, unless the statement opened a `CREATE TRIGGER`
 * body, in which case it takes an `END` first. Trailing whitespace-only fragments are dropped, so
 * a script that ends in `;` yields no empty last statement.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  // Words seen since the statement began, enough to recognise CREATE [TEMP] TRIGGER.
  let words = 0
  let isCreate = false
  let isTrigger = false
  let bodyDepth = 0

  const reset = (): void => {
    words = 0
    isCreate = false
    isTrigger = false
    bodyDepth = 0
  }

  while (i < script.length) {
    const c = script[i] as string
    if (c === "-" && script[i + 1] === "-") {
      const nl = script.indexOf("\n", i)
      i = nl < 0 ? script.length : nl + 1
      continue
    }
    if (c === "/" && script[i + 1] === "*") {
      const end = script.indexOf("*/", i + 2)
      i = end < 0 ? script.length : end + 2
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      i = closingQuote(script, i, c)
      words++
      continue
    }
    if (c === "[") {
      const end = script.indexOf("]", i + 1)
      i = end < 0 ? script.length : end + 1
      words++
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const from = i
      while (i < script.length && /[A-Za-z0-9_$]/.test(script[i] as string)) i++
      const word = script.slice(from, i).toLowerCase()
      if (words === 0 && word === "explain") {
        // `sqlite3_complete` skips a leading EXPLAIN, so `explain create trigger …` still needs
        // its `END`. Leaving `words` at 0 is what lets the next word be treated as the first.
        continue
      }
      if (words === 0 && word === "create") {
        isCreate = true
      } else if (isCreate && !isTrigger && word === "trigger") {
        isTrigger = true
      } else if (isTrigger && word === "begin") {
        bodyDepth++
      } else if (isTrigger && word === "end" && bodyDepth > 0) {
        bodyDepth--
      }
      words++
      continue
    }
    if (c === ";") {
      if (!isTrigger || bodyDepth === 0) {
        push(out, script, start, i)
        start = i + 1
        reset()
      }
      i++
      continue
    }
    if (!/\s/.test(c)) words++
    i++
  }
  push(out, script, start, script.length)
  return out
}

/**
 * Adds `script[start, end)` as a statement, minus the whitespace and comments in front of it. A
 * fragment that is nothing but a comment adds nothing: `sqlite3_prepare` refuses SQL with no
 * statement in it, and a script ending in a comment is not a client error.
 */
function push(out: string[], script: string, start: number, end: number): void {
  const from = Math.min(skipBlanks(script, start), end)
  const piece = script.slice(from, end).trim()
  if (piece.length > 0) out.push(piece)
}

/** Index just past the closing quote of the literal starting at `i`, doubled quotes included. */
function closingQuote(sql: string, i: number, quote: string): number {
  let at = i + 1
  while (at < sql.length) {
    if (sql[at] === quote) {
      if (sql[at + 1] === quote) {
        at += 2
        continue
      }
      return at + 1
    }
    at++
  }
  return sql.length
}
