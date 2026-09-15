# L4 — a pin is not a licence

`docs/plan-limits.md` L4. Two ceilings on the same mechanism, and a distinction the old comment got
half right.

## 1. The bug

`TenantRegistry.#evict` skipped `busy` and `pinned` tenants and then admitted the new one anyway,
with a comment saying so: *"the cap is a target, not a promise a correct write can break."*

That is true of `busy`. A tenant is busy for the duration of one statement, so the overshoot is
bounded by something the node controls, and refusing a correct write because the LRU is full would
be the worse answer.

It is not true of `pinned`. A pin is taken by `ServerRuntime.retain` when somebody subscribes and
released when the last subscriber leaves — which is whenever the client feels like it. So a client
opening one subscription against each of two thousand databases pinned two thousand tenants past
`maxOpen`, and nothing refused it: not the pin, because pins had no ceiling, and not the open,
because `#evict` admitted regardless. An ordinary client, no privileges, no malformed request.

## 2. What it is now

**Pins are counted per principal, and capped.** `pin(name, owner, { capped })` refuses with
`429 PIN_LIMIT` when `owner` already holds `[limits] maxPinnedPerPrincipal` (64) *distinct*
databases and this is a new one. The owner is `sub` from the token when it carries one and the
token id otherwise (`pinOwner` in `src/server/auth.ts`).

**Pins became counts rather than set membership.** With the owner now being the principal rather
than one anonymous `"default"`, a principal really does hold several subscriptions to the same
database, and the first of them to close must not release the pin the others still need. `#pinned`
is `Map<name, Map<owner, count>>`, with `#pinnedByOwner` as the reverse index so the cap is a
`Set.size` rather than a scan.

**A fully pinned LRU refuses the open.** `#evict(target)` now says what stopped it — `"ok"`,
`"busy"` or `"pinned"` — and `#openRow` makes room *before* opening. If the blocker is pins, the
open is refused `503 TOO_MANY_OPEN` instead of admitted. `"busy"` still overshoots, still by one
statement, and the comment now says which of the two it is talking about.

## 3. Three decisions worth writing down

**The admin key is not capped, and neither is an embedded caller.** `PIN_LIMIT` exists to stop one
*client* holding the node's LRU open. The operator's own key is not that client, and refusing an
operator's sixty-fifth subscription would be a worse failure than the one being prevented. The same
for `src/embedded.ts`, which is an in-process caller who already owns the machine. `PinHolder`
carries `capped` so this is a property of the holder rather than a special case in the registry.

**Baton and read transactions are pinned by the principal but not capped.** Keying them by
principal makes `pinnedBy(owner)` a true account of what one client holds. Capping them would be
redundant: an interactive transaction is leashed by `[limits] txIdleTimeoutMs`, `maxOpenTx` is 1
per database, and read transactions are bounded by `[limits] maxReadTx` and `readTxTimeoutMs`.
Nothing there can accumulate the way a subscription can.

**The retain window keeps one pin, and that is deliberate.** `[realtime] idleRetainMs` exists so a
client that drops and reconnects with `Last-Event-ID` can still be served from the ring — and an
evicted tenant takes the ring with it. So the *last* subscriber out keeps its pin until the window
closes, charged to that principal. It is bounded by a node setting (15 s by default) rather than by
how long a client feels like staying, which is the distinction this milestone is about. Earlier
subscribers release theirs immediately.

## 4. Done when — against the plan's criteria

| criterion | result |
|---|---|
| a principal subscribing past the pin limit is refused while other principals are unaffected | **yes.** `test/server/pin-limit.test.ts`: three subscriptions accepted, the fourth `429 PIN_LIMIT`, a second subscription to an already-pinned database accepted, and a different token's fourth accepted |
| a node whose LRU is fully pinned refuses a new open instead of exceeding `maxOpen` | **yes.** Four principals pin four databases on a node with `maxOpen: 4`; a fifth database answers `503 TOO_MANY_OPEN` and `bunql_open_tenants` stays at four |
| a dropped socket releases its pins | **yes**, and the test kills the sockets rather than unsubscribing politely. `bunql_tenants_pinned` returns to zero once the retain window passes |

All three cases were run against a tree with the two refusals disabled: the first two answer 200
and the third answers `BUSY` rather than `TOO_MANY_OPEN`, so the test discriminates.

## 4b. What counted pins broke, and how it was found

Windows CI caught it on the push, and it is the one risk the counted-pin change carried.

Pins used to be `Map<name, Set<owner>>`, so a holder pinning twice was idempotent and one `unpin`
released it. Counting them made a double-pin real — and `ReplicaClient.#snapshotEnd` was doing
exactly that: `installSnapshot` closes the tenant and reopens it, and L4 taught it to put every
holder's pins back, while the caller went on pinning again afterwards as it had to before. A stream
that bootstrapped by snapshot therefore held **two** pins, its single `unpin` on close released one,
and the database stayed pinned open for the life of the process — unevictable, and eventually
enough of them to make L4's own `TOO_MANY_OPEN` refuse new opens. The cluster test that noticed was
`a node in two replica sets holds one client per upstream node`, which timed out waiting for nodes
to hold their upstreams.

The fix is one deletion: the registry preserves pins across an install, so the caller does not
re-pin. It also closes an older, harmless leak — before L4 `installSnapshot` re-pinned under
`"default"`, which nothing ever released.

Two tests, at both levels: `test/tenant/replica.test.ts` pins the registry contract (a pin survives
`installSnapshot` exactly once), and `test/replication/stream.test.ts` pins the caller (a snapshot
bootstrap leaves exactly one pin). The second fails against the unfixed tree; the first does not,
which is why both are there.

## 5. What it touched

`src/tenant/registry.ts` (counted per-owner pins, `#pinnedByOwner`, `pinnedBy`, `#clearPins`,
`maxPinnedPerPrincipal`, `PinOptions`, `#evict` reporting its blocker, the refusal in `#openRow`,
`#openRefused`, `RegistryStats.pinned`/`openRefused`), `src/server/auth.ts` (`PinHolder`,
`pinOwner`, `INTERNAL_HOLDER`), `src/server/runtime.ts` (`retain`/`releaseSubscription` take a
holder, the retain window carries one, baton and read-transaction pins keyed by principal),
`src/server/routes.ts` and `src/server/ws.ts` (the SSE and WebSocket subscription paths),
`src/server/config.ts` (`[limits] maxPinnedPerPrincipal`), `src/server/errors.ts` (`PIN_LIMIT`,
`TOO_MANY_OPEN`), `src/server/metrics.ts` (`bunql_tenants_pinned`, `bunql_open_refused_total`),
`src/server/workers/{protocol,pool,entry,router}.ts` (both sum across the disjoint shards),
`src/server/registry.ts`, `src/client/protocol.ts`, `src/replication/replica.ts` (the double pin in
§4b), `docs/api.md`, `docs/design.md` §4.7 and §6.6.
