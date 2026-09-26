# Cloudflare deployment work in progress

The S3/R2 conditional object adapter is implemented and locally tested. The Worker,
Durable Object routing, container runtime, deployment template and CLI integration
are not implemented yet. This is not a supported deployment target until the
qualification gates pass.

`S3ObjectStore` uses Bun's SigV4 presigning and an injectable HTTP transport. It
sends `If-None-Match: *` on create and `If-Match` on replacement directly to the
private S3 endpoint. It never retries an uncertain PUT. Existing backup
`S3Store` behavior is unchanged. Credential-free tests include real loopback HTTP
requests and injected dropped responses.

To run the non-destructive, billable storage smoke test against a disposable R2
bucket, supply these environment variables through your secret manager:

- `BQL_BILLABLE_TESTS=1`
- `S3_BUCKET`
- `S3_ENDPOINT` (private R2 S3 API endpoint)
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `S3_REGION=auto`
- `BQL_TEST_PREFIX=bql-qualification/`

Run `bun run --cwd deploy/cloudflare storage:smoke`. It writes a randomly named
object and leaves it there for inspection. It checks create/CAS races, origin
visibility and stale-version rejection. Each CAS changes the bytes: S3 ETags can
be equal for equal content. Cloud root revisions must always advance.

Evidence as of 2026-09-26: local contract tests pass; real R2 tests have **not** been
run. Cross-process and cross-region races, payload and overwrite limits, container
sleep/wake, overlapping rollout, and empty-disk recovery remain unqualified.

References: [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
