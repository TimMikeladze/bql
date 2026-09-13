// `place` is pure, so it is tested exhaustively rather than through a cluster
// (`docs/c3-placement.md` §5). The oracle is that **every node computes the same answer**: that is
// what lets a create be gated without a quorum, and a disagreement here is two nodes both creating
// `acme`.

import { describe, expect, test } from "bun:test"
import { homeOf, place, type PlacementNode } from "../../src/cluster/index.ts"

function nodes(count: number, zones: string[] = []): PlacementNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i + 1}`,
    zone: zones[i % Math.max(1, zones.length)] ?? "",
  }))
}

const NAMES = Array.from({ length: 10_000 }, (_, i) => `db${i}`)

describe("place", () => {
  test("is independent of the order the members arrive in", () => {
    const members = nodes(5, ["a", "b", "c"])
    const shuffled = [...members].reverse()
    for (const db of NAMES.slice(0, 200)) {
      expect(place(db, shuffled, 3)).toEqual(place(db, members, 3) as never)
    }
  })

  test("spreads the load evenly over the cluster", () => {
    const members = nodes(5)
    const count = new Map<string, number>()
    for (const db of NAMES) {
      const home = homeOf(db, members) as string
      count.set(home, (count.get(home) ?? 0) + 1)
    }
    expect(count.size).toBe(5)
    // A few percent either side of 1/N over 10 000 names. Rendezvous is uniform without the
    // virtual nodes a ring needs to be, which is most of why it was chosen.
    for (const share of count.values()) {
      expect(share).toBeGreaterThan(NAMES.length / 5 - NAMES.length / 25)
      expect(share).toBeLessThan(NAMES.length / 5 + NAMES.length / 25)
    }
  })

  test("moves only the databases that named a departing node", () => {
    const before = nodes(5)
    const after = before.filter((one) => one.id !== "n3")
    let moved = 0
    let namedN3 = 0
    for (const db of NAMES) {
      const was = homeOf(db, before) as string
      const now = homeOf(db, after) as string
      if (was === "n3") namedN3++
      if (was !== now) moved++
    }
    // Exactly the minimum: a database whose home is still in the cluster does not move at all.
    expect(moved).toBe(namedN3)
  })

  test("adds a node by moving only its own new share", () => {
    const before = nodes(4)
    const after = nodes(5)
    let moved = 0
    for (const db of NAMES) {
      if (homeOf(db, before) !== homeOf(db, after)) moved++
    }
    // ~1/5 of the keys, and every one of them moves *to* the new node.
    expect(moved).toBeGreaterThan(NAMES.length / 5 - NAMES.length / 20)
    expect(moved).toBeLessThan(NAMES.length / 5 + NAMES.length / 20)
    for (const db of NAMES) {
      if (homeOf(db, before) !== homeOf(db, after)) expect(homeOf(db, after)).toBe("n5")
    }
  })

  test("spreads a replica set across zones when there are enough of them", () => {
    const members = nodes(6, ["a", "b", "c"])
    const zoneOf = new Map(members.map((one) => [one.id, one.zone]))
    for (const db of NAMES.slice(0, 500)) {
      const chosen = place(db, members, 3)
      if (!chosen) throw new Error("no placement")
      const picked = [chosen.primary, ...chosen.replicas]
      expect(picked.length).toBe(3)
      expect(new Set(picked).size).toBe(3)
      expect(new Set(picked.map((one) => zoneOf.get(one))).size).toBe(3)
    }
  })

  test("degrades rather than refusing when there are fewer zones than rf", () => {
    // The shape every single-zone cluster has, and the one a placement function must not fail on:
    // an operator who wants to be told wants an alert, not a refusal to place.
    const members = nodes(3, ["a"])
    for (const db of NAMES.slice(0, 200)) {
      const chosen = place(db, members, 3)
      if (!chosen) throw new Error("no placement")
      expect([chosen.primary, ...chosen.replicas].length).toBe(3)
      expect(new Set([chosen.primary, ...chosen.replicas]).size).toBe(3)
    }
  })

  test("never asks for more copies than there are nodes", () => {
    const members = nodes(2, ["a", "b"])
    const chosen = place("acme", members, 5)
    expect(chosen?.replicas.length).toBe(1)
    expect(place("acme", members, 1)?.replicas).toEqual([])
    // rf below 1 is a misconfiguration, and one copy is the floor rather than none.
    expect(place("acme", members, 0)?.replicas).toEqual([])
  })

  test("an empty cluster has no placement, which is the standalone node", () => {
    expect(place("acme", [], 2)).toBeNull()
    expect(homeOf("acme", [])).toBeNull()
  })

  test("an unlabelled cluster still spreads, because a blank zone is its own", () => {
    const members = nodes(3)
    const chosen = place("acme", members, 3)
    expect(new Set([chosen?.primary, ...(chosen?.replicas ?? [])]).size).toBe(3)
  })

  test("the primary is the top-ranked node, whatever rf is", () => {
    const members = nodes(5, ["a", "b"])
    for (const db of NAMES.slice(0, 100)) {
      const home = homeOf(db, members)
      for (const rf of [1, 2, 3, 5]) expect(place(db, members, rf)?.primary).toBe(home as string)
    }
  })
})
