import { expect, test } from "bun:test"
import { decodeRoot, encodeRoot, readObject, writeObject } from "../../src/cloud/format.ts"
import { FakeObjectStore } from "./fake-store.ts"

const ref = { key: "cloud/v1/deployment/objects/catalog", sha256: "a".repeat(64), bytes: 2 }
const root = { formatVersion: 1 as const, deploymentId: "deployment", revision: "18446744073709551615", catalogRef: ref, headsRef: ref, resultsRef: ref, commitId: "commit" }

test("root preserves u64 decimal positions and rejects incompatible or malformed state", () => {
  expect(decodeRoot(encodeRoot(root), "deployment")).toEqual(root)
  for (const invalid of [ { ...root, formatVersion: 2 }, { ...root, revision: 1 }, { ...root, revision: "01" }, { ...root, revision: "18446744073709551616" }, { ...root, catalogRef: { ...ref, bytes: -1 } }, { ...root, headsRef: { ...ref, sha256: "bad" } } ]) {
    expect(() => decodeRoot(new TextEncoder().encode(JSON.stringify(invalid)), "deployment")).toThrow()
  }
  expect(() => decodeRoot(encodeRoot(root), "preview")).toThrow()
})

test("immutable objects validate bytes and hash before returning data", async () => {
  const store = new FakeObjectStore()
  const body = new Uint8Array([1, 2, 3])
  const reference = await writeObject(store, "cloud/v1/test/objects/attempt/data", body)
  expect(await readObject(store, reference, { maxBytes: 3 })).toEqual(body)
  const stored = store.objects.get(reference.key)!
  stored.body[0] = 9
  await expect(readObject(store, reference, { maxBytes: 3 })).rejects.toThrow("checksum")
  store.objects.delete(reference.key)
  await expect(readObject(store, reference, { maxBytes: 3 })).rejects.toThrow("missing")
})

test("restore budget rejects oversized references before fetching", async () => {
  const store = new FakeObjectStore()
  await expect(readObject(store, { ...ref, bytes: 100 }, { maxBytes: 10 })).rejects.toThrow("budget")
  expect(store.operations).toHaveLength(0)
})

test("immutable writes cannot overwrite an earlier attempt", async () => {
  const store = new FakeObjectStore()
  await writeObject(store, "attempt/data", new Uint8Array([1]))
  await expect(writeObject(store, "attempt/data", new Uint8Array([2]))).rejects.toThrow()
  expect((await store.get("attempt/data"))!.body).toEqual(new Uint8Array([1]))
})
