# BQL on Vercel and Cloudflare containers

Status: proposed design, requested by the user; implementation is not started.
Date: 2026-09-26.

## Intent

Give someone starting with BQL a CLI path to deploy a database on either Vercel
or Cloudflare. Local container storage is disposable. Persist database changes
to object storage and restore automatically on cold start. Preserve the SQL
client and tenant model. This work covers the database, not `bql bus`.

Assumption pending user preference: a successful cloud write must survive the
loss of every container. Remote publication is therefore the default durability
barrier. A periodic-flush mode with a loss window is a later, explicit option.

## Provider facts and constraints

- Vercel supports OCI images through `Dockerfile.vercel`, with autoscaling,
  `$PORT`, and a 30-second termination grace period. A stable instance address
  or sticky routing is not part of this design's assumptions.
  [Container Images](https://vercel.com/docs/functions/container-images).
- Vercel containers are described as stateless. Sandbox Drives are a separate
  option and do not establish persistent-volume support for Functions.
  [Containers](https://vercel.com/blog/dockerfile-on-vercel),
  [Drives](https://vercel.com/docs/sandbox/concepts/drives).
- Cloudflare Containers have ephemeral disk and can stop on platform events.
  A Durable Object can route requests to a named container, but its SQLite
  storage is not a mounted filesystem for BQL.
  [Container FAQ](https://developers.cloudflare.com/containers/faq/),
  [Container API](https://developers.cloudflare.com/containers/reference/container-class/).
- R2 provides strong consistency and conditional object writes. Use its private
  S3 endpoint, not a cached public domain.
  [Consistency](https://developers.cloudflare.com/r2/reference/consistency/),
  [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
- Vercel Blob documents conditional writes (`ifMatch`) and origin reads
  (`useCache: false`). Public/CDN reads must never determine the latest database
  revision. Validate atomic create and conflict behavior against the real API
  before enabling this backend.
  [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk),
  [Private storage](https://vercel.com/docs/vercel-blob/private-storage).

These are documentation findings, not a claim that BQL has been tested on either
provider. Recheck capabilities and limits during implementation.

## Existing pieces and gaps

Reuse `packages/db/src/storage/{s3,layout,restore}.ts`, the transaction record
codec, `WalApplier`, and consistent snapshots. The current shipper is a backup
service for durable local disks: `Shipper.#drainOnce()` catches upload failures,
and `#shipSegments()` advances `shippedTxid` before the manifest is published.
Neither `flush()` returning nor `shippedTxid` proves a remotely recoverable commit.

The current layout also keys some objects by transaction range without a unique
writer generation, and restores discover index chunks through listing. Preserve
legacy backup compatibility, but do not use that publication scheme as the cloud
source of truth. Cloud manifests must reference every required immutable object
explicitly and never adopt unreferenced objects after a crash.

`Runtime.awaitDurable()` currently waits only for replica/quorum acknowledgements.
`_system.db` holds tenants, settings, token records/revocations and snapshot indexes.
Restoring tenant SQL files alone would lose important state. `keys.json` must not
be regenerated on each cold start; use provider-managed secrets for stable signing
and administrator keys.

## Approaches considered

1. **Recommended: local SQLite cache + immutable remote log + atomic publication.**
   Portable to both providers. Each successful write pays storage latency; supports
   disposable instances without requiring a separate always-on coordinator.
2. **Flush periodically and on shutdown.** Cheap write acknowledgements, but crashes
   lose acknowledged data. An interval is not a guaranteed loss bound during a
   storage outage. Keep as a later mode with explicit admission/backlog limits.
3. **Provider-specific persistent disks or database rewrites.** Sandbox Drives may
   be useful later; D1/DO SQL would require a different engine integration. Neither
   gives one deployment model for both requested container products today.

## Commit protocol

Use a new, versioned prefix for cloud state. A small deployment root references
an immutable catalog, immutable database heads, and a durable request-result index.
All transaction IDs/revisions are decimal strings. Objects include SHA-256 hashes,
lengths, format/engine versions and database incarnation IDs. A name reused after
deletion gets a new incarnation.

For the first release, one conditional root update serializes publication across
the deployment. This deliberately limits write throughput across tenants but
makes catalog operations and data publication one atomic decision. It is a small
deployment baseline, not a claim of horizontally scalable writes. Per-tenant
publication and a separate catalog protocol are a subsequent design.

1. Read the root directly from origin with its opaque version token. A missing
   root is an error during serving; only the explicit provisioning command may
   initialize an empty deployment, using atomic create-if-absent.
2. Authenticate against the catalog referenced by this root. Rehydrate the named
   tenant if needed; update a warm cache to exactly that committed revision.
3. Execute a mutation in a locally isolated workspace. No other request, change
   feed, replica stream or hook consumer may observe its tentative state.
4. Upload the complete transaction records and any required base snapshot. Upload
   immutable head/catalog/result-index objects that refer only to completed uploads.
   Use generation/attempt-qualified keys; never overwrite another attempt's bytes.
5. Compare-and-swap the deployment root using the version read in step 1. The root
   update is the commit decision. Success means all referenced bytes are recoverable.
6. Only then release the response, committed position and change notifications.

There is no time-based lease in this first protocol. Conditional publication is
the fence: two containers can compute candidates, but only one can publish against
the same root. On conflict, discard tentative local state and return a definite
conflict. Never reread a new root and attach an old candidate to it. Do not silently
rerun arbitrary SQL or transaction callbacks. Cloudflare's DO routing reduces
contention; correctness must still hold during overlapping old/new containers.

When the root PUT outcome is unknown, resolve it through the durable request-result
index using an origin read. If resolution is unavailable, report `COMMIT_UNKNOWN`
with a request ID, never a definite rollback. An identical idempotency key and
request digest returns the stored result; a changed payload returns a conflict.
Initial retention is 24 hours, advertised by the API. After expiry, no exactly-once
retry guarantee is made. Authenticate and authorize before returning a cached result.

Reads fetch the authoritative root for each request and execute at that committed
revision; a request may see a snapshot from its start. Never serve a tentative cache
after a failed publication. Respect generation-aware read-your-writes tokens.
For the initial implementation, serialize requests using an instance-local gate
while installing/restoring state. Later optimize with committed reader snapshots.

## Rehydration and lifecycle

- States: `starting -> restoring -> ready -> draining -> stopped`, with `failed`
  possible at any stage. Liveness can succeed during restore; readiness cannot.
- Restore the catalog first, then lazily restore requested tenant databases.
  Download a base snapshot and replay only the explicitly referenced, contiguous
  transaction chain. Validate checksums, sizes, incarnation and engine compatibility.
- Restore into staging directories, validate with SQLite integrity checks, then
  atomically install. Discard partial local state after interruption. Missing or
  corrupt objects fail closed; never substitute an empty database.
- Data, tenant creation/deletion, settings, quotas and token revocations all pass
  the same root publication boundary. Preserve deletion tombstones and token audit
  data. Local catalog positions can be reconstructed from committed heads.
- Snapshot a consistent committed revision periodically to bound replay length.
  Publish compaction with CAS just like a mutation; never include speculative data.
- On SIGTERM stop admission, finish bounded in-flight work, and close cleanly.
  This improves shutdown but is not required to retain acknowledged writes.
- No automatic object deletion in the first release. Emit storage growth metrics.
  Follow-up GC must account for retained roots, PITR, in-flight uploads/restores and
  request-result retention; a grace period alone is not a correctness protocol.
- Backpressure limits local staging space, restore bytes, upload concurrency and
  pending requests. Storage failures fail requests without relaxing durability.

## Initial API and compatibility boundary

Cloud mode is explicit: `serve --storage-mode object`. Existing persistent-disk
servers and asynchronous backups retain their behavior. Cloud mode requires a
remote barrier for every mutation, even when a client requests `ack: local` or
`fsync`; those flags cannot weaken its durability floor. Reject unsupported
replica/quorum requests before execution. Expose effective durability and cloud
capabilities in server discovery and CLI status.

First release supports SQL queries, single-request atomic batches, and database
create/list/stat/delete plus scoped tokens and revocation. The existing client
remains usable for those calls. A single HTTP request is the transaction boundary.
Reject interactive transactions, session-local SQL state, non-atomic mutation
batches, replica promotion, multi-worker mode and direct embedded synchronous
writes in cloud mode before side effects. Each omitted route must explicitly
return `CLOUD_UNSUPPORTED`, not accidentally fall through to the local handler.

After this baseline, add import/fork/PITR using staged objects and the same root
publication protocol; then add bounded sessions and realtime. Stateful SQL and
interactive transactions need a provider-compatible session protocol, not an
assumption of sticky routing. Realtime must replay committed remote records or
signal reset; process-local events alone miss writes accepted by another instance.
Provider-specific stream duration/size limits are tested and advertised. Do not
market full protocol parity before those gates pass.

## Provider adapters and user flow

**Cloudflare:** generated Wrangler project with a Worker, one named Durable Object
per BQL deployment and a Bun container. Route all requests for that deployment to
that object/container. Store immutable data and the root in private R2. Use
conditional S3 writes from Bun; if Bun's S3 API cannot transmit them, implement
and test an explicit signed-request adapter. A DO storage RPC is an alternative
only if it implements the same atomic root contract without two authorities.

**Vercel:** generated `Dockerfile.vercel` and project configuration, a Bun server
listening on `$PORT`, private Vercel Blob with origin reads and conditional writes.
Put `@vercel/blob` only in the provider deployment package, preserving zero runtime
dependencies for the database core. If Blob fails the capability gate, offer a
documented R2/S3 backend for Vercel; never emulate CAS with GET followed by PUT.
SDK installation, filesystem limits, FFI, Zstandard, request/response size limits
and stream support are provider qualification tests.

Proposed CLI (does not exist yet):

```sh
bql deploy init --provider cloudflare   # or vercel
bql deploy plan                       # files, resources, region, costs, limits
bql deploy apply                      # native provider CLI + resumable state
bql deploy status
bql db create myapp
```

Save a named connection profile; output the endpoint and a safe command to load
credentials. Reuse `wrangler`/`vercel` authentication. Provision stable auth secrets
and private storage without putting secrets in generated files or logs. Separate
preview and production prefixes/credentials, record deployment ownership, make
reruns idempotent and never delete an existing database during deployment rollback.
Show resources created if provisioning stops halfway; cleanup is explicit.

## Release evidence

Kill a process before/after every upload and before/after root publication; verify
that every acknowledged write survives an empty-disk restart. Test competing
writers, stale versions, ambiguous PUT responses, same-key retries, catalog-only
changes, revocation, delete/recreate, corrupted objects, storage outages and cache
exhaustion. Check that no read or subscription can observe an unpublished write.

Run these against real R2 and private Blob as well as a deterministic fake. Deploy
both providers, force restarts and overlapping instances, and exercise the CLI from
a clean installation. Record cold restore time, warm read/write p50/p95 latency,
conflict rate, PUT/GET count, stored bytes and cost per workload. Publish measured
limits and supported capabilities. Provider billing and beta availability must be
checked at release, not inferred from this design.
