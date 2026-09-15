# L3 — the fd budget is a node number

`docs/plan-limits.md` L3. One deviation from the plan, and it is the interesting part.

## 1. The bug

`TenantRegistry` warned when `maxOpen * 7` exceeded `ulimit -n`. Every worker built its own
registry from the same `config.data.maxOpen` (`runtime.ts`), and **Bun workers are threads sharing
one file-descriptor table** — so `workers: 8, maxOpen: 1024` held 8192 databases open and wanted
about 57 000 descriptors, while each of the eight threads independently warned about 7 168. The
check under-reported by exactly the worker count, and the ceiling an operator configured was not
the ceiling the node enforced.

The probe was also `Bun.spawnSync(["sh", "-c", "ulimit -n"])` — once per registry, so N subprocess
spawns on an N-worker node. And on Windows, a gating platform since E2, it did not fail the way
this document first claimed: a runner has Git Bash on `PATH`, so the probe *succeeded* and returned
an MSYS shell's descriptor limit, which has nothing to do with a Bun process on Win32. §3b.

## 2. What it is now

`[data] maxOpen` is the node's number. `WorkerPool.start` divides it — `maxOpenShare(maxOpen,
workers)` — and sends each worker a config carrying its own share, so eight workers at `maxOpen:
1024` get 128 each and the node holds at most 1024. The router keeps the undivided number, which
is what `GET /v1/db` and `/metrics` report.

The probe is memoised per process and skipped outright on Windows, and a worker's registry is
passed `fdBudget: false`: the router probes once and warns once, for the node's requirement rather
than a thread's share of it.

Both surfaces now name the ceiling:

```
GET /v1/db → { "open": 3, "maxOpen": 1024, "databases": [ … ] }
/metrics   → bunql_open_tenants 3
             bunql_max_open_tenants 1024
```

## 3. Deviations from the plan

**The per-worker floor is one, not eight.** The plan says `floor(maxOpen / workers)`, "at least 8
per worker". A floor of eight is `8 * workers` wearing a disguise — which is precisely the "a
per-tenant limit times open tenants is not a limit" that this milestone exists to delete. A node
configured with `maxOpen: 16` and four workers would then hold 32, and the node-wide guarantee
would hold for large configurations and quietly fail for small ones, which is the worst shape a
guarantee can have.

So the share floors at one, and `maxOpenThrashes()` warns at start when the division leaves a shard
under eight:

```
bunql: maxOpen 16 across 4 workers is 4 databases per shard, which will evict and reopen on
most requests. Raise maxOpen to at least 32 or lower workers.
```

Slow rather than wrong, said out loud, and `maxOpen` still means what it says.

**`process.report.getReport().header` does not carry `rlimit` in Bun.** The plan suggested it as
the replacement for the subprocess. Checked on Bun 1.4: the header has 23 keys and none of them is
`rlimit` (Node's report does; Bun's does not). Reaching `getrlimit(2)` would mean a second `dlopen`
of libc on every start, for a warning. So it is still `ulimit -n` on POSIX — memoised, and run once
per node rather than once per thread — and a documented null on Windows, where Win32 has no
per-process descriptor rlimit at all: `_setmaxstdio` bounds only stdio-style handles and a kernel
handle is bounded by paged-pool memory rather than by a count.

## 3b. What Windows CI corrected about "a documented null"

The first push failed the Windows gate on `warns when maxOpen outruns the file-descriptor limit`,
and the reason is worth keeping: **a `windows-latest` runner does have `sh`**, because Git for
Windows puts Git Bash on `PATH`. So the pre-L3 probe did not fail there at all — it ran, and
returned Git Bash's own MSYS descriptor limit, which says nothing whatsoever about a Bun process on
Win32. The test passed on a number that was meaningless.

Returning null is therefore *more* correct, not merely equivalent. What had to change was the test,
which encoded the platform rather than the rule: it now asks `fileDescriptorLimit()` and asserts a
warning where there is a limit to read and none where there is not.

## 4. Done when — against the plan's criteria

| criterion | result |
|---|---|
| a node started with `workers: 8, maxOpen: 1024` holds at most 1024 tenants across every shard | **yes.** `test/server/max-open.test.ts` runs the same shape smaller — `workers: 4, maxOpen: 40`, sixty databases all touched — and asserts at most forty open. Run against a tree with the division removed it reports sixty, so it discriminates |
| `GET /v1/db` and `/metrics` agree on the total | **yes**, and on the ceiling: the test compares `open`/`maxOpen` from the listing against `bunql_open_tenants`/`bunql_max_open_tenants` |
| the fd warning fires once with the node's real requirement | **yes.** One probe, memoised, on the router; `warnFdBudget(config.data.maxOpen)` before the workers are spawned; `fdBudget: false` on every worker registry |

## 5. What it touched

`src/tenant/registry.ts` (`fileDescriptorLimit` memoised and Windows-aware, `fdBudgetFor`,
`maxOpenShare`, `maxOpenThrashes`, `warnFdBudget`, `RegistryOptions.fdBudget`),
`src/tenant/index.ts`, `src/server/workers/pool.ts` (the division, the two warnings),
`src/server/runtime.ts` (`fdBudget: false` on a shard), `src/server/routes.ts` (`open`/`maxOpen` on
the listing), `src/server/registry.ts` (the response schema), `src/server/metrics.ts`
(`bunql_max_open_tenants`), `src/server/workers/router.ts`, `docs/api.md`, `docs/design.md` §4.7.
