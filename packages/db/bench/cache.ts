// P7's instrument: what `Database.prepare`'s statement cache is worth, and whether its 64-entry
// ceiling binds on a realistic working set.
//
//   bun run bench/cache.ts [rounds] [--texts N]
//
// Three legs, and the third is the milestone's question:
//
//   hit      prepare() the same SQL text repeatedly     — a Map lookup and two Map writes
//   miss     prepare() a text the cache cannot hold     — sqlite3_prepare_v3 every time
//   working  cycle W distinct texts through the cache   — W <= 64 hits, W > 64 thrashes
//
// Then one census, which is P7's other question: the hit rate the default 64 gets on the SQL the
// *data API* generates, replayed through the real `introspect` and `buildStatement` rather than
// through a guess at their shape. Reported as counters, not as a duration, because the number
// that matters there is how often the ceiling is reached rather than what a prepare costs.
//
// A thrashing cache is not a slow cache: every prepare compiles *and* finalizes an eviction
// victim, so the interesting number is the cliff between W = 64 and W = 65 rather than either
// side of it. Interleaved A-B-A-B because this machine is rarely quiet (docs/performance.md §8).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildStatement,
  type ColumnInfo,
  type Condition,
  type DataRows,
  type DataStatement,
  introspect,
  type ListPlan,
  type TableInfo,
} from "../src/dataapi/index.ts"
import { Database } from "../src/sqlite/index.ts"
import { emit, percentile, wantsJson, type Sample } from "./report.ts"

const ROUNDS = Number(Bun.argv[2] ?? 5)
const textsAt = Bun.argv.indexOf("--texts")
const WORKING = textsAt >= 0 ? Bun.argv[textsAt + 1]!.split(",").map(Number) : [8, 32, 64, 65, 96, 256]
const ITER = 20_000

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-cache-"))
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }))
const db = Database.open(path.join(dir, "cache.db"))
db.exec("pragma synchronous = normal")
// Wide enough that compiling is real work rather than a parse of `select 1`: the data API
// generates statements of about this shape against every table it introspects.
db.exec("create table kv(k integer primary key, v text, n integer, t text, u text)")
db.exec("create index kv_n on kv(n)")
db.exec("insert into kv(k, v, n, t, u) values (1, 'a', 1, 'b', 'c')")

/** `W` distinct SQL texts that all compile to real plans and differ only in a literal. */
function texts(w: number): string[] {
  const out: string[] = []
  for (let i = 0; i < w; i++) {
    out.push(`select k, v, n, t, u from kv where n >= ${i} and k = ? order by n limit 10`)
  }
  return out
}

function time(iterations: number, fn: (i: number) => void): number {
  fn(0)
  const started = Bun.nanoseconds()
  for (let i = 0; i < iterations; i++) fn(i)
  return (Bun.nanoseconds() - started) / 1000 / iterations
}

/** One `prepare()` per iteration, nothing else — the cache is the whole measurement. */
function cycle(list: readonly string[]): number {
  return time(ITER, (i) => void db.prepare(list[i % list.length] as string))
}

/** A miss every time: `prepare` is bypassed so nothing is ever cached. */
const missText = texts(1)[0] as string
function missOnce(): number {
  return time(2_000, () => {
    const stmt = db.prepare(missText)
    // Drop it straight back out of the cache, so the next prepare recompiles.
    stmt.finalize()
  })
}

const rows: { leg: string; samples: number[] }[] = []
function record(leg: string, value: number): void {
  const found = rows.find((r) => r.leg === leg)
  if (found) found.samples.push(value)
  else rows.push({ leg, samples: [value] })
}

const one = texts(1)
for (let round = 0; round < ROUNDS; round++) {
  // Interleaved: every leg is measured in every round, so a load spike hits all of them.
  record("hit", cycle(one))
  record("miss", missOnce())
  for (const w of WORKING) record(`working ${w}`, cycle(texts(w)))
}

const legs: Record<string, Sample> = {}
console.log(`\ncache — ${ROUNDS} interleaved rounds, ${ITER} prepares per sample\n`)
console.log("leg                 p50 µs     min     max   vs hit")
const hitP50 = percentile(rows.find((r) => r.leg === "hit")!.samples, 50)
for (const { leg, samples } of rows) {
  const p50 = percentile(samples, 50)
  legs[leg] = { p50, value: p50 / hitP50, unit: "us" }
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  console.log(
    `${leg.padEnd(18)} ${p50.toFixed(3).padStart(7)} ${min.toFixed(3).padStart(7)} ` +
      `${max.toFixed(3).padStart(7)}   ${(p50 / hitP50).toFixed(2)}x`,
  )
}
console.log(
  "\nThe cliff to read is `working 64` against `working 65`: same work, one eviction per prepare.",
)

// ── the data API's own working set ─────────────────────────────────────────────────────────────

/**
 * What the generated data API asks of one connection, replayed through the real generator: the
 * table count is the lever, because every table contributes its own texts and they share a cache.
 */
async function dataApiCensus(tables: number, statementCache: number): Promise<void> {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-cache-api-"))
  const api = Database.open(path.join(dir2, "api.db"), { statementCache })
  for (let t = 0; t < tables; t++) {
    api.exec(
      `create table t${t}(id integer primary key, name text not null, owner integer, ` +
        `status text, amount real, created text)`,
    )
    api.run(`insert into t${t}(name, owner, status, amount, created) values (?,?,?,?,?)`, [
      "a",
      1,
      "open",
      1.5,
      "2026-01-01",
    ])
  }
  const exec = (statement: DataStatement): DataRows => {
    const stmt = api.prepare(statement.sql)
    const rows = stmt.values(...(statement.args as never[]))
    return { columns: stmt.columnNames, rows, rowsAffected: 0, txid: 0 }
  }
  const schema = await introspect("bench", exec)

  const col = (table: TableInfo, name: string): ColumnInfo =>
    table.columns.find((one) => one.name === name) as ColumnInfo

  /** One pass over every table's twelve texts, in the order a mixed workload would touch them. */
  function pass(): void {
  for (const table of schema.tables) {
    const id = col(table, "id")
    const all = table.columns
    const key: Condition[] = [{ column: id, operator: "eq", values: [1] }]
    // GET /{table}/{id}, and the same with a `?select=` narrowing — two texts.
    api.prepare(buildStatement({ kind: "get", table, select: all, key }).sql)
    api.prepare(buildStatement({ kind: "get", table, select: [id, col(table, "name")], key }).sql)
    // GET /{table} with no filter, with one filter, with two, and ordered — four more.
    const plans = [
      { select: all, where: [], order: [], limit: 50, offset: 0 },
      {
        select: all,
        where: [{ column: col(table, "status"), operator: "eq", values: ["open"] }],
        order: [],
        limit: 50,
        offset: 0,
      },
      {
        select: all,
        where: [
          { column: col(table, "status"), operator: "eq", values: ["open"] },
          { column: col(table, "owner"), operator: "gte", values: [1] },
        ],
        order: [],
        limit: 50,
        offset: 0,
      },
      {
        select: all,
        where: [],
        order: [{ column: col(table, "created"), descending: true }],
        limit: 50,
        offset: 0,
      },
    ] satisfies ListPlan[]
    for (const plan of plans) api.prepare(buildStatement({ kind: "list", table, plan }).sql)
    // PATCH and DELETE — one text each for the common single-column update.
    api.prepare(
      buildStatement({
        kind: "update",
        table,
        set: [{ column: col(table, "status"), value: "done" }],
        key,
        returning: all,
      }).sql,
    )
    api.prepare(buildStatement({ kind: "delete", table, key, returning: all }).sql)
    // POST of 1, 2, 3 … rows. `insertStatement` repeats its placeholder group per row, so a bulk
    // insert is a distinct text *per row count* — the clearest generator of pressure in the tree.
    const writable = all.filter((one) => one.name !== "id")
    for (const rows of [1, 2, 5, 10]) {
      api.prepare(
        buildStatement({
          kind: "insert",
          table,
          columns: writable,
          rows: Array.from({ length: rows }, () => writable.map(() => null)),
          returning: all,
        }).sql,
      )
    }
  }
  }

  // The first pass fills the cache — every text is new, so its hit rate is 0 by construction and
  // says nothing. The second is the steady state a running node is in, and the number P7 wants.
  pass()
  const before = { ...api.cacheCounters }
  pass()
  const hits = api.cacheCounters.hits - before.hits
  const misses = api.cacheCounters.misses - before.misses
  const evicted = api.cacheCounters.evictions - before.evictions
  const total = hits + misses
  console.log(
    `${String(tables).padStart(3)} tables  ${String(total).padStart(4)} texts  ` +
      `cache ${String(statementCache).padStart(4)}   ${String(hits).padStart(4)} hits  ` +
      `${String(misses).padStart(4)} misses  ${String(evicted).padStart(4)} evictions  ` +
      `${((100 * hits) / total).toFixed(1)}% hit`,
  )
  api.close()
  fs.rmSync(dir2, { recursive: true, force: true })
}

console.log("\ndata API — twelve generated texts per table, warm pass (the cold one fills the cache)\n")
for (const tables of [1, 2, 3, 4, 5, 6, 8, 16, 30]) await dataApiCensus(tables, 64)
console.log("\nThe same schemas against a raised ceiling:\n")
for (const tables of [8, 16, 30]) await dataApiCensus(tables, 512)

if (wantsJson()) emit({ bench: "cache", legs })
db.close()
