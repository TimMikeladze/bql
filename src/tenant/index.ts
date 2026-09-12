// The public surface of tenancy: a registry of databases, each owned by one Tenant that holds the
// single writer, the reader pool, the transaction log and the checkpoint policy. Design §4.2–§4.4.

export {
  Catalog,
  positionOf,
  type SnapshotRow,
  type TenantInit,
  type TenantRow,
  type TokenRow,
} from "./catalog.ts"
export {
  type CreateOptions,
  fileDescriptorLimit,
  type RegistryOptions,
  type RegistryStats,
  TenantRegistry,
  trashDir,
} from "./registry.ts"
export {
  type AckLevel,
  assertValidName,
  type CommitEvent,
  type CommitListener,
  type ReaderLease,
  type ReadOptions,
  type ReconcileOutcome,
  Tenant,
  tenantDir,
  TenantError,
  type TenantOptions,
  type TenantStats,
  type TxBeginOptions,
  type WriteOptions,
  type WriteResult,
} from "./tenant.ts"
