# L1 — a result is bounded while it is built

`docs/plan-limits.md` L1. What landed, what it cost, and the two places the plan and the code
disagree.

## 1. The bug, stated exactly

`maxRows` was a report, not a bound. `src/server/exec.ts` called `stmt.values(...)`, which stepped
the statement to `SQLITE_DONE` pushing one JavaScript array per row, and *then* compared
`rows.length` against the ceiling. The deadline (`db.deadline`, a progress handler firing every
1000 VM steps) bounds **time**; nothing bounded allocation. So a scan that returns twenty million
rows inside `queryTimeoutMs` allocated twenty million arrays before anything looked at the count,
and the resulting OOM takes the process — on a node with `workers: N`, one shard's worth of every
tenant that shard holds, not just the tenant that asked.

Measured, on the tree at `38142c9`: a five-million-row query refused with `400 TOO_MANY_ROWS`
against a `maxRows` of 10 000 grew RSS by **286 MB** before answering. It is the same 400 either
way, which is why the test asserts peak RSS rather than the status — the status was already right.

## 2. What it is now

A `ResultBudget` — `{ maxRows, maxBytes }` — is armed on the statement before the verb that builds
a result and consumed by it:

```ts
stmt.budget({ maxRows: options.maxRows, maxBytes: options.maxResultBytes })
rows = stmt.values(...params)
```

`all()`, `values()` and `iterate()` check it at the top of each turn of the step loop and throw
`ResultLimitError` at the row that would cross it, so the overshoot is one row. The `finally` that
was already there resets the statement on the way out, on this path as on every other.

Same RSS measurement after: **under 1 MB**, and the test bounds it at 100 MB so a GC that has not
run cannot make it flaky.

### Three decisions worth writing down

**The budget is one-shot.** It is taken and cleared by `#prepareCall`, which every verb calls.
Statements live in a connection's prepared-statement cache and are handed back out by SQL text, so
an armed ceiling that outlived its call would silently bound somebody else's result. A budget armed
before `run()` or `get()` — verbs that build no result — is discarded with the call, not carried.

**The unbounded path is untouched, deliberately.** `values()` and `all()` branch *once per call* on
`budget === null` into either the original tight loop or the bounded one. The alternative — one
loop with a per-row check — is what the driver benchmark would have had to pay for, and the driver
has callers (`bench/driver.ts`, the catalog, the embedded API) that arm no budget at all. Likewise
`columnValueInto` is a copy of `columnValue`'s switch rather than a flag on it: `columnValue` is
called from generated row-factory code on the hot path, where a per-cell branch is measurable.

**Bytes are the result's footprint, not its serialised length.** SQLite's own byte count for text
and blobs — already read in order to decode them, so counting is an add rather than a second pass —
eight bytes for a number, plus `ROW_OVERHEAD_BYTES` (16) and `CELL_OVERHEAD_BYTES` (8) per cell.
The per-row and per-cell charges are what make the ceiling hold for a query whose cells are all
NULL or all small integers, where the payload is nearly zero and the arrays holding it are not.

## 3. Deviations from the plan

- **The plan says "throw `TOO_MANY_ROWS` or `RESULT_TOO_LARGE`".** Those are HTTP-layer codes and
  the throw happens in `src/sqlite/`, which knows nothing about HTTP and must keep it that way. The
  step loop throws `ResultLimitError` (`limit: "rows" | "bytes"`, `max`), and `mapError` in
  `src/server/errors.ts` is the one place that translates it — to exactly those two codes. The
  embedded API sees the driver's error; the wire sees the vocabulary design §6.6 documents.
- **`maxResultBytes` has no request field.** The plan lists it under `[limits]` and the track's
  "what does not change" says the wire gains error codes and one header, nothing else. So a client
  bounds its own result with `maxRows` and the node bounds the client with `maxResultBytes`; there
  is no `body.maxResultBytes`. `resolveOptions` reads it straight from the config.

## 4. Done when — against the plan's criteria

| criterion | result |
|---|---|
| a 5M-row query without a `LIMIT` refuses in bounded memory, asserting peak RSS | **yes.** `test/server/result-budget.test.ts`; 286 MB before, under 100 MB asserted after. The test was run against the pre-L1 tree and fails there at 286, so it discriminates |
| `RETURNING` past the cap rolls back | **yes.** The throw crosses `tenant.write`, which rolls the transaction back; the test asserts the table is still empty |
| the driver benchmark moves less than 2% on the 100-row scan | **yes, and it is not resolvable from noise.** Eight interleaved A-B pairs, `bun run bench --only driver`: paired-ratio median **1.0025**, median-of-medians **0.998**, individual pairs spanning 0.954–1.049. This machine was at load average 5.6 (`docs/performance.md` §8 conditions were *not* met), so the honest statement is that the change is smaller than a ±5% resolution floor — which is what the arithmetic predicts, since the added work is three field operations per *call*, not per row |

## 5. What it touched

`src/sqlite/values.ts` (`columnValueInto`, `ByteSink`, the two overhead constants),
`src/sqlite/statement.ts` (`ResultBudget`, `budget()`, `resultBytes`, bounded `all`/`values`/
`iterate`, the counting row factory, `#prepareCall` returning the budget), `src/sqlite/errors.ts`
(`ResultLimitError`), `src/sqlite/index.ts`, `src/server/config.ts` (`[limits] maxResultBytes`),
`src/server/errors.ts` (`RESULT_TOO_LARGE`, the translation), `src/server/exec.ts`,
`src/server/metrics.ts` (`bunql_result_bytes_max`, merged across workers as a **max**: the largest
result any shard built is the largest this node built), `src/server/registry.ts`,
`src/dataapi/operations.ts`, `src/client/protocol.ts`, `docs/api.md`, `docs/design.md` §4.7 and
§6.6.
