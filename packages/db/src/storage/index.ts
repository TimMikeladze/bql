// The public surface of bucket storage: one typed door to an S3-compatible bucket, the layout a
// restore depends on, the per-tenant shipper that fills it and the restore that reads it back.
// Design §4.4; the layout contract is `docs/r3-storage.md`.

export {
  dbPrefix,
  decodeIndexChunk,
  decodeManifest,
  emptyManifest,
  encodeIndexChunk,
  encodeManifest,
  type GenerationRef,
  INDEX_CHUNK,
  indexChunkKey,
  type IndexChunk,
  indexPrefix,
  latestTxid,
  MANIFEST_VERSION,
  type Manifest,
  manifestKey,
  newGenerationId,
  normalizeManifest,
  mergeInventory,
  normalizePrefix,
  padTxid,
  parseIndexChunkKey,
  parseSegmentKey,
  parseSnapshotKey,
  planRestore,
  type RestorePlan,
  RestorePlanError,
  type SegmentEntry,
  segmentKey,
  segmentPrefix,
  type SnapshotEntry,
  snapshotKey,
  snapshotPrefix,
  TXID_WIDTH,
} from "./layout.ts"
export { UploadBudget, UploadBudgetTimeout } from "./budget.ts"
export { ShipperPool, type ShipperPoolOptions } from "./pool.ts"
export {
  type BucketRestoreOptions,
  type BucketRestoreResult,
  type IndexChunkRef,
  listGenerations,
  listIndexChunks,
  loadIndex,
  loadInventory,
  readManifest,
  RestoreError,
  restoreFromBucket,
  restoreIntoCatalog,
  type RestoreTarget,
  resolveTarget,
  verifyBucket,
  type VerifyResult,
} from "./restore.ts"
export {
  S3NotFound,
  type S3ListOptions,
  type S3ListPage,
  type S3ObjectInfo,
  S3Store,
  S3StoreError,
  type S3StoreOptions,
} from "./s3.ts"
export {
  parseRetentionMs,
  Shipper,
  type ShipperOptions,
  type ShipperState,
} from "./shipper.ts"
