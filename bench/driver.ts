// Driver benchmark: the bun:ffi driver against bun:sqlite on the same file, same schema, same
// pragmas. bun:sqlite is imported here and in tests only; src/ never touches it.
//
//   bun run bench/driver.ts

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { Database, sqlite } from "../src/sqlite/index.ts"

const ROWS = 100_000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-bench-"))
const file = path.join(dir, "bench.db")
// Registered up front so a benchmark that throws still leaves no database behind.
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }))

interface Result {
  op: string
  ours: number
  theirs: number | null
}

const results: Result[] = []

function time(iterations: number, fn: (i: number) => void): number {
  fn(0)
  const started = Bun.nanoseconds()
  for (let i = 0; i < iterations; i++) fn(i)
  return (Bun.nanoseconds() - started) / 1000 / iterations
}

const db = Database.open(file)
db.exec("pragma synchronous = normal")
db.exec("create table kv(k integer primary key, v text, n integer)")

const insert = db.prepare("insert into kv(k, v, n) values (?, ?, ?)")
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(i, "value-xxxxxxx", i * 3)
})()

const reference = new BunDatabase(file)
reference.exec("pragma synchronous = normal")

// --- point read -------------------------------------------------------------------------------
const get = db.prepare("select v from kv where k = ?")
const referenceGet = reference.query("select v from kv where k = ?")
results.push({
  op: "point read by primary key -> object",
  ours: time(200_000, (i) => void get.get(i % ROWS)),
  theirs: time(200_000, (i) => void referenceGet.get(i % ROWS)),
})

const getRow = db.prepare("select k, v, n from kv where k = ?")
const referenceGetRow = reference.query("select k, v, n from kv where k = ?")
results.push({
  op: "point read, 3 columns",
  ours: time(200_000, (i) => void getRow.get(i % ROWS)),
  theirs: time(200_000, (i) => void referenceGetRow.get(i % ROWS)),
})

const getValues = db.prepare("select k, v, n from kv where k = ?")
const referenceGetValues = reference.query("select k, v, n from kv where k = ?")
results.push({
  op: "point read, 3 columns, values()",
  ours: time(200_000, (i) => void getValues.values(i % ROWS)),
  theirs: time(200_000, (i) => void referenceGetValues.values(i % ROWS)),
})

// --- scans ------------------------------------------------------------------------------------
const scan = db.prepare("select k, v, n from kv where k between ? and ?")
const referenceScan = reference.query("select k, v, n from kv where k between ? and ?")
results.push({
  op: "100-row scan -> objects",
  ours: time(5_000, (i) => void scan.all(i % 1000, (i % 1000) + 99)),
  theirs: time(5_000, (i) => void referenceScan.all(i % 1000, (i % 1000) + 99)),
})

// --- writes -----------------------------------------------------------------------------------
// Keys come from a monotonic counter, never from the loop index, because `time()` runs one
// warm-up call first and a repeated key would collide with the primary key.
let nextKey = ROWS
const insertOurs = db.prepare("insert into kv(k, v, n) values (?, ?, ?)")
const insertTheirs = reference.query("insert into kv(k, v, n) values (?, ?, ?)")
const writeOurs = () => void insertOurs.run(nextKey++, "value-xxxxxxx", 1)
const writeTheirs = () => void insertTheirs.run(nextKey++, "value-xxxxxxx", 1)

/** Times `run` with the whole loop wrapped in one transaction. */
function inTransaction(begin: (fn: () => void) => void, run: () => void, iterations: number) {
  let micros = 0
  begin(() => {
    micros = time(iterations, run)
  })
  return micros
}

results.push({
  op: "insert inside a transaction",
  ours: inTransaction((fn) => db.transaction(fn)(), writeOurs, 100_000),
  theirs: inTransaction((fn) => reference.transaction(fn)(), writeTheirs, 100_000),
})

let hookCalls = 0
db.onUpdate(() => hookCalls++)
results.push({
  op: "insert inside a transaction, update hook on",
  ours: inTransaction((fn) => db.transaction(fn)(), writeOurs, 100_000),
  theirs: null,
})
db.onUpdate(null)

results.push({
  op: "single-row autocommit insert (WAL, synchronous=NORMAL)",
  ours: time(5_000, writeOurs),
  theirs: time(5_000, writeTheirs),
})

// --- report -----------------------------------------------------------------------------------
const lib = sqlite()
console.log(`bunql driver bench — ${lib.path} ${lib.version}, Bun ${Bun.version}, ${ROWS} rows`)
console.log(`update hook fired ${hookCalls.toLocaleString()} times\n`)
const width = Math.max(...results.map((r) => r.op.length))
console.log(
  `${"op".padEnd(width)}  ${"bunql".padStart(10)}  ${"bun:sqlite".padStart(11)}  ${"speedup".padStart(8)}`,
)
console.log("-".repeat(width + 36))
for (const r of results) {
  const theirs = r.theirs === null ? "—" : `${r.theirs.toFixed(2)} µs`
  const speedup = r.theirs === null ? "—" : `${(r.theirs / r.ours).toFixed(2)}x`
  console.log(
    `${r.op.padEnd(width)}  ${`${r.ours.toFixed(2)} µs`.padStart(10)}  ${theirs.padStart(11)}  ${speedup.padStart(8)}`,
  )
}

const pointRead = results[0]?.ours ?? Infinity
const TARGET = 1.2
console.log(
  `\npoint read target ≤ ${TARGET.toFixed(2)} µs: ${pointRead.toFixed(2)} µs ` +
    `${pointRead <= TARGET ? "PASS" : "FAIL"}`,
)

db.close()
reference.close()
if (pointRead > TARGET) process.exit(1)
