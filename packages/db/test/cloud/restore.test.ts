import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { sqlite } from "../../src/sqlite/index.ts"
import { encode, RECORD_HEADER_SIZE } from "../../src/wal/record.ts"
import { encodeJSON, writeObject } from "../../src/cloud/format.ts"
import { restoreCloudDatabase, type CloudSnapshot, type CloudLogIndex } from "../../src/cloud/restore.ts"
import { FakeObjectStore } from "./fake-store.ts"
import { cleanup, tempDir, openRegistry, openTenant, writeRows, dumpFile } from "../storage/harness.ts"

afterEach(cleanup)
async function fixture(empty = false) {
  const registry = openRegistry()
  const tenant = empty ? await registry.create("acme") : await openTenant(registry)
  if (!empty) writeRows(tenant, 1, 2)
  const snap = await tenant.snapshot()
  const store = new FakeObjectStore()
  const dataRef = await writeObject(store, "attempt/snapshot.db", new Uint8Array(fs.readFileSync(snap.path)))
  const snapshot: CloudSnapshot = { formatVersion: 1, engine: sqlite().version, incarnation: "generation-a", txid: snap.txid, epoch: snap.epoch, pages: snap.pages, pageSize: snap.pageSize, checksum: snap.checksum, dataRef }
  if (!empty) writeRows(tenant, 3, 2)
  const entries: CloudLogIndex["segments"] = []
  for (const record of tenant.log.iterate(BigInt(snap.txid) + 1n)) {
    const bytes = encode(record)
    const ref = await writeObject(store, `attempt/record-${record.txid}`, bytes)
    entries.push({ ...ref, startTxid: String(record.txid), endTxid: String(record.txid), records: 1, plainBytes: RECORD_HEADER_SIZE + record.bodyPlainLength, maxDatabaseBytes: record.commitSizePages * record.pageSize })
  }
  const index: CloudLogIndex = { formatVersion: 1, incarnation: "generation-a", segments: entries }
  const head = { incarnation: "generation-a", txid: String(tenant.txid), snapshotRef: await writeObject(store, "attempt/snapshot.json", encodeJSON(snapshot)), logIndexRef: await writeObject(store, "attempt/index.json", encodeJSON(index)) }
  return { store, tenant, snapshot, index, head }
}

test("snapshot plus explicit log inventory restores after losing the original local database", async () => {
  const f = await fixture()
  const expected = dumpFile(f.tenant.dbPath)
  const txid = f.tenant.txid
  const original = f.tenant.dir
  f.tenant.close()
  fs.rmSync(original, { recursive: true, force: true })
  const result = await restoreCloudDatabase(f.store, f.head, tempDir())
  expect(result.txid).toBe(txid)
  expect(result.incarnation).toBe("generation-a")
  expect(dumpFile(path.join(result.dir, "main.db"))).toBe(expected)
})

test("an initialized empty database restores without inventing a transaction", async () => {
  const f = await fixture(true)
  const result = await restoreCloudDatabase(f.store, f.head, tempDir())
  expect(result.txid).toBe(0n)
  expect(result.checksum).toBe(0n)
  expect(result.pages).toBe(0)
  expect(dumpFile(path.join(result.dir, "main.db"))).toBe("")
})

test("missing or corrupt referenced bytes fail closed and remove partial staging", async () => {
  for (const fault of ["missing", "corrupt"] as const) {
    const f = await fixture()
    const key = f.index.segments[1]!.key
    if (fault === "missing") f.store.objects.delete(key)
    else { const body = f.store.objects.get(key)!.body; body[0] = body[0]! ^ 1 }
    const staging = tempDir()
    await expect(restoreCloudDatabase(f.store, f.head, staging)).rejects.toThrow()
    expect(fs.readdirSync(staging)).toEqual([])
  }
})

test("reordered logs, wrong incarnation and incompatible engines cannot restore", async () => {
  for (const fault of ["order", "incarnation", "engine"] as const) {
    const f = await fixture()
    if (fault === "order") f.index.segments.reverse()
    if (fault === "incarnation") f.snapshot.incarnation = "deleted-incarnation"
    if (fault === "engine") f.snapshot.engine = "unsupported"
    f.head.snapshotRef = await writeObject(f.store, "other/snapshot.json", encodeJSON(f.snapshot))
    f.head.logIndexRef = await writeObject(f.store, "other/index.json", encodeJSON(f.index))
    await expect(restoreCloudDatabase(f.store, f.head, tempDir())).rejects.toThrow()
  }
})

test("byte and disk budgets reject inventory before downloading database bytes", async () => {
  const f = await fixture()
  for (const limits of [{ maxBytes: 1 }, { maxDiskBytes: 1 }]) {
    f.store.operations.length = 0
    await expect(restoreCloudDatabase(f.store, f.head, tempDir(), undefined, limits)).rejects.toThrow("budget")
    expect(f.store.operations.some(op => op.key === f.snapshot.dataRef.key)).toBe(false)
  }
})

test("snapshot-only restore retains a transaction position above JavaScript's safe integer range", async () => {
  const f = await fixture()
  f.snapshot.txid = "18446744073709551614"
  f.index.segments = []
  f.head.txid = f.snapshot.txid
  f.head.snapshotRef = await writeObject(f.store, "large/snapshot.json", encodeJSON(f.snapshot))
  f.head.logIndexRef = await writeObject(f.store, "large/index.json", encodeJSON(f.index))
  const restored = await restoreCloudDatabase(f.store, f.head, tempDir())
  expect(restored.txid).toBe(18446744073709551614n)
})

test("cancellation removes partial staging and never returns a restored database", async () => {
  const f = await fixture()
  const abort = new AbortController()
  const originalGet = f.store.get.bind(f.store)
  f.store.get = async (key, signal) => {
    const result = await originalGet(key, signal)
    if (key === f.snapshot.dataRef.key) abort.abort()
    return result
  }
  const staging = tempDir()
  await expect(restoreCloudDatabase(f.store, f.head, staging, abort.signal)).rejects.toThrow()
  expect(fs.readdirSync(staging)).toEqual([])
})
