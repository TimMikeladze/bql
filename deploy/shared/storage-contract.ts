import { type ObjectStore, PreconditionFailed } from "../../packages/db/src/storage/object-store.ts"

/** Non-destructive qualification against a unique disposable prefix. Intentionally
 * leaves its tiny objects behind: this protocol has no automatic deletion. */
export async function qualifyStorage(store: ObjectStore, prefix: string) {
  if (!prefix || !prefix.endsWith("/")) throw new Error("A disposable prefix ending in / is required")
  const key = `${prefix}${crypto.randomUUID()}/root`
  const bodies = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]
  if (await store.get(key) !== null) throw new Error("Unique key unexpectedly exists")
  const creates = await Promise.allSettled(bodies.map(body => store.create(key, body)))
  const created = winner(creates)
  const initial = await store.get(key)
  if (!initial || initial.version !== created.version || !equal(initial.body, bodies[creates.findIndex(r => r.status === "fulfilled")]!)) throw new Error("Origin read did not observe create winner")
  // Every candidate differs from the base: S3 may reuse an ETag for identical
  // bytes. Cloud roots likewise always advance their revision and commit ID.
  const candidates = [new Uint8Array([7, 8, 9]), new Uint8Array([10, 11, 12])]
  const updates = await Promise.allSettled(candidates.map(body => store.replace(key, initial.version, body)))
  const updated = winner(updates)
  const read = await store.get(key)
  if (!read || read.version !== updated.version || !equal(read.body, candidates[updates.findIndex(r => r.status === "fulfilled")]!)) throw new Error("Origin read did not observe CAS winner")
  const stale = await Promise.allSettled([store.replace(key, initial.version, new Uint8Array([9]))])
  if (stale[0]?.status !== "rejected" || !(stale[0].reason instanceof PreconditionFailed)) throw new Error("Stale version was not rejected")
  return { key, checks: ["atomic-create", "atomic-replace", "origin-visibility", "stale-version"] }
}
function winner(results: PromiseSettledResult<{ version: string }>[]) {
  const wins = results.filter(r => r.status === "fulfilled")
  const losses = results.filter(r => r.status === "rejected")
  if (wins.length !== 1 || losses.length !== 1 || !(losses[0]!.reason instanceof PreconditionFailed)) throw new Error("Conditional race did not have exactly one winner and one definite conflict")
  return wins[0]!.value
}
function equal(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((v, i) => v === b[i]) }
