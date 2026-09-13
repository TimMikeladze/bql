// The promotion decision, exhaustively, without a cluster.
//
// This is the point of `decidePromotion` being pure: its failure mode is two nodes writing to one
// database and nothing saying so, which is not a failure an integration test reliably produces. So
// every refusal, every ordering between refusals, and the epoch arithmetic are pinned here, on
// plain objects, with no clock and no socket anywhere.

import { describe, expect, test } from "bun:test"
import {
  type ClusterFacts,
  decidePromotion,
  pickFailover,
  type PromotionInput,
} from "../../src/cluster/promotion.ts"

function facts(over: Partial<ClusterFacts> = {}): ClusterFacts {
  return {
    epoch: 3,
    primary: "n1",
    replicas: ["n2", "n3"],
    lease: null,
    acked: {},
    nowMs: 10_000,
    ...over,
  }
}

function input(over: Partial<PromotionInput> = {}): PromotionInput {
  return {
    db: "acme",
    node: "n2",
    hasCopy: true,
    isPrimaryLocally: false,
    localGeneration: "gen-a",
    placedGeneration: "gen-a",
    applied: "42",
    localEpoch: 3,
    streamLive: false,
    cluster: null,
    force: false,
    ...over,
  }
}

describe("decidePromotion — refusals", () => {
  test("a node with no copy has nothing to promote", () => {
    const decision = decidePromotion(input({ hasCopy: false }))
    expect(decision).toEqual({
      ok: false,
      code: "NO_COPY",
      why: "n2 holds no copy of acme to promote",
    })
  })

  test("a copy of a different generation is refused, which is what R7 bought", () => {
    const decision = decidePromotion(
      input({ localGeneration: "old", placedGeneration: "new", cluster: facts() }),
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error("unreachable")
    expect(decision.code).toBe("GENERATION_MISMATCH")
    expect(decision.why).toContain("old")
    expect(decision.why).toContain("new")
  })

  test("the generation check needs both ids; a peer that announces none is not refused", () => {
    expect(decidePromotion(input({ localGeneration: null, placedGeneration: "new" })).ok).toBe(true)
    expect(decidePromotion(input({ localGeneration: "old", placedGeneration: null })).ok).toBe(true)
  })

  test("a static replica whose stream is live is refused: its primary is demonstrably up", () => {
    const decision = decidePromotion(input({ streamLive: true }))
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error("unreachable")
    expect(decision.code).toBe("STREAM_LIVE")
  })

  test("a live stream does not block a clustered failover; the lease is the authority there", () => {
    expect(decidePromotion(input({ streamLive: true, cluster: facts() })).ok).toBe(true)
  })

  test("a lease another node still holds is refused — the guard, and the whole safety story", () => {
    const decision = decidePromotion(
      input({ cluster: facts({ lease: { node: "n1", until: 12_500 }, nowMs: 10_000 }) }),
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error("unreachable")
    expect(decision.code).toBe("LEASE_HELD")
    expect(decision.why).toContain("2500ms")
  })

  test("a lease that has lapsed on the leader's clock is not held", () => {
    expect(
      decidePromotion(input({ cluster: facts({ lease: { node: "n1", until: 9_999 }, nowMs: 10_000 }) }))
        .ok,
    ).toBe(true)
  })

  test("the node that is already the primary is told so rather than burning an epoch", () => {
    expect(decidePromotion(input({ isPrimaryLocally: true })).ok).toBe(false)
    expect(
      decidePromotion(
        input({
          node: "n1",
          isPrimaryLocally: true,
          cluster: facts({ lease: { node: "n1", until: 12_000 } }),
        }),
      ),
    ).toEqual({ ok: false, code: "ALREADY_PRIMARY", why: "n1 is already the primary for acme" })
  })

  test("a primary whose own lease lapsed may re-take it", () => {
    const decision = decidePromotion(
      input({
        node: "n1",
        isPrimaryLocally: true,
        cluster: facts({ lease: { node: "n1", until: 9_000 }, nowMs: 10_000 }),
      }),
    )
    expect(decision).toEqual({
      ok: true,
      epoch: 3,
      why: "n1 renews its own lapsed lease on acme; the epoch stays at 3",
    })
  })

  test("a node behind another's acked position is refused, by name and by how far", () => {
    const decision = decidePromotion(
      input({ applied: "42", cluster: facts({ acked: { n2: "42", n3: "97" } }) }),
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error("unreachable")
    expect(decision.code).toBe("BEHIND")
    expect(decision.why).toContain("n3")
    expect(decision.why).toContain("97")
  })

  test("its own acked position never makes it behind, and equal is not behind", () => {
    expect(
      decidePromotion(input({ applied: "42", cluster: facts({ acked: { n2: "999", n3: "42" } }) })).ok,
    ).toBe(true)
  })

  test("acked positions compare as numbers, not as strings", () => {
    // "9" > "100" lexically, and a promotion decided that way would throw away 91 transactions.
    expect(
      decidePromotion(input({ applied: "100", cluster: facts({ acked: { n3: "9" } }) })).ok,
    ).toBe(true)
    expect(
      decidePromotion(input({ applied: "9", cluster: facts({ acked: { n3: "100" } }) })).ok,
    ).toBe(false)
  })

  test("refusals are checked in one fixed order", () => {
    // Everything is wrong at once; the answer is always the first check that fails.
    const everything = input({
      hasCopy: false,
      localGeneration: "old",
      placedGeneration: "new",
      streamLive: true,
      isPrimaryLocally: true,
      applied: "1",
      cluster: facts({ lease: { node: "n1", until: 99_999 }, acked: { n3: "500" } }),
    })
    const order = ["NO_COPY", "GENERATION_MISMATCH", "LEASE_HELD", "ALREADY_PRIMARY", "BEHIND"]
    const relax: Record<string, Partial<PromotionInput>> = {
      NO_COPY: { hasCopy: true },
      GENERATION_MISMATCH: { placedGeneration: "old" },
      LEASE_HELD: { cluster: facts({ lease: { node: "n2", until: 99_999 }, acked: { n3: "500" } }) },
      ALREADY_PRIMARY: { isPrimaryLocally: false },
    }
    let current = everything
    for (const code of order) {
      const decision = decidePromotion(current)
      expect(decision.ok).toBe(false)
      if (decision.ok) throw new Error("unreachable")
      expect(decision.code).toBe(code as never)
      if (relax[code]) current = { ...current, ...relax[code] }
    }
  })

  test("force overrides exactly three refusals and no others", () => {
    const forced = { force: true }
    expect(decidePromotion(input({ ...forced, streamLive: true })).ok).toBe(true)
    expect(
      decidePromotion(input({ ...forced, cluster: facts({ lease: { node: "n1", until: 99_999 } }) }))
        .ok,
    ).toBe(true)
    expect(
      decidePromotion(input({ ...forced, cluster: facts({ acked: { n3: "999" } }) })).ok,
    ).toBe(true)
    // …and not these two, which are not about whether it is safe but about whether it is possible.
    expect(decidePromotion(input({ ...forced, hasCopy: false })).ok).toBe(false)
    expect(
      decidePromotion(input({ ...forced, localGeneration: "old", placedGeneration: "new" })).ok,
    ).toBe(false)
  })
})

describe("decidePromotion — the epoch it hands out", () => {
  test("a static promotion is one past the copy's own epoch", () => {
    expect(decidePromotion(input({ localEpoch: 7 }))).toMatchObject({ ok: true, epoch: 8 })
  })

  test("a clustered promotion is one past the highest epoch anybody is known to hold", () => {
    expect(
      decidePromotion(input({ localEpoch: 9, cluster: facts({ epoch: 3, primary: "n1" }) })),
    ).toMatchObject({ ok: true, epoch: 10 })
    expect(
      decidePromotion(input({ localEpoch: 3, cluster: facts({ epoch: 9, primary: "n1" }) })),
    ).toMatchObject({ ok: true, epoch: 10 })
  })

  test("claiming a database the cluster has never placed fences nobody, so it burns no epoch", () => {
    expect(
      decidePromotion(
        input({ localEpoch: 4, cluster: facts({ epoch: 0, primary: null, replicas: [] }) }),
      ),
    ).toMatchObject({ ok: true, epoch: 4 })
  })

  test("a node re-taking a database it is already recorded as the primary of burns no epoch", () => {
    expect(
      decidePromotion(
        input({ node: "n1", localEpoch: 5, cluster: facts({ epoch: 5, primary: "n1", lease: null }) }),
      ),
    ).toMatchObject({ ok: true, epoch: 5 })
  })
})

describe("pickFailover", () => {
  const base = {
    db: "acme",
    primary: "n1" as string | null,
    replicas: ["n2", "n3"],
    acked: { n1: "100", n2: "97", n3: "99" },
    reachable: new Set(["n2", "n3"]),
    nowMs: 10_000,
  }

  test("a live lease is never handed on — this is the guard", () => {
    expect(pickFailover({ ...base, lease: { node: "n1", until: 10_001 } })).toBeNull()
    // One millisecond later it is fair game.
    expect(pickFailover({ ...base, lease: { node: "n1", until: 10_000 } })).not.toBeNull()
  })

  test("it picks the highest acked txid among the reachable placement", () => {
    expect(pickFailover({ ...base, lease: null })).toEqual({ node: "n3", applied: "99" })
  })

  test("an unreachable node is not a candidate however far ahead it is", () => {
    expect(
      pickFailover({ ...base, lease: null, reachable: new Set(["n2"]) }),
    ).toEqual({ node: "n2", applied: "97" })
  })

  test("a reachable holder whose lease merely lapsed gets its own database back", () => {
    expect(
      pickFailover({
        ...base,
        lease: { node: "n1", until: 9_000 },
        reachable: new Set(["n1", "n2", "n3"]),
      }),
    ).toEqual({ node: "n1", applied: "100" })
  })

  test("a database with no placement has no candidate", () => {
    expect(pickFailover({ ...base, primary: null, replicas: [], lease: null })).toBeNull()
  })

  test("no reachable member means no failover rather than a bad one", () => {
    expect(pickFailover({ ...base, lease: null, reachable: new Set() })).toBeNull()
  })

  test("a node that has never acked counts as zero, not as absent", () => {
    expect(
      pickFailover({ ...base, lease: null, acked: {}, reachable: new Set(["n2", "n3"]) }),
    ).toEqual({ node: "n2", applied: "0" })
  })

  test("ties break on node id, so two leaders in succession make the same choice", () => {
    const tied = { ...base, lease: null, acked: { n2: "99", n3: "99" } }
    expect(pickFailover(tied)).toEqual({ node: "n2", applied: "99" })
    expect(pickFailover({ ...tied, replicas: ["n3", "n2"] })).toEqual({ node: "n2", applied: "99" })
  })
})
