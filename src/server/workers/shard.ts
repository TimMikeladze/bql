// Invariant: this is the only place a database name is turned into a worker index, so the router
// and the worker cannot disagree about who owns a name. Both sides import this function; neither
// side is told the answer by the other.
//
// The hash is `Bun.hash.xxHash3`, which is what the rest of the codebase already uses for content
// hashing, and the name is hashed as bytes rather than as a JavaScript string so the answer does
// not depend on how a string was interned. Nothing persists a shard number — a node restarted with
// a different `workers` re-derives every placement — so the hash never has to stay stable across
// versions, only across the threads of one process.

/** Which worker owns `name`, given `workers` of them. Always in `[0, workers)`. */
export function shardOf(name: string, workers: number): number {
  if (workers <= 1) return 0
  return Number(Bun.hash.xxHash3(name) % BigInt(workers))
}

/** `[server] workers = 0` means "one per core", capped so a big machine does not open 128 LRUs. */
export const MAX_AUTO_WORKERS = 8

/** Resolves the configured value to the number of worker threads to actually run. */
export function resolveWorkers(configured: number): number {
  if (configured === 0) {
    const cores = navigator.hardwareConcurrency || 1
    return Math.max(1, Math.min(MAX_AUTO_WORKERS, cores))
  }
  return Math.max(1, Math.floor(configured))
}
