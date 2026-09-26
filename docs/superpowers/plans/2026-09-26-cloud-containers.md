# Vercel and Cloudflare Database Deployment Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task after design review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy BQL through its CLI to Vercel and Cloudflare with object-backed durability and automatic cold-start recovery.

**Architecture:** SQLite runs against disposable local storage. Immutable snapshots, transaction records and catalog state become authoritative only through a conditional update of a deployment root. Provider adapters supply storage and deployment packaging; the commit/recovery protocol is shared.

**Tech Stack:** Bun 1.4+, pinned native SQLite, TypeScript, OCI containers, R2/S3, private Vercel Blob, Wrangler and Vercel CLI.

**Spec:** [Cloud containers design](../specs/2026-09-26-cloud-containers-design.md).

Status: implementation in progress. Storage, recovery, publication, serve/client wiring and lifecycle checks have local tests. A protected Vercel preview and hosted-to-hosted recovery test passed against private Blob. Cloudflare now has a tested Worker/container package and real R2 storage-contract evidence; hosted container testing needs Workers Paid on the test account. Deployment config, offline plans, native CLI authentication/runner, saved endpoint contexts and packaged templates have tests. CLI provisioning/resume/status and broader provider qualification remain outstanding. Scope is the database, not the bus. Fly uses persistent disk and participates in the requested CLI workflow.

## Global constraints

- Bun 1.4+; reuse the pinned SQLite build, WAL codec and checksum-checked replay.
- Preserve zero runtime dependencies for the database core; provider SDKs live in deployment packages.
- Cloud writes succeed only after remote root publication; shutdown hooks are not a durability guarantee.
- One deployment root serializes publication in the first release; do not claim scalable multi-writer throughput.
- Initial request-result retention is 24 hours. No exactly-once retry guarantee after expiry.
- No automatic object deletion in the first release.
- Preserve existing persistent-disk behavior and version-1/version-2 backup restore compatibility.
- Provider qualification must pass before a provider is advertised as supported.

## Review focus

1. A root PUT succeeded but the response vanished: retain a resolvable request result (Tasks 1, 3).
2. Tentative SQLite commits leaked through readers or realtime before publication (Task 4).
3. Catalog-only mutations or token revocations vanished on cold start (Tasks 2–4).
4. Preview instances or stale deploys wrote into the production timeline (Tasks 3, 5, 6).
5. Real-provider caches, payload limits, or conditional-write semantics differed from the fake (Tasks 1, 5, 7).

## File and module boundaries

Create `packages/db/src/storage/object-store.ts` for storage capability contracts;
`packages/db/src/cloud/{format,root,commit,restore,catalog,runtime,errors}.ts` for
the cloud state protocol. Keep existing backup publication separate.

Create provider packages under `deploy/cloudflare/` and `deploy/vercel/`, outside
the root `packages/*` workspace glob. Each owns its manifest, lockfile, Dockerfile,
provider adapter/configuration and smoke runner. Their generated versions are
CLI templates, validated by the same tests as the source examples.

Create `packages/db/src/deploy/{cli,config,providers,profiles}.ts` for provisioning
and profiles, called by `packages/db/src/cli.ts`. Reuse the database client's admin
operations for post-deploy checks. No provider secrets enter committed fixtures.

## Task 1: Prove remote storage primitives

**Files:** create `packages/db/src/storage/object-store.ts`,
`packages/db/test/cloud/{fake-store,object-store.test}.ts`; modify
`packages/db/src/storage/s3.ts`; create `deploy/vercel/blob-store.ts` and
`deploy/{vercel,cloudflare}/test/storage-smoke.ts` with their package manifests.

**Interfaces:** `ObjectStore.get(key, signal?) -> Promise<{body: Uint8Array, version: string} | null>`;
`create(key, body, signal?) -> Promise<{version: string}>` (atomic create-if-absent);
`replace(key, expectedVersion, body, signal?) -> Promise<{version: string}>` (CAS).
Methods throw distinct `PreconditionFailed`, `StoreUnavailable` and
`StoreOutcomeUnknown` errors. Opaque versions are never treated as content hashes.

- [ ] Add contract tests: two creates yield one winner; two replacements from one
  version yield one winner; an origin read sees the winning bytes; a stale token
  never succeeds; inject a stored PUT with a dropped response.
- [ ] Run `bun test packages/db/test/cloud/object-store.test.ts`; verify missing
  implementations cause failure, then implement the contract and rerun to pass.
- [ ] Implement R2/S3 conditional operations; check what `Bun.S3Client` exposes and
  use a signed HTTP request only when necessary. Preserve existing `S3Store` calls.
- [ ] Implement private Blob adapter using `ifMatch`, origin reads and atomic
  create. Run the same races against provisioned disposable R2 and Blob prefixes.
  Record exact SDK versions and API results, including concurrent same-key writes.
- [ ] Verify cross-process and cross-region visibility, maximum object sizes,
  overwrite rate limits and timeout ambiguity. If a backend fails, record it as
  unsupported; use a qualified R2/S3 backend for Vercel instead of fake CAS.
- [ ] Commit the contracts, adapters and evidence without credentials.

## Task 2: Define immutable cloud state and restoration

**Files:** create `packages/db/src/cloud/{format,catalog,restore}.ts`,
`packages/db/test/cloud/{format,restore,catalog}.test.ts`; modify
`packages/db/src/storage/restore.ts` to expose replay from an explicit inventory.

**Interfaces:** `CloudRoot` has `formatVersion: 1`, `deploymentId`, decimal
`revision`, `catalogRef`, `headsRef`, `resultsRef` and `commitId`.
`ObjectRef` has `key`, `sha256`, `bytes`.
`DatabaseHead` has `incarnation`, decimal `txid`, `snapshotRef`, and `logIndexRef`.
`restoreCloudDatabase(store, head, stagingDir, signal) -> Promise<RestoredDatabase>`
returns `{dir, incarnation, txid: bigint}` only after validation. Catalog serialization
contains logical tenant metadata, tombstones, settings and token records; never
machine-specific paths or plaintext signing secrets.

- [ ] Add tests for snapshot-plus-log restoration, empty initialized databases,
  missing/corrupt/reordered segments, u64 positions, incompatible formats and a
  tenant deleted then recreated with the same name.
- [ ] Add catalog round-trip tests covering quotas, settings and revoked tokens;
  verify a partial restore cannot become ready or initialize a fresh root.
- [ ] Run `bun test packages/db/test/cloud/format.test.ts packages/db/test/cloud/restore.test.ts packages/db/test/cloud/catalog.test.ts`
  and observe failure before implementing the immutable format and staging restore.
- [ ] Extract the existing checksum-verified replay without its listing-based
  inventory discovery. Hash immutable objects, explicitly reference all index
  chunks and enforce configured byte/disk budgets before downloading.
- [ ] Rerun those tests and `bun run db test test/storage`; keep old backup fixtures passing.
- [ ] Commit the format and recovery module.

## Task 3: Implement atomic publication and ambiguous-outcome recovery

**Files:** create `packages/db/src/cloud/{root,commit,errors}.ts`,
`packages/db/test/cloud/{commit,races,idempotency}.test.ts`.

**Interfaces:** `readRoot(store, deploymentId) -> Promise<{root: CloudRoot, version: string}>`;
`publishCommit(store, base, candidate, signal) -> Promise<PublishedCommit>`.
`candidate` contains immutable changed heads/catalog, a unique commit ID and an
authorized request result `{key, digest, resultRef, expiresAt}`. `PublishedCommit`
contains the new root and version. A conflict is definite; an unresolved transport
failure is `COMMIT_UNKNOWN`. `resolveRequest(store, deploymentId, key, digest)`
returns a committed result, absent, or unknown; it never executes SQL.

- [ ] Test concurrent writes from the same root: exactly one becomes committed;
  the loser cannot overwrite objects or attach its candidate to a newer root.
- [ ] Test process death after each upload and around CAS, including successful
  CAS with lost response and later commits advancing the root. Resolve the result
  from the persistent request index, not just the root's last commit ID.
- [ ] Test repeated keys with identical/different payloads, authorization changes,
  expiry at 24 hours and the documented end of the retry guarantee.
- [ ] Run `bun test packages/db/test/cloud/commit.test.ts packages/db/test/cloud/races.test.ts packages/db/test/cloud/idempotency.test.ts`,
  observe failure, implement upload-before-publication and result retention, rerun.
- [ ] Assert recovery ignores every unreferenced attempt; never reuse legacy
  segment keys or the asynchronous shipper's uploaded position as a commit barrier.
- [ ] Commit the publication protocol.

## Task 4: Add a cloud runtime with one publication boundary

**Files:** create `packages/db/src/cloud/runtime.ts`,
`packages/db/test/cloud/{runtime,surfaces,lifecycle}.test.ts`; modify
`packages/db/src/server/{config,runtime,app,exec,routes,registry,errors}.ts`,
`packages/db/src/client/{index,protocol}.ts`, and `packages/db/src/cli.ts`.
Audit `packages/db/src/server/{hrana,surfaces.ts,ws.ts}` for alternate execution paths.

**Interfaces:** `CloudRuntime.run(requestContext, operation) -> Promise<CommittedResult>`
owns origin-root refresh, authentication, local isolation, SQL execution, remote
publication and result release. `requestContext` carries authenticated identity,
idempotency key/digest and deadline; `operation` is an internal typed operation,
not an arbitrary user callback. `CloudRuntime.read(...)` installs a committed
revision before evaluating. `close(deadline)` stops admission and drains bounded work.

- [ ] Test query, atomic batch, create/list/stat/delete and token mint/revoke after
  destroying local disk. Test that a request for local acknowledgement still
  waits for cloud publication and fails when storage cannot publish.
- [ ] Test tentative rows and events remain invisible during blocked uploads;
  failed publication invalidates the local cache before another request runs.
- [ ] Enumerate every registered route and protocol surface. Add an allowlist
  test: each is supported through the cloud boundary or rejected before effects.
  Reject interactive transactions, session SQL, non-atomic mutations, replication,
  promotion, multi-worker mode and unsupported admin routes explicitly.
- [ ] Run `bun test packages/db/test/cloud/runtime.test.ts packages/db/test/cloud/surfaces.test.ts packages/db/test/cloud/lifecycle.test.ts`,
  observe failures, implement the gate and capabilities, then rerun.
- [ ] Require stable provider secrets; prevent startup from generating fresh keys.
  Add generation-aware read-your-writes metadata and idempotency-key plumbing
  without automatic replay of unsafe SQL. Keep ordinary local-server defaults.
- [ ] Test graceful shutdown and SIGKILL; readiness during restore; corrupt state;
  stale warm caches; upload backlog and disk exhaustion. Run the existing DB tests.
- [ ] Commit the runtime integration.

## Task 5: Ship working deployment examples for both providers

**Files:** create `deploy/cloudflare/{Dockerfile,wrangler.jsonc,src/index.ts,README.md}`,
`deploy/vercel/{Dockerfile.vercel,vercel.json,server.ts,README.md}`,
and provider integration tests in `deploy/*/test/`.

**Interfaces:** both containers consume the same cloud runtime configuration and
return its capabilities. Cloudflare Worker/DO routes to the named deployment's
container; Vercel starts on `$PORT`. Both use provider secrets for stable auth and
private storage. Each deployment/environment has a distinct root prefix.

- [ ] Build images with the pinned SQLite FFI library and prove startup, Zstandard,
  private storage access and restore on each provider. Keep provider SDKs isolated.
- [ ] Deploy Cloudflare with R2 and exercise sleep/wake and an overlapping rollout.
  Deploy Vercel with qualified Blob/R2 storage and force multiple instances to
  publish against one root; ensure definite conflicts are actionable to clients.
- [ ] Run SQL/admin/revocation/idempotency smoke tests through HTTPS after replacing
  containers. Record request/response limits and unsupported surfaces explicitly.
- [ ] Confirm preview deployments cannot read or mutate production prefixes;
  provider authentication/protection must also work with SDK and CLI clients.
- [ ] Record commands and observed results in the provider READMEs; commit examples.

## Task 6: Add beginner-facing deployment CLI

**Files:** create `packages/db/src/deploy/{cli,config,providers,profiles}.ts`,
`packages/db/test/deploy/{cli,providers,profiles}.test.ts`; modify
`packages/db/src/cli.ts`, root `package.json` packaging files and `README.md`.
Add shipped templates under `packages/db/deploy-templates/` with a check against
the proven examples from Task 5.

**Interfaces:** `initDeployment(provider, dir) -> DeploymentConfig`;
`planDeployment(config) -> DeploymentPlan`;
`applyDeployment(plan, runner) -> DeploymentResult`;
`statusDeployment(config) -> DeploymentStatus`.
`runner` invokes native CLIs with argument arrays and redacted diagnostics.
Result includes endpoint, capabilities and a connection-profile name, not a key.

- [ ] Test `bql deploy init --provider vercel|cloudflare`, `plan`, `apply`, `status`;
  no provider calls during `plan`; missing login gives a specific native login
  command; existing files/resources are preserved and reruns do not duplicate them.
- [ ] Test interrupted provisioning, auth failures, secret redaction, profile file
  permissions and environment isolation. Applying a failed plan reports created
  resources without deleting databases. Do not overwrite the separate Fly config.
- [ ] Run `bun test packages/db/test/deploy`, observe failure, implement the CLI
  and template packaging, rerun to pass. Add scoped post-deployment smoke checks.
- [ ] Extend `bun run pack:check` to confirm templates and commands survive packing;
  test a clean installation, deploy, create DB and query using its saved profile.
- [ ] Commit the CLI and beginner instructions.

## Task 7: Qualify durability and publish measured limits

**Files:** create `packages/db/test/cloud/chaos.test.ts`,
`packages/db/bench/cloud.ts`, `packages/db/docs/cloud-deployments.md`;
update provider smoke runners and CI workflows with explicit billable-test opt-in.

- [ ] Run deterministic fault injection across upload/CAS/restore boundaries and
  check every success against a fresh recovery from object storage alone.
- [ ] Run real-provider races, dropped responses, termination and empty-disk
  recovery. Prove catalog and auth behavior as well as row persistence.
- [ ] Measure empty/small/large database cold starts, warm latency, contention,
  transfer counts, object growth and storage-operation costs. Check measured
  restore sizes fit each provider's filesystem and execution budgets.
- [ ] Run `bun run typecheck`, `bun run db test`, `bun run db routes:check`,
  `bun run pack:check`, `bun run bytes` and both provider smoke suites.
- [ ] Document versioned capability matrices and the global-root throughput
  limit. Mark a provider experimental if a qualification gate is incomplete.
- [ ] Commit the qualification results and release documentation.

## Follow-up milestones (separate implementation plans)

1. Import, fork and PITR through staged immutable data and atomic publication.
2. Session transactions and realtime with committed-record replay, reconnect/reset
   behavior, provider time limits and no reliance on sticky routing.
3. Reference-safe GC, bounded compaction and per-tenant publication to reduce
   global-root contention; design cross-tenant catalog coordination first.
4. Optional bounded-loss periodic flushing, only with an explicit durable position,
   loss policy and admission cutoff during prolonged storage failures.
5. Evaluate Vercel Sandbox Drives as a separate deployment target after validating
   filesystem semantics and session orchestration. Do not couple the portable mode
   to that feature.

## Self-review

The plan covers remote durability, concurrent publication, automatic restore,
catalog/auth recovery, both provider adapters, CLI setup and fault qualification.
Tasks 1 and 5 are explicit capability gates, not assumed compatibility. Initial
API restrictions are stated in the design and enforced in Task 4; later parity
work is separate rather than hidden behind a claim of complete compatibility.
Product code for storage, immutable recovery, publication, cloud startup and client support is implemented and locally tested. Vercel container deployment and real Blob recovery have live smoke evidence. The complete three-provider deployment CLI and broad production qualification remain outstanding.
