import { type ObjectStore, StoreOutcomeUnknown } from "../storage/object-store.ts"
import { CloudError } from "./errors.ts"
import { CloudFormatError, decodeRoot, encodeJSON, encodeRoot, objectRef, readObject, writeObject, type CloudRoot, type ObjectRef } from "./format.ts"

export interface VersionedRoot { root: CloudRoot; version: string }
export const MAX_CLOUD_METADATA_BYTES = 8 * 1024 * 1024
export function deploymentPrefix(deploymentId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(deploymentId)) throw new CloudFormatError("Invalid deployment identity")
  return `cloud/v1/${deploymentId}/`
}
export function rootKey(deploymentId: string): string { return `${deploymentPrefix(deploymentId)}root.json` }
export function scopedRef(deploymentId: string, value: ObjectRef): ObjectRef {
  const ref = objectRef(value)
  if (!ref.key.startsWith(`${deploymentPrefix(deploymentId)}objects/`)) throw new CloudFormatError("Object reference crosses deployment namespace")
  return ref
}
export async function readRoot(store: ObjectStore, deploymentId: string, signal?: AbortSignal): Promise<VersionedRoot> {
  const value = await store.get(rootKey(deploymentId), signal)
  if (!value) throw new CloudError("CLOUD_NOT_INITIALIZED", "Cloud deployment has no initialized root")
  if (value.body.length > MAX_CLOUD_METADATA_BYTES) throw new CloudFormatError("Cloud root exceeds metadata budget")
  const root = decodeRoot(value.body, deploymentId)
  for (const ref of [root.catalogRef, root.headsRef, root.resultsRef]) scopedRef(deploymentId, ref)
  return { root, version: value.version }
}

/** Explicit provisioning only: a failed restore/read must NEVER call this. */
export async function initializeRoot(store: ObjectStore, deploymentId: string, initial: { catalogRef: ObjectRef; headsRef: ObjectRef }, signal?: AbortSignal): Promise<VersionedRoot> {
  for (const ref of [initial.catalogRef, initial.headsRef]) await readObject(store, scopedRef(deploymentId, ref), { maxBytes: MAX_CLOUD_METADATA_BYTES, signal })
  const commitId = crypto.randomUUID()
  const resultsRef = await writeObject(store, `${deploymentPrefix(deploymentId)}objects/${commitId}/results.json`, encodeJSON({ formatVersion: 1, results: [] }), signal)
  const root: CloudRoot = { formatVersion: 1, deploymentId, revision: "0", catalogRef: initial.catalogRef, headsRef: initial.headsRef, resultsRef, commitId }
  try {
    const { version } = await store.create(rootKey(deploymentId), encodeRoot(root), signal)
    return { root, version }
  } catch (error) {
    if (error instanceof StoreOutcomeUnknown) throw new CloudError("COMMIT_UNKNOWN", "Initialization may have committed; read the existing root before retrying")
    throw error
  }
}
