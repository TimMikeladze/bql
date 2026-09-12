// Where the time in a write and a read actually goes, as opposed to what each one costs. The
// other benchmarks measure legs of the product; this one takes the two hot paths apart into the
// stages a change would target, so an optimisation can be argued for before it is written.
//
//   bun run bench/profile.ts [rounds]
//
// Not part of `bun run bench`: these are attribution numbers for `docs/performance.md`, not
// budgets, and three of the four sections deliberately measure things BunQL does not do yet
// (uncompressed records, group commit, cached token verification).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AuthKeys, KeyRing, mintToken, verifyToken } from "../src/server/auth.ts"
import { Database } from "../src/sqlite/index.ts"
import { encode, TxnLog, TxnRecorder } from "../src/wal/index.ts"
import { distribution, emit, percentile, type Sample } from "./report.ts"

const ROUNDS = Number(Bun.argv[2] ?? 3000)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-profile-"))
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))

const us = (ns: number) => ns / 1000
const legs: Record<string, Sample> = {}

function rig(name: string) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, "main.db")
  const db = Database.open(dbPath)
  db.exec("pragma synchronous = normal")
  db.exec("pragma wal_autocheckpoint = 0")
  db.exec("create table t(id integer primary key, v text, n real)")
  db.walCheckpoint("TRUNCATE")
  return {
    db,
    dbPath,
    dir,
    recorder: TxnRecorder.open({ dbPath, epoch: 1 }),
    log: TxnLog.open({ dir, fsync: "never" }),
    insert: db.prepare("insert into t(v, n) values (?, ?)"),
  }
}

const lines: string[] = []
const say = (text = "") => {
  lines.push(text)
  console.log(text)
}

// ── 1. the write path, stage by stage, at one row per transaction ───────────────────────────────
//
// One row per transaction is the shape that matters: every statement through `/v1/db/:db/query` is
// its own transaction, so the fixed cost of a transaction is paid per row.
{
  const r = rig("stages")
  const commit: number[] = []
  const poll: number[] = []
  const enc: number[] = []
  const append: number[] = []
  for (let i = 0; i < ROUNDS; i++) {
    let t = Bun.nanoseconds()
    r.db.exec("begin immediate")
    r.insert.run(`v${i}`, i)
    r.db.exec("commit")
    commit.push(us(Bun.nanoseconds() - t))

    t = Bun.nanoseconds()
    const records = r.recorder.poll()
    poll.push(us(Bun.nanoseconds() - t))

    for (const record of records) {
      t = Bun.nanoseconds()
      const bytes = encode(record)
      enc.push(us(Bun.nanoseconds() - t))
      t = Bun.nanoseconds()
      r.log.appendEncoded(bytes)
      append.push(us(Bun.nanoseconds() - t))
    }
  }
  const stages: [string, number[]][] = [
    ["BEGIN IMMEDIATE + insert + COMMIT", commit],
    ["recorder.poll — tail the WAL, checksum", poll],
    ["encode — frame the record, zstd level 3", enc],
    ["log.appendEncoded — write the segment", append],
  ]
  const total = stages.reduce((n, [, xs]) => n + percentile(xs, 50), 0)
  say("WRITE PATH — one row per transaction, µs")
  say()
  for (const [name, xs] of stages) {
    const p50 = percentile(xs, 50)
    legs[name] = distribution(xs)
    say(
      `  ${name.padEnd(42)} p50 ${p50.toFixed(2).padStart(6)}  p90 ${percentile(xs, 90)
        .toFixed(2)
        .padStart(6)}   ${((p50 / total) * 100).toFixed(0).padStart(3)}%`,
    )
  }
  say(`  ${"".padEnd(42)} p50 ${total.toFixed(2).padStart(6)}`)
  say()
  r.db.close()
}

// ── 2. what compression costs against what it saves ─────────────────────────────────────────────
{
  const r = rig("compress")
  const payloads: Uint8Array[] = []
  for (let i = 0; i < Math.min(ROUNDS, 800); i++) {
    r.db.exec("begin immediate")
    r.insert.run(`v${i}`, i)
    r.db.exec("commit")
    for (const record of r.recorder.poll()) {
      const pgnos = [...record.pages.keys()].sort((a, b) => a - b)
      const plain = new Uint8Array(pgnos.length * (4 + record.pageSize))
      const view = new DataView(plain.buffer)
      let at = 0
      for (const pgno of pgnos) {
        view.setUint32(at, pgno, true)
        plain.set(record.pages.get(pgno) as Uint8Array, at + 4)
        at += 4 + record.pageSize
      }
      payloads.push(plain)
      r.log.appendEncoded(encode(record))
    }
  }
  const plainBytes = payloads.reduce((n, p) => n + p.byteLength, 0) / payloads.length
  say("COMPRESSION — the record body of a single-row transaction")
  say()
  say(`  plain                                   ${plainBytes.toFixed(0).padStart(6)} bytes`)
  for (const level of [3, 1, 0]) {
    const times: number[] = []
    let out = 0
    for (const plain of payloads) {
      const t = Bun.nanoseconds()
      const body = level === 0 ? plain : new Uint8Array(Bun.zstdCompressSync(plain, { level }))
      times.push(us(Bun.nanoseconds() - t))
      out += body.byteLength
    }
    const avg = out / payloads.length
    const label = level === 0 ? "no compression" : `zstd level ${level}`
    legs[`encode, ${label}`] = distribution(times)
    say(
      `  ${label.padEnd(38)} ${percentile(times, 50).toFixed(2).padStart(6)} µs  ` +
        `${avg.toFixed(0).padStart(5)} bytes  ${(plainBytes / avg).toFixed(1)}x`,
    )
  }
  say()
  r.db.close()
}

// ── 3. group commit: what the fixed cost of a transaction amortises to ──────────────────────────
{
  say("GROUP COMMIT — the same rows, more of them per transaction")
  say()
  say("  rows/txn    µs/row    implied rows/s")
  for (const rows of [1, 2, 5, 10, 50, 200]) {
    const r = rig(`group${rows}`)
    const each: number[] = []
    const iterations = Math.max(40, Math.floor(ROUNDS / rows))
    for (let i = 0; i < iterations; i++) {
      const t = Bun.nanoseconds()
      r.db.exec("begin immediate")
      for (let j = 0; j < rows; j++) r.insert.run(`v${i}-${j}`, j)
      r.db.exec("commit")
      for (const record of r.recorder.poll()) r.log.appendEncoded(encode(record))
      each.push(us(Bun.nanoseconds() - t) / rows)
    }
    const perRow = percentile(each, 50)
    legs[`group commit, ${rows} rows/txn`] = { p50: perRow, unit: "us" }
    say(
      `  ${String(rows).padStart(8)}    ${perRow.toFixed(2).padStart(6)}    ${(1e6 / perRow)
        .toFixed(0)
        .padStart(13)}`,
    )
    r.db.close()
  }
  say()
}

// ── 4. authentication, which every HTTP request pays and no benchmark measures ──────────────────
//
// `bench/http-client.ts` sends the admin key, which is a constant-time compare. A deployed client
// sends a signed token, and that is a signature verification per request.
{
  const keys = await AuthKeys.generate()
  const ring = new KeyRing([keys])
  const token = await mintToken(keys, { rw: ["acme"], ttlMs: 3_600_000 })
  const xs: number[] = []
  for (let i = 0; i < Math.min(ROUNDS, 2000); i++) {
    const t = Bun.nanoseconds()
    await verifyToken(ring, token, { now: Date.now() })
    xs.push(us(Bun.nanoseconds() - t))
  }
  legs["EdDSA token verification"] = distribution(xs)
  say("AUTHENTICATION — per request over HTTP")
  say()
  say(
    `  verifyToken, EdDSA                      ${percentile(xs, 50).toFixed(2).padStart(6)} µs  ` +
      `p90 ${percentile(xs, 90).toFixed(2)}`,
  )
  say("  the admin key path is a constant-time compare and costs nothing like this")
  say()
}

say(
  `bunql profile · ${ROUNDS} rounds · Bun ${Bun.version} · ${process.platform}/${process.arch}`,
)
emit({ bench: "profile", legs })
