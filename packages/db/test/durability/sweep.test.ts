// L5. The sweep serves the log's `"interval"` policy — durability hygiene for `ack: "local"`, with
// nobody waiting on it — and never the ack path. The two things worth pinning are exactly those:
// that every dirty log does get a barrier, and that `ack: "fsync"` did not quietly move onto the
// sweep, which a `kill -9` is the only honest way to check.

import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FsyncSweep } from "../../src/durability/index.ts"
import { TenantRegistry } from "../../src/tenant/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop() as string)
})

interface Recorded {
  flushed: number
  sweepFlush(): Promise<boolean>
}

const target = (dirty = true): Recorded => ({
  flushed: 0,
  async sweepFlush(): Promise<boolean> {
    this.flushed++
    return dirty
  },
})

test("a pass covers every log with an intent and stops when there are none", async () => {
  const sweep = new FsyncSweep({ intervalMs: 5 })
  const targets = Array.from({ length: 40 }, () => target())
  for (const one of targets) {
    sweep.register(one)
    sweep.intent(one)
  }
  expect(sweep.pending).toBe(40)
  await sweep.tick()
  expect(targets.every((one) => one.flushed === 1)).toBe(true)
  expect(sweep.fsyncs).toBe(40)
  expect(sweep.pending).toBe(0)
  // Nothing outstanding, so a second pass does nothing rather than re-syncing clean logs.
  await sweep.tick()
  expect(targets.every((one) => one.flushed === 1)).toBe(true)
  sweep.close()
})

test("a target that throws does not stop the pass", async () => {
  const sweep = new FsyncSweep({ intervalMs: 5 })
  const broken = {
    sweepFlush: () => Promise.reject(new Error("disk is on fire")),
  }
  const healthy = target()
  sweep.register(broken)
  sweep.register(healthy)
  sweep.intent(broken)
  sweep.intent(healthy)
  await sweep.tick()
  expect(healthy.flushed).toBe(1)
  expect(sweep.fsyncs).toBe(1)
  sweep.close()
})

test("an unregistered target is dropped from the round", async () => {
  const sweep = new FsyncSweep({ intervalMs: 5 })
  const going = target()
  const staying = target()
  sweep.register(going)
  sweep.register(staying)
  sweep.intent(going)
  sweep.intent(staying)
  sweep.unregister(going)
  await sweep.tick()
  expect(going.flushed).toBe(0)
  expect(staying.flushed).toBe(1)
  sweep.close()
})

test("a log written to under the sweep is fsynced without the write path waiting", async () => {
  const dir = tempDir("bql-sweep-")
  const registry = TenantRegistry.open({ dir, fsyncSweep: "shared" })
  const sweep = registry.fsyncSweep
  expect(sweep).not.toBeNull()
  const tenant = await registry.create("acme")
  tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))

  // `ack: "local"` is the level the sweep serves: the write is answered without a barrier of its
  // own, and the log is left with an intent for the sweep to pick up.
  for (let i = 0; i < 20; i++) {
    await tenant.writeQueued((db) => db.run("insert into t (v) values (?)", [`v${i}`]), {
      ack: "local",
    })
  }
  expect(sweep?.pending).toBeGreaterThan(0)
  await sweep?.tick()
  expect(sweep?.fsyncs).toBeGreaterThan(0)
  expect(sweep?.pending).toBe(0)
  registry.close()
})

test("ack: fsync does its own barrier, so the sweep finds nothing to do", async () => {
  // The other half of the crash case, and cheap enough to assert directly: under the node's
  // default ack the log is already clean by the time the sweep reaches it, because `#syncDurable`
  // flushed it inline before the caller was answered. The sweep issues no barrier at all.
  const dir = tempDir("bql-sweep-ack-")
  const registry = TenantRegistry.open({ dir, fsyncSweep: "shared" })
  const sweep = registry.fsyncSweep
  const tenant = await registry.create("acme")
  tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
  for (let i = 0; i < 20; i++) {
    await tenant.writeQueued((db) => db.run("insert into t (v) values (?)", [`v${i}`]), {
      ack: "fsync",
    })
  }
  await sweep?.tick()
  expect(sweep?.fsyncs).toBe(0)
  expect(sweep?.pending).toBe(0)
  registry.close()
})

test("per-db is the default and creates no sweep at all", async () => {
  const dir = tempDir("bql-sweep-off-")
  const registry = TenantRegistry.open({ dir })
  expect(registry.fsyncSweep).toBeNull()
  expect(registry.stats().fsync).toBeNull()
  registry.close()
})

test("a kill -9 never loses a txid an ack: fsync caller was answered", async () => {
  // The claim the plan asks to be proved rather than commented: the sweep does not serve the ack
  // path. With `fsyncSweep: "shared"` on and every write at `ack: "fsync"`, the last txid the
  // writer printed is one it was told was on disk — so it has to still be there after the process
  // is killed outright.
  const dir = tempDir("bql-sweep-kill-")
  const writer = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dir, "sweep-writer.ts"), dir],
    { stdout: "pipe", stderr: "pipe" },
  )
  let answered = 0
  try {
    const reader = writer.stdout.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
      const lines = seen.split("\n").filter((line) => /^\d+$/.test(line))
      if (lines.length > 0) answered = Number(lines[lines.length - 1])
      if (answered >= 200) break
    }
    reader.releaseLock()
  } finally {
    writer.kill(9)
    await writer.exited
  }
  expect(answered).toBeGreaterThan(0)

  const registry = TenantRegistry.open({ dir, fsyncSweep: "shared" })
  const tenant = registry.open("acme")
  // Every txid the writer was answered for survived. It may hold more — a write in flight when the
  // kill landed can also have made it — but never fewer.
  expect(Number(tenant.txid)).toBeGreaterThanOrEqual(answered)
  expect(Number(tenant.log.lastTxid)).toBeGreaterThanOrEqual(answered)
  const rows = tenant.readSync((db) => db.prepare("select count(*) c from t").get()) as { c: number }
  // One transaction per insert, plus the `create table`.
  expect(rows.c).toBeGreaterThanOrEqual(answered - 1)
  registry.close()
}, 60_000)
