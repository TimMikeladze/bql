# P4 — the router's accept-and-hop loop, profiled

`docs/next.md` called this "the biggest unexamined lever on the surface most deployments use": a
sharded node's HTTP reads stop scaling past two workers, and nobody had measured why. Measured now.

**The short version: the hop is not where the loss is, and `workers: N` is a write lever rather
than a read lever on the HTTP surface.** The numbers below are the evidence, including the controls
that rule out the answers one would otherwise reach for.

M5 Pro, macOS 26.6.2, Bun 1.4.0, 18 cores, every figure from a load client in its own process.

## 1. What the ladder actually says

`bun run bench/workers.ts --follow --transport http` over four runs:

| workers | run A | run B | run C |
|---|---|---|---|
| 1 | 35 116 | | |
| 2 | 53 935 | 53 543 | |
| 4 | 58 423 | 57 618 | 45 829 · 34 201 |
| 6 | 28 726 | 57 409 | |

**The first thing to say about this table is that it is too noisy to rank 4 against 6.** An earlier
reading of it recorded a "collapse at six workers"; two more runs put six above four. Reads/s at one
rung varies by 40% between runs. Any conclusion drawn from the *shape* past two workers is drawn
from noise, and the only thing it supports is that it stops scaling.

With **two** load-client processes instead of one, which is the control that matters (see §2):

| workers | total reads/s |
|---|---|
| 1 | 31 165 |
| 4 | 48 694 |

1.56x for four times the workers.

## 2. The control: what is the client, and what is the server?

A `Bun.serve` that does nothing but return a fixed 130-byte JSON body, driven by the same client:

| clients | reads/s |
|---|---|
| 1 | 66 749 |
| 2 | 75 294 + 77 309 = **152 603** |

**One load-client process tops out around 75 000 requests/s.** Every single-client figure in §1 is
therefore measured against a ceiling only a little above it, which is most of the variance — and it
is why §1's two-client row is the one to believe.

And the server side of a do-nothing Bun.serve is **at least 152 000/s**. So the sharded node's
~49 000 is not Bun's HTTP stack being slow. Roughly **14 µs per request is ours**, on the router,
single-threaded — and that is what caps the ladder, exactly as Amdahl says it must.

## 3. What the channel costs, on its own

`bun run bench/hop.ts` measures one round trip across the `postMessage` channel with no SQLite, no
HTTP and no network — the message is the shape and size of a real hop, and the reply carries four
headers and a 200-byte body.

| workers | http-shaped | empty message | http-shaped, batched per tick |
|---|---|---|---|
| 1 | 428 474 | 698 934 | 1 245 568 |
| 2 | 341 840 | 535 172 | 334 845 |
| 4 | 239 173 | 326 883 | 234 949 |
| 6 | 205 892 | 240 541 | 201 818 |

Three things fall out of it, and the third is the one that matters.

**The payload costs about 1.6x.** A real hop's headers, URL and body are worth that much against an
almost empty message, at every rung. Worth knowing; not worth chasing, because it does not change
the shape.

**Total channel capacity falls as workers are added** — 428k to 206k from one to six — so *per
worker* it falls twelvefold. That is the shape §1 sees.

**But the channel is not the binding constraint.** At four workers it does 239 000 round trips/s
while the node does 49 000 reads/s: **five times the headroom**. A hop costs 4.2 µs of the ~20 µs
the router spends per request. Real, and a fifth of the problem.

### 3.1 What was ruled out

Each of these is an answer that sounds right and is wrong, and each cost a measurement:

- **Batching is not it.** Collecting everything produced in a tick and posting it as one message is
  worth **2.9x at one worker** and *nothing at all* from two upwards — 335k against 342k, 235k
  against 239k. So the cost is not per message. Raising the in-flight depth from 64 to 1024, which
  makes the batches sixteen times deeper, changes nothing either.
- **Having the threads attached is not it.** Six workers attached with every message sent to worker
  zero: 389 000 round trips/s, against 390 000 with one worker attached. Idle threads are free.
- So what degrades is **spreading traffic across ports**, and it degrades whether the traffic is
  one message at a time or a thousand. That is inside Bun's cross-thread dispatch, not in anything
  this router does, and no amount of batching or shrinking reaches it.

## 4. What was changed, and honestly what it was worth

**`forwardByPath` no longer parses the URL.** Bun's router has already matched `/v1/db/:db/…` and
left the segment in `request.params`, so the common case needs neither a `new URL` nor a split.
Measured at four workers with two clients: 49 615 and 55 055 against a 48 694 baseline. That is
**inside the noise band**, and it is kept because it does strictly less work rather than because
the benchmark proved it.

**The per-request abort listener was measured and left alone.** Removing
`request.signal.addEventListener("abort", …)` entirely — which would break the SSE cancel path, so
this was an experiment and not a change — gave 53 207 and 56 465. Three to seven percent, inside
the same band. A lazy registration (only once the worker answers with `http.open`) would be real
work for a gain the measurement cannot see, so it was not built.

Neither is the 10 µs. What is left of the router's per-request cost is Bun's own machinery —
building a `Response` and a `Headers` from the reply, and the structured clone of the headers and
body in both directions — and that is where the next person should look, with §2's two-client
control in hand.

## 5. What this means for a deployment

**`workers: N` is a write lever.** Writes scale 28 809 to 86 754/s and the hop is 4 µs against a
28 µs write. Reads over HTTP scale 1.56x and stop, because a read is a few microseconds of SQLite
behind ~20 µs of router. Reads over a socket are *worse* on a sharded node — C4c measured 0.90x —
for the same reason, and the relay is on the same single thread.

So a read-heavy node should be sized by measurement rather than by core count, and more workers past
two or four will not help it. `[server] workers = 0` still resolves to one per core capped at eight;
that cap is above the useful range for this workload on this machine, and it is left alone because
the useful range is a property of the machine and the mix, not something to bake in.

**The thing that would actually move it** is not making the hop cheaper. It is not hopping: a
design where the thread that accepts the connection is the thread that owns the database. That is
the `reusePort` shape `docs/c4-workers.md` §2 rejected — it does not load-balance on macOS, and it
turns every per-process singleton into an N-way distributed object — and nothing here changes that
judgement. It only says where the remaining 2.6x is.
