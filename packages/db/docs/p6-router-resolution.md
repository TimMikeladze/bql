# P6 — an instrument fine enough to answer P4, and what it said

`docs/p4-router-hop.md` ended with two suspects and no way to choose between them: *"building a
`Response` and a `Headers` from the reply pairs, and the structured clone of the headers and body
both ways… that is where the next person should look, with §2's two-client control in hand."*

It also left the reason nobody could: one load-client process tops out near 75 000 requests/s, and
the run-to-run spread at one rung of the ladder was 40%. A 10% change is invisible in that.

So this milestone is **the instrument first**, and the first thing it reports is its own resolution.

## 1. The rule this follows

> If the harness cannot separate a target from **itself**, it cannot separate two targets either,
> and saying so is the result.

Every number below is preceded by that test.

## 2. What the instrument is

`bench/router.ts`, with `bench/router-client.ts` as its load half and `bench/router-control.ts` as
a `Bun.serve` that answers the same route with a canned body.

Four things make it finer than `bench/workers.ts`, and each of them was forced by a measurement:

**Two load processes.** P4 §2 established one is the ceiling. Both are summed.

**Long-lived clients.** The first version spawned fresh client processes per round and fell from
133 000/s in round one to 97 000 in round seven — sockets in `TIME_WAIT` accumulating across
rounds. The clients now open their lanes once and wait on stdin for `go <seconds>`; between windows
the connections stay open and idle. That alone took the round-to-round spread from 166% to 15%.

**Interleaved, alternating rounds.** Targets run A,B then B,A then A,B. Without the alternation the
second slot carried a 2.4% bias; with it the control's median ratio against itself is 1.002.

**Paired ratios, bootstrapped.** Each round yields one B/A ratio — the pair shared a moment, so
whatever the machine was doing is in both halves. The statistic is the *median* of those ratios and
a 90% interval for it, resampled, because a dozen ratios are not normal and one bad round should
not move the answer.

### 2.1 Its resolution, measured

`control` against `control`, 40 interleaved rounds of 3 s:

| | |
|---|---|
| median ratio | **1.002x** (unbiased) |
| the median's 90% interval | 0.986–1.024, **3.8% wide** |
| one round's own middle half | 0.974–1.062 |

**So it resolves about 4%, and the brief asked for 5%.** At 12 rounds the interval is 10% wide, at
40 it is 3.8%: the interval narrows as 1/√n, which is what tells you how long to run it for.

### 2.2 And its one real flaw, also measured

The same *node* against itself — `node:4` twice, 30 rounds — is **0.978x (0.964–0.992)**. The second
slot carries a systematic 2.2% penalty that the control does not show, and the interval excludes
1.0, so it is real rather than noise.

At **one worker** it is much worse: the same tree against itself is **0.674x**. A single-threaded
node is slow enough that the four client processes' idle lanes are a material share of the machine,
and whatever asymmetry that creates is not cancelled by alternating.

**So a node A/B has to be run twice with the two trees swapped**, and the answer is the geometric
mean of the two readings, which cancels position exactly. Every node figure below is that. A
single-worker comparison is not reportable by this harness at all, which is worth knowing because
the obvious control for a hop change — "it must not move a node that has no hop" — is exactly the
measurement it cannot make.

## 3. The trap it fell into, and how the harness caught it

The first A/B ran the change against a `git worktree` of its own parent and reported **+11.4%** with
a 2.4% interval. It was wrong, and the control is what said so: the same comparison at **one
worker** — a code path the change does not touch at all — reported **1.73x**.

`vendor/sqlite/` is untracked, so the worktree had no vendored SQLite and was running against a
different libsqlite3 (`docs/c6-packaging.md`). The measurement was comparing two SQLite builds.

A number that large on a path that cannot have changed is the only reason it was caught. It is the
argument for running a control you already know the answer to.

## 4. What the two suspects cost

`bench/router-control.ts` isolates them with no thread and no channel anywhere near the
measurement: one `Bun.serve`, the same route, the same body, the work done inline. 40 rounds each.

| mode | what it does | ratio to `plain` |
|---|---|---|
| `plain` | `new Response(BODY, { headers: {…} })` | 1.000 |
| `headers` | the same, from the `[string, string][]` a worker reply carries | **0.978** (0.965–0.988) |
| `hop-shape` | `headers`, plus a structured clone of headers and body **both ways** | **0.583** (0.577–0.592) |

**Suspect (a), building a `Response` from header pairs, is real and small: 2.2%.**

**Suspect (b), the clone, is the one.** It costs 71% more time per request than not doing it.

Decomposed, against `hop-shape` as the baseline:

| mode | what it removes | ratio to `hop-shape` |
|---|---|---|
| `clone-headers` | the **body** clone | 1.066 (1.058–1.079) |
| `clone-body` | the **header** clone | **1.375** (1.365–1.386) |
| `hop-flat` | nothing — headers cross as one joined string instead of pairs | **1.192** (1.181–1.202) |

**It is the headers, not the body.** Removing the body clone entirely is worth 6.6%; removing the
header clone is worth 37.5%. A structured clone walks every object and every string it meets, and
a header set is an array of N two-element arrays — 3N+1 allocations against one.

And `hop-flat` says most of that is available without removing anything: flattening the pairs to
`"key\nvalue\nkey\nvalue"` and splitting them on the far side recovers **19.2%** of a hop, split
included.

## 5. What was changed

**Headers cross the channel flat.** `HttpHop`, `HttpReply` and `HttpOpen` carry `headers: string`;
`flattenHeaders`, `flattenPairs` and `unflattenHeaders` in `src/server/workers/protocol.ts` are the
only places that know the encoding. A newline is a safe separator because HTTP forbids one in a
header name or value — Bun's own parser rejects such a request before it reaches the router.

Measured on a real four-worker node against its own parent tree, run twice with the trees swapped
so position cancels:

| | new / old |
|---|---|
| old in slot 1 | 1.104 (1.094–1.116) |
| new in slot 1 | 1.049 (1.032–1.092) |
| **geometric mean** | **1.076** |

**About +7.6% on a sharded node's HTTP reads, and the honest band is 5–11%.** Every one of the four
A/Bs run favoured the new code, so the sign is not in doubt; the magnitude is what this machine
will not pin tighter. Absolute, at four workers: roughly 54 000 → 60 000 reads/s.

### What was tried and reverted

**Transferring the body instead of cloning it.** The `hop-shape` decomposition says the body clone
is 6.6% of a hop, so the obvious next step is to transfer it — the router already does above a
megabyte. Measured, in the request direction and then in both:

| | node:4 / control:plain |
|---|---|
| flat headers only | 0.459 (0.456–0.460) |
| plus the request body transferred | 0.458 (0.453–0.464) |
| plus the reply body transferred too | 0.440 (0.430–0.446) |

**Nothing, and then slightly worse than nothing.** A `POST /v1/db/{db}/query` body is forty bytes,
and taking ownership of a buffer is not cheaper than copying forty bytes. Reverted, and the
one-megabyte threshold stays — but it is now a measured threshold rather than an assumed one.

## 6. What is left of the router's per-request cost

P4 measured ~14 µs per request as the router's own, on its single thread. The clone was the biggest
nameable piece of it and about a fifth of that piece is now gone. What remains, in the order the
evidence points:

- **The rest of the header clone.** `hop-flat` recovers 19.2% of a hop where removing the clone
  entirely would recover 37.5%, so roughly half of the header cost survives flattening — the string
  itself still crosses, and both sides still build and parse it. A binary encoding, or caching the
  flattened form of the header sets a node actually sends, is where that goes.
- **Building the `Response`**, worth 2.2% and not worth chasing on its own.
- **Bun's cross-thread dispatch**, which P4 §3.1 measured degrading twelvefold per worker from one
  to six and which nothing this router does can reach.

The conclusion P4 reached stands: **`workers: N` is a write lever.** This makes its read leg about
8% less bad; it does not make it a read lever.
