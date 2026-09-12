// The replicated state machine on its own: no raft, no sockets, no clock. Everything `apply`
// promises is checkable here, and the epoch rule — the whole fencing story — is the point.

import { describe, expect, test } from "bun:test"
import {
  apply,
  ClusterFormatError,
  type ClusterState,
  type Command,
  decodeCommand,
  decodeSnapshot,
  emptyState,
  encodeCommand,
  encodeSnapshot,
  SNAPSHOT_VERSION,
} from "../../src/cluster/state.ts"

function run(commands: Command[], from: ClusterState = emptyState()): ClusterState {
  return commands.reduce((state, command) => apply(state, command, 3), from)
}

describe("apply", () => {
  test("is pure: the input is never mutated and the same input gives the same output", () => {
    const before = run([
      { type: "addNode", node: "n1", advertise: "ws://a:4321", zone: "eu" },
      { type: "placeDb", db: "acme", primary: "n1", replicas: ["n2"] },
    ])
    const frozen = JSON.stringify(before)
    const once = apply(before, { type: "grantLease", db: "acme", node: "n1", until: 5000 })
    const twice = apply(before, { type: "grantLease", db: "acme", node: "n1", until: 5000 })
    expect(JSON.stringify(before)).toBe(frozen)
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice))
  })

  test("records a node and its zone", () => {
    const state = run([{ type: "addNode", node: "n1", advertise: "ws://a:4321", zone: "eu-1" }])
    expect(state.nodes.n1).toEqual({
      advertise: "ws://a:4321",
      zone: "eu-1",
      joinedTerm: 3,
      status: "voter",
    })
    expect(state.term).toBe(3)
  })

  test("removing a node touches membership and nothing else", () => {
    const state = run([
      { type: "addNode", node: "n1" },
      { type: "addNode", node: "n2" },
      { type: "placeDb", db: "acme", primary: "n1", replicas: ["n2"] },
      { type: "grantLease", db: "acme", node: "n1", until: 5000 },
      { type: "removeNode", node: "n1" },
    ])
    expect(state.nodes.n1).toBeUndefined()
    // The lease outlives the membership on purpose: it expires on its own clock, and dropping it
    // here would be a licence to hand a live database to a second writer.
    expect(state.dbs.acme?.lease).toEqual({ node: "n1", until: 5000 })
    expect(state.dbs.acme?.primary).toBe("n1")
  })

  test("placement prunes the acks of nodes that no longer hold the database", () => {
    const state = run([
      { type: "placeDb", db: "acme", primary: "n1", replicas: ["n2", "n3"] },
      { type: "ack", db: "acme", node: "n2", txid: "40" },
      { type: "ack", db: "acme", node: "n3", txid: "41" },
      { type: "placeDb", db: "acme", primary: "n1", replicas: ["n2"] },
    ])
    expect(state.dbs.acme?.acked).toEqual({ n2: "40" })
  })

  test("an ack never goes backwards", () => {
    const state = run([
      { type: "ack", db: "acme", node: "n2", txid: "1000" },
      { type: "ack", db: "acme", node: "n2", txid: "999" },
      { type: "ack", db: "acme", node: "n2", txid: "1001" },
    ])
    expect(state.dbs.acme?.acked.n2).toBe("1001")
  })
})

describe("the epoch", () => {
  test("the first grant of an unplaced database fences nobody, so it does not bump", () => {
    const state = run([{ type: "grantLease", db: "acme", node: "n1", until: 1000 }])
    expect(state.dbs.acme?.epoch).toBe(0)
    expect(state.dbs.acme?.primary).toBe("n1")
  })

  test("bumps when the lease changes holder", () => {
    let state = run([{ type: "grantLease", db: "acme", node: "n1", until: 1000 }])
    state = apply(state, { type: "grantLease", db: "acme", node: "n2", until: 2000 })
    expect(state.dbs.acme?.epoch).toBe(1)
    expect(state.dbs.acme?.primary).toBe("n2")

    state = apply(state, { type: "grantLease", db: "acme", node: "n1", until: 3000 })
    expect(state.dbs.acme?.epoch).toBe(2)
    expect(state.dbs.acme?.primary).toBe("n1")
  })

  test("does not bump on a renewal by the node that already holds it", () => {
    let state = run([
      { type: "grantLease", db: "acme", node: "n1", until: 1000 },
      { type: "grantLease", db: "acme", node: "n2", until: 1500 },
    ])
    for (const until of [2000, 3000, 4000]) {
      state = apply(state, { type: "grantLease", db: "acme", node: "n2", until })
    }
    expect(state.dbs.acme?.epoch).toBe(1)
    expect(state.dbs.acme?.lease?.until).toBe(4000)
  })

  test("a release does not let the same node's own re-take burn an epoch", () => {
    // C2: a primary whose lease lapsed and is re-taking it has fenced nobody, so the fencing token
    // must not move — every replica of that database would otherwise re-snapshot for nothing.
    let state = run([
      { type: "grantLease", db: "acme", node: "n1", until: 1000 },
      { type: "grantLease", db: "acme", node: "n2", until: 1500 },
    ])
    expect(state.dbs.acme?.epoch).toBe(1)
    state = apply(state, { type: "releaseLease", db: "acme" })
    expect(state.dbs.acme?.lease).toBeNull()
    state = apply(state, { type: "grantLease", db: "acme", node: "n2", until: 2000 })
    expect(state.dbs.acme?.epoch).toBe(1)
    // A different node taking it after the release is a real change of hands.
    state = apply(state, { type: "releaseLease", db: "acme" })
    state = apply(state, { type: "grantLease", db: "acme", node: "n3", until: 3000 })
    expect(state.dbs.acme?.epoch).toBe(2)
  })

  test("an explicit epoch can only raise it, never lower it", () => {
    let state = run([{ type: "grantLease", db: "acme", node: "n1", until: 1000, epoch: 40 }])
    expect(state.dbs.acme?.epoch).toBe(40)
    // A tenant whose on-disk epoch is behind must not un-fence anyone.
    state = apply(state, { type: "grantLease", db: "acme", node: "n1", until: 2000, epoch: 7 })
    expect(state.dbs.acme?.epoch).toBe(40)
    state = apply(state, { type: "grantLease", db: "acme", node: "n2", until: 3000, epoch: 7 })
    expect(state.dbs.acme?.epoch).toBe(41)
  })

  test("claimDb merges one node at a time and only a primary may state the generation", () => {
    let state = run([
      { type: "claimDb", db: "acme", node: "n1", role: "primary", generation: "aaaa" },
      { type: "claimDb", db: "acme", node: "n2", role: "replica", generation: "bbbb" },
      { type: "claimDb", db: "acme", node: "n3", role: "replica" },
      { type: "claimDb", db: "acme", node: "n3", role: "replica" },
    ])
    expect(state.dbs.acme?.primary).toBe("n1")
    expect(state.dbs.acme?.replicas).toEqual(["n2", "n3"])
    // A replica that has been disconnected across a delete and a re-create still holds the old id;
    // letting it write that here would overwrite the fact promotion checks against.
    expect(state.dbs.acme?.generation).toBe("aaaa")

    // A node that says it is following is no longer the recorded primary.
    state = apply(state, { type: "claimDb", db: "acme", node: "n1", role: "replica" })
    expect(state.dbs.acme?.primary).toBeNull()
    expect(state.dbs.acme?.replicas).toEqual(["n2", "n3", "n1"])
  })

  test("is monotonic across a long run of grants", () => {
    let state = emptyState()
    let previous = 0
    for (let n = 0; n < 20; n++) {
      state = apply(state, {
        type: "grantLease",
        db: "acme",
        node: n % 3 === 0 ? "n1" : "n2",
        until: n * 1000,
      })
      const epoch = state.dbs.acme?.epoch ?? 0
      expect(epoch).toBeGreaterThanOrEqual(previous)
      previous = epoch
    }
  })
})

describe("the wire", () => {
  test("a command round-trips", () => {
    const command: Command = { type: "grantLease", db: "acme", node: "n1", until: 1234 }
    expect(decodeCommand(encodeCommand(command))).toEqual(command)
  })

  test("a snapshot round-trips, version and all", () => {
    const state = run([
      { type: "addNode", node: "n1", advertise: "ws://a:4321", zone: "eu" },
      { type: "placeDb", db: "acme", primary: "n1", replicas: ["n2"] },
      { type: "grantLease", db: "acme", node: "n1", until: 9000 },
      { type: "ack", db: "acme", node: "n2", txid: "18446744073709551615" },
    ])
    expect(decodeSnapshot(encodeSnapshot(state))).toEqual(state)
  })

  test("a snapshot from another format is detected, not misread", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ version: SNAPSHOT_VERSION + 1, state: emptyState() }),
    )
    expect(() => decodeSnapshot(bytes)).toThrow(ClusterFormatError)
    expect(() => decodeCommand(new TextEncoder().encode("{"))).toThrow(ClusterFormatError)
  })
})
