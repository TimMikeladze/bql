// `bql.sh/search`: vector, hybrid, full-text and geo search as SQL builders over any `Db`.
//
// Nothing here is a server feature. Every helper generates DDL and statements and sends them
// through the handle it was given — `createClient().db()`, the embedded `bq.db()` or its `.sync`,
// a transaction — so embedded, server, replica reads and cloud mode share one code path and one
// wire protocol. What the server needs is a library with the capabilities: FTS5 and R*Tree are in
// most builds, sqlite-vec and the geo functions only in the one `sqlite:build` makes. A helper
// that needs a missing one throws `FeatureUnavailableError` (`FEATURE_UNAVAILABLE`), never a slower
// fallback. `docs/x1-search.md`.

export {
  FtsIndex,
  ftsIndex,
  ftsQuote,
  type FtsIndexOptions,
  type FtsMarkup,
  type FtsMatch,
  type FtsQuoteOptions,
  type FtsSearchOptions,
  type FtsSnippet,
} from "./fts.ts"
export {
  GeoIndex,
  geoIndex,
  type BoundingBox,
  type GeoIndexOptions,
  type GeoNear,
  type GeoPoint,
} from "./geo.ts"
export {
  FeatureUnavailableError,
  searchFeatures,
  type SearchDb,
  type SearchFeature,
} from "./run.ts"
export {
  VectorIndex,
  fromVector,
  hybridSearch,
  toVector,
  vectorIndex,
  type HybridMatch,
  type HybridSearchOptions,
  type MetadataFilter,
  type MetadataType,
  type MetadataValue,
  type VectorIndexOptions,
  type VectorInput,
  type VectorMatch,
  type VectorMetric,
  type VectorSearchOptions,
} from "./vector.ts"
