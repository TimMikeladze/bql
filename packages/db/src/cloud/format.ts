import type { ObjectStore } from "../storage/object-store.ts"

export interface ObjectRef { key: string; sha256: string; bytes: number }
export interface CloudRoot {
  formatVersion: 1
  deploymentId: string
  revision: string
  catalogRef: ObjectRef
  headsRef: ObjectRef
  resultsRef: ObjectRef
  commitId: string
}
export interface DatabaseHead {
  incarnation: string
  txid: string
  snapshotRef: ObjectRef
  logIndexRef: ObjectRef
}
export class CloudFormatError extends Error {
  readonly code = "CLOUD_CORRUPT"
  constructor(message: string) { super(message); this.name = "CloudFormatError" }
}

export function decimalU64(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw new CloudFormatError("Invalid u64 decimal position")
  return value
}
export function objectRef(value: unknown): ObjectRef {
  const data = record(value)
  if (typeof data.key !== "string" || !data.key || data.key.startsWith("/") || data.key.split("/").some(p => !p || p === "." || p === "..") || /[\x00-\x1f\\]/.test(data.key) || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256) || !Number.isSafeInteger(data.bytes) || (data.bytes as number) < 0) throw new CloudFormatError("Invalid immutable object reference")
  return { key: data.key, sha256: data.sha256, bytes: data.bytes as number }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudFormatError("Expected object")
  return value as Record<string, unknown>
}
export function decodeJSON(body: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) }
  catch { throw new CloudFormatError("Invalid cloud JSON") }
}
export function encodeJSON(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)) }
export function decodeRoot(body: Uint8Array, deploymentId: string): CloudRoot {
  const data = record(decodeJSON(body))
  if (data.formatVersion !== 1 || data.deploymentId !== deploymentId || !deploymentId || typeof data.commitId !== "string" || !data.commitId) throw new CloudFormatError("Incompatible cloud root or deployment identity")
  return { formatVersion: 1, deploymentId, revision: decimalU64(data.revision), catalogRef: objectRef(data.catalogRef), headsRef: objectRef(data.headsRef), resultsRef: objectRef(data.resultsRef), commitId: data.commitId }
}
export function encodeRoot(root: CloudRoot): Uint8Array {
  const body = encodeJSON(root)
  decodeRoot(body, root.deploymentId)
  return body
}
export function sha256(body: Uint8Array): string { return new Bun.CryptoHasher("sha256").update(body).digest("hex") }

/** Immutable attempt-qualified keys must come from the publisher. Atomic create
 * forbids attaching different bytes to an already published reference. */
export async function writeObject(store: ObjectStore, key: string, body: Uint8Array, signal?: AbortSignal): Promise<ObjectRef> {
  const ref = objectRef({ key, sha256: sha256(body), bytes: body.byteLength })
  await store.create(key, body, signal)
  return ref
}
export async function readObject(store: ObjectStore, reference: ObjectRef, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
  const ref = objectRef(reference)
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || ref.bytes > options.maxBytes) throw new CloudFormatError("Immutable object exceeds restore byte budget")
  const value = await store.get(ref.key, options.signal)
  if (!value) throw new CloudFormatError("Referenced immutable object is missing")
  if (value.body.byteLength !== ref.bytes) throw new CloudFormatError("Immutable object byte count mismatch")
  if (sha256(value.body) !== ref.sha256) throw new CloudFormatError("Immutable object checksum mismatch")
  return value.body
}
