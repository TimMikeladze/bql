// Invariant: no module under `src/graphql/` names `graphql` or `openapi-x-graphql` in a static
// import. Both are optional peers, BunQL's runtime dependency count is zero, and a reviewer checks
// that by deleting the two packages and starting the server — so a static import would turn the
// check into a crash at startup instead of a message at the one route that needs them. They load
// through `import()` here, at the first request that reaches a schema, and nowhere else.
//
// `src/kysely.ts` and `src/drizzle.ts` are the same arrangement one notch looser: they may import
// their peer statically because nothing under `src/` imports *them* — the peer is only resolved by
// a consumer who asked for `bunql/kysely`. `src/server/routes.ts` imports this, so that
// loosening is not available here and the dynamic import is what stands in for it.
//
// A `import type` of either package is fine and is used freely: types are erased, so they cost an
// install nothing.

/** Both packages, in the order an error message names them. */
export const PEER_PACKAGES = ["graphql", "openapi-x-graphql"] as const

/** What a caller runs to install them. */
export const PEER_INSTALL = "bun add graphql openapi-x-graphql"

/** The two peer modules, once resolved. */
export interface Peers {
  graphql: typeof import("graphql")
  openapi: typeof import("openapi-x-graphql")
}

/**
 * How the peers are resolved. The default is `import()`; an embedder that vendors the packages
 * under other names passes its own, and a test proves the absent-peer path by passing loaders
 * that reject — which is the only honest way to test it without uninstalling anything.
 */
export interface PeerLoaders {
  graphql?: () => Promise<unknown>
  openapi?: () => Promise<unknown>
}

/** Neither package resolved. Named, and carrying the command that fixes it. */
export class MissingPeersError extends Error {
  /** The packages `bunql/graphql` needs, both of them, whichever one failed. */
  readonly packages: readonly string[] = PEER_PACKAGES
  /** The install command, verbatim. */
  readonly install = PEER_INSTALL
  /** The ones that did not resolve. */
  readonly missing: readonly string[]

  constructor(missing: readonly string[], cause?: unknown) {
    super(
      `bunql/graphql needs its optional peers ${PEER_PACKAGES.join(" and ")}; ` +
        `${missing.join(" and ")} did not resolve. Install them: ${PEER_INSTALL}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = "MissingPeersError"
    this.missing = missing
  }
}

const DEFAULT_LOADERS: Required<PeerLoaders> = {
  graphql: () => import("graphql"),
  openapi: () => import("openapi-x-graphql"),
}

/** The default resolution, memoised: an install resolves its peers once per process, not per request. */
let resolved: Promise<Peers> | null = null

/**
 * Both peers, or a `MissingPeersError` naming the ones that failed.
 *
 * Only the default loaders are memoised — custom ones are a test's or an embedder's, and caching
 * them would leak one test's stub into the next.
 */
export function loadPeers(loaders?: PeerLoaders): Promise<Peers> {
  if (loaders?.graphql === undefined && loaders?.openapi === undefined) {
    resolved ??= resolve(DEFAULT_LOADERS)
    return resolved
  }
  return resolve({ ...DEFAULT_LOADERS, ...loaders })
}

/** True when both peers resolve, for a server deciding whether to mount the route at all. */
export async function graphqlAvailable(loaders?: PeerLoaders): Promise<boolean> {
  try {
    await loadPeers(loaders)
    return true
  } catch {
    return false
  }
}

async function resolve(loaders: Required<PeerLoaders>): Promise<Peers> {
  const settled = await Promise.allSettled([loaders.graphql(), loaders.openapi()])
  const missing: string[] = []
  let cause: unknown
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i] as PromiseSettledResult<unknown>
    if (outcome.status === "rejected") {
      missing.push(PEER_PACKAGES[i] as string)
      cause ??= outcome.reason
    }
  }
  if (missing.length > 0) throw new MissingPeersError(missing, cause)
  const [graphql, openapi] = settled.map((outcome) =>
    (outcome as PromiseFulfilledResult<unknown>).value,
  )
  return { graphql: graphql as Peers["graphql"], openapi: openapi as Peers["openapi"] }
}
