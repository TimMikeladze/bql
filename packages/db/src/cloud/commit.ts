import { type ObjectStore, PreconditionFailed, StoreOutcomeUnknown } from "../storage/object-store.ts"
import { identity, nonnegative } from "./catalog.ts"
import { CloudError } from "./errors.ts"
import { CloudFormatError, decimalU64, decodeJSON, encodeJSON, encodeRoot, readObject, record, writeObject, type ObjectRef } from "./format.ts"
import { deploymentPrefix, MAX_CLOUD_METADATA_BYTES, readRoot, rootKey, scopedRef, type VersionedRoot } from "./root.ts"

export const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000
export interface RequestIdentity { principal: string; key: string; digest: string }
export interface RequestResult extends RequestIdentity { resultRef: ObjectRef; expiresAt: number }
interface RetainedResult extends RequestResult { revision: string; commitId: string }
export interface CommitCandidate {
  commitId: string
  catalogRef: ObjectRef
  headsRef: ObjectRef
  request: RequestResult
}
export interface PublishedCommit extends VersionedRoot { resultRef: ObjectRef }
export type RequestResolution = { status: "committed"; result: unknown; revision: string; commitId: string } | { status: "absent" } | { status: "unknown" }

function requestIdentity(value: RequestIdentity): RequestIdentity {
  const principal = identity(value.principal)
  const key = identity(value.key)
  if (!/^[a-f0-9]{64}$/.test(value.digest)) throw new CloudFormatError("Invalid request digest")
  return { principal, key, digest: value.digest }
}
async function readResults(store: ObjectStore, base: VersionedRoot, signal?: AbortSignal): Promise<RetainedResult[]> {
  const document = record(decodeJSON(await readObject(store, scopedRef(base.root.deploymentId, base.root.resultsRef), { maxBytes: MAX_CLOUD_METADATA_BYTES, signal })))
  if (document.formatVersion !== 1 || !Array.isArray(document.results)) throw new CloudFormatError("Invalid request result inventory")
  const seen = new Set<string>()
  return document.results.map(raw => {
    const item = record(raw)
    const request = requestIdentity(item as unknown as RequestIdentity)
    const compoundKey = JSON.stringify([request.principal, request.key])
    if (seen.has(compoundKey)) throw new CloudFormatError("Duplicate request result")
    seen.add(compoundKey)
    const revision = decimalU64(item.revision)
    if (BigInt(revision) > BigInt(base.root.revision)) throw new CloudFormatError("Request result ahead of committed root")
    return { ...request, expiresAt: nonnegative(item.expiresAt), revision, commitId: identity(item.commitId), resultRef: scopedRef(base.root.deploymentId, item.resultRef as ObjectRef) }
  })
}

/** Publishes a prepared candidate against exactly the root it executed from.
 * Callers upload immutable database objects first. This function verifies its
 * direct dependencies, persists retained request results, then performs ONE CAS.
 * It never rereads/rebases a losing candidate or executes a user operation. */
export async function publishCommit(store: ObjectStore, base: VersionedRoot, candidate: CommitCandidate, signal?: AbortSignal, now = Date.now()): Promise<PublishedCommit> {
  nonnegative(now)
  const id = base.root.deploymentId
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(candidate.commitId) || candidate.commitId === base.root.commitId) throw new CloudFormatError("Commit identity must be fresh")
  const request = requestIdentity(candidate.request)
  if (candidate.request.expiresAt <= now || candidate.request.expiresAt > now + REQUEST_RETENTION_MS) throw new CloudFormatError("Invalid request retention window")
  nonnegative(candidate.request.expiresAt)
  const previous = (await readResults(store, base, signal)).filter(result => result.expiresAt > now)
  if (previous.some(result => result.principal === request.principal && result.key === request.key)) throw new CloudError("IDEMPOTENCY_CONFLICT", "Request key already committed; resolve its existing result")
  for (const ref of [candidate.catalogRef, candidate.headsRef, candidate.request.resultRef]) {
    // Invalid/missing dependencies must fail before root CAS. Each is immutable.
    decodeJSON(await readObject(store, scopedRef(id, ref), { maxBytes: MAX_CLOUD_METADATA_BYTES, signal }))
  }
  const revision = decimalU64(String(BigInt(decimalU64(base.root.revision)) + 1n))
  const results = [...previous, { ...request, resultRef: candidate.request.resultRef, expiresAt: candidate.request.expiresAt, revision, commitId: candidate.commitId }]
  const body = encodeJSON({ formatVersion: 1, results })
  if (body.length > MAX_CLOUD_METADATA_BYTES) throw new CloudError("CLOUD_BACKPRESSURE", "Retained request results exceed metadata budget")
  const resultsRef = await writeObject(store, `${deploymentPrefix(id)}objects/${candidate.commitId}/results.json`, body, signal)
  const root = { ...base.root, revision, catalogRef: candidate.catalogRef, headsRef: candidate.headsRef, resultsRef, commitId: candidate.commitId }
  try {
    const { version } = await store.replace(rootKey(id), base.version, encodeRoot(root), signal)
    return { root, version, resultRef: candidate.request.resultRef }
  } catch (error) {
    if (error instanceof PreconditionFailed) throw new CloudError("CLOUD_CONFLICT", "Another writer committed; discard tentative local state")
    if (error instanceof StoreOutcomeUnknown) throw new CloudError("COMMIT_UNKNOWN", "Publication may have committed; resolve the request key before retrying")
    throw error
  }
}

/** Authorization is evaluated for EVERY lookup, including cached successes.
 * The identity must come from authenticated request context, never a client-
 * supplied principal. Unavailable/corrupt remote state is unknown, not absent. */
export async function resolveRequest(store: ObjectStore, deploymentId: string, context: RequestIdentity, authorize: (principal: string) => boolean | Promise<boolean>, now = Date.now(), signal?: AbortSignal): Promise<RequestResolution> {
  const request = requestIdentity(context)
  nonnegative(now)
  if (!await authorize(request.principal)) throw new CloudError("FORBIDDEN", "Request result is not authorized")
  try {
    const base = await readRoot(store, deploymentId, signal)
    const results = await readResults(store, base, signal)
    const found = results.find(result => result.principal === request.principal && result.key === request.key && result.expiresAt > now)
    if (!found) return { status: "absent" }
    if (found.digest !== request.digest) throw new CloudError("IDEMPOTENCY_CONFLICT", "Request key was used with a different payload")
    const body = await readObject(store, found.resultRef, { maxBytes: MAX_CLOUD_METADATA_BYTES, signal })
    return { status: "committed", result: decodeJSON(body), revision: found.revision, commitId: found.commitId }
  } catch (error) {
    if (error instanceof CloudError && error.code === "IDEMPOTENCY_CONFLICT") throw error
    return { status: "unknown" }
  }
}
