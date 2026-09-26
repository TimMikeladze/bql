import { expect, test } from "bun:test"
import { initializeRoot, readRoot } from "../../src/cloud/root.ts"
import { publishCommit, resolveRequest, type CommitCandidate } from "../../src/cloud/commit.ts"
import { encodeJSON, writeObject } from "../../src/cloud/format.ts"
import { FakeObjectStore } from "./fake-store.ts"

async function setup() {
  const store = new FakeObjectStore()
  const catalogRef = await writeObject(store, "cloud/v1/test/objects/start/catalog", encodeJSON({ tenants: [] }))
  const headsRef = await writeObject(store, "cloud/v1/test/objects/start/heads", encodeJSON({}))
  const base = await initializeRoot(store, "test", { catalogRef, headsRef })
  return { store, base }
}
async function candidate(store: FakeObjectStore, id: string, now = 1000): Promise<CommitCandidate> {
  const catalogRef = await writeObject(store, `cloud/v1/test/objects/${id}/catalog`, encodeJSON({ tenants: [id] }))
  const headsRef = await writeObject(store, `cloud/v1/test/objects/${id}/heads`, encodeJSON({}))
  const resultRef = await writeObject(store, `cloud/v1/test/objects/${id}/response`, encodeJSON({ rows: [id] }))
  return { commitId: id, catalogRef, headsRef, request: { principal: "user", key: id, digest: "a".repeat(64), resultRef, expiresAt: now + 86400000 } }
}
const context = (key: string, digest = "a".repeat(64)) => ({ principal: "user", key, digest })

test("concurrent publication has one winner and never rebases the losing candidate", async () => {
  const { store, base } = await setup()
  const a = await candidate(store, "a")
  const b = await candidate(store, "b")
  const results = await Promise.allSettled([publishCommit(store, base, a, undefined, 1000), publishCommit(store, base, b, undefined, 1000)])
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
  const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult
  expect(failed.reason.code).toBe("CLOUD_CONFLICT")
  const current = await readRoot(store, "test")
  expect(current.root.revision).toBe("1")
  expect(current.root.commitId).toBe("a")
})

test("a lost successful CAS is resolved from retained request results after a later commit", async () => {
  const { store, base } = await setup()
  const a = await candidate(store, "a")
  const replace = store.replace.bind(store)
  store.replace = async (...args) => { store.dropNextWriteResponse = true; return replace(...args) }
  await expect(publishCommit(store, base, a, undefined, 1000)).rejects.toMatchObject({ code: "COMMIT_UNKNOWN" })
  store.replace = replace
  const afterA = await readRoot(store, "test")
  await publishCommit(store, afterA, await candidate(store, "b"), undefined, 1001)
  const resolved = await resolveRequest(store, "test", context("a"), () => true, 1002)
  expect(resolved).toEqual({ status: "committed", result: { rows: ["a"] }, revision: "1", commitId: "a" })
})

test("idempotency resolution checks identity, authorization, digest and 24-hour expiry", async () => {
  const { store, base } = await setup()
  await publishCommit(store, base, await candidate(store, "a"), undefined, 1000)
  await expect(resolveRequest(store, "test", context("a"), () => false, 1001)).rejects.toMatchObject({ code: "FORBIDDEN" })
  await expect(resolveRequest(store, "test", context("a", "b".repeat(64)), () => true, 1001)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
  expect(await resolveRequest(store, "test", { ...context("a"), principal: "other" }, () => true, 1001)).toEqual({ status: "absent" })
  expect(await resolveRequest(store, "test", context("a"), () => true, 86401000)).toEqual({ status: "absent" })
  store.unavailable = true
  expect(await resolveRequest(store, "test", context("a"), () => true, 1001)).toEqual({ status: "unknown" })
})

test("unpublished objects and missing candidate objects can never become a commit", async () => {
  const { store, base } = await setup()
  const a = await candidate(store, "a")
  store.objects.delete(a.request.resultRef.key)
  await expect(publishCommit(store, base, a, undefined, 1000)).rejects.toThrow()
  expect((await readRoot(store, "test")).root.revision).toBe("0")
  expect(await resolveRequest(store, "test", context("a"), () => true, 1001)).toEqual({ status: "absent" })
})

test("initialization never resets an existing or corrupted root", async () => {
  const { store, base } = await setup()
  await expect(initializeRoot(store, "test", base.root)).rejects.toThrow()
  store.objects.get("cloud/v1/test/root.json")!.body = new Uint8Array([0])
  await expect(readRoot(store, "test")).rejects.toThrow()
  await expect(initializeRoot(store, "test", base.root)).rejects.toThrow()
})

test("a candidate cannot cross deployment namespaces or reuse an active request key", async () => {
  const { store, base } = await setup()
  const a = await candidate(store, "a")
  const preview = await writeObject(store, "cloud/v1/preview/objects/catalog", encodeJSON({}))
  await expect(publishCommit(store, base, { ...a, catalogRef: preview }, undefined, 1000)).rejects.toThrow()
  const committed = await publishCommit(store, base, a, undefined, 1000)
  await expect(publishCommit(store, committed, { ...await candidate(store, "b"), request: a.request }, undefined, 1001)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
})

test("faults before each publication step leave only the old root authoritative", async () => {
  // Publication reads the old result index, validates three direct dependencies,
  // creates the new result index, then CASes the root. Fault before each boundary.
  for (let failAt = 1; failAt <= 6; failAt++) {
    const { store, base } = await setup()
    const a = await candidate(store, "a")
    let operation = 0
    const get = store.get.bind(store)
    const create = store.create.bind(store)
    const replace = store.replace.bind(store)
    const fail = () => { if (++operation === failAt) throw new Error("process stopped before operation") }
    store.get = async (...args) => { fail(); return get(...args) }
    store.create = async (...args) => { fail(); return create(...args) }
    store.replace = async (...args) => { fail(); return replace(...args) }
    await expect(publishCommit(store, base, a, undefined, 1000)).rejects.toThrow()
    store.get = get
    store.create = create
    store.replace = replace
    expect((await readRoot(store, "test")).root.revision).toBe("0")
    expect(await resolveRequest(store, "test", context("a"), () => true, 1001)).toEqual({ status: "absent" })
  }
})

test("expired request results are pruned only when the next root is published", async () => {
  const { store, base } = await setup()
  const first = await publishCommit(store, base, await candidate(store, "a"), undefined, 1000)
  const now = 86401000
  const next = await candidate(store, "b", now)
  next.request.key = "a"
  await publishCommit(store, first, next, undefined, now)
  expect(await resolveRequest(store, "test", context("a"), () => true, now + 1)).toEqual({ status: "committed", result: { rows: ["b"] }, revision: "2", commitId: "b" })
  expect(store.objects.has("cloud/v1/test/objects/a/response")).toBe(true)
})
