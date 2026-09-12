// The algorithm on its own. Every test here drives `step()` directly on a virtual clock: no
// timers, no sockets, no files, and every random number from a seeded PRNG, so a failure is
// reproducible from the seed it prints.
//
// The bulk of the coverage is the simulator in `sim.ts`, which asserts the five safety properties
// of figure 3 after every single delivery. The named tests below are for the things a random walk
// would only find by luck: the pre-vote rule, the conflict optimisation, the own-term commit rule,
// and the one-membership-change-at-a-time rule.

import { describe, expect, test } from "bun:test"
import {
  encodeConfigChange,
  type LogEntry,
  Raft,
  type RaftAction,
  type RaftMessage,
} from "../../src/cluster/raft.ts"
import { encodeCommand, type Command } from "../../src/cluster/state.ts"
import { prng, Simulator } from "./sim.ts"

/** Fixed, so a failure in CI is a failure anyone can reproduce. */
const SEEDS = [1, 7, 42, 1337, 90210]

function ack(n: number): Command {
  return { type: "ack", db: "acme", node: "n1", txid: String(n) }
}

function entry(index: number, term: number): LogEntry {
  return { index, term, kind: "command", data: encodeCommand(ack(index)) }
}

function sends(actions: RaftAction[]): Extract<RaftAction, { type: "send" }>[] {
  return actions.filter((action) => action.type === "send") as Extract<
    RaftAction,
    { type: "send" }
  >[]
}

function only<T extends RaftMessage["type"]>(
  actions: RaftAction[],
  type: T,
): Extract<RaftMessage, { type: T }>[] {
  return sends(actions)
    .map((action) => action.message)
    .filter((message): message is Extract<RaftMessage, { type: T }> => message.type === type)
}

describe("the simulator", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: five nodes, a lossy network, a partition and a restart`, () => {
      const sim = new Simulator({
        seed,
        nodes: ["n1", "n2", "n3", "n4", "n5"],
        drop: 0.05,
        duplicate: 0.05,
        minDelayMs: 1,
        maxDelayMs: 30,
        electionTimeoutMs: 400,
        heartbeatMs: 80,
      })

      sim.campaign("n1")
      sim.runUntil(() => sim.leader() !== null, 10_000, "a leader")

      // Ordinary running.
      const first = sim.leader()
      expect(first).not.toBeNull()
      for (let n = 1; n <= 5; n++) sim.propose((first as { id: string }).id, ack(n))
      sim.advance(2000)

      // Cut the leader off from the majority and let the majority carry on without it.
      const isolated = (sim.leader() ?? first) as { id: string }
      const rest = sim.ids.filter((id) => id !== isolated.id)
      sim.partition([isolated.id], rest)
      sim.runUntil(
        () => sim.leaders().some((node) => node.id !== isolated.id),
        20_000,
        "a new leader on the majority side",
      )

      const second = sim.leaders().find((node) => node.id !== isolated.id)
      expect(second).toBeDefined()
      for (let n = 6; n <= 10; n++) sim.propose((second as { id: string }).id, ack(n))
      sim.advance(3000)

      // Heal, restart a follower from its disk, and let everything settle.
      sim.heal()
      sim.advance(3000)
      const victim = rest.find((id) => id !== (second as { id: string }).id) as string
      sim.stop(victim)
      sim.advance(1000)
      sim.restart(victim)

      // Liveness: a healed cluster elects a leader and commits again.
      sim.runUntil(() => sim.leaders().length >= 1, 20_000, "a leader after healing")
      const third = sim.leader() as { id: string }
      const id = sim.propose(third.id, ack(99))
      sim.runUntil(() => sim.outcomeOf(id)?.ok === true, 20_000, "the last proposal committing")
      expect(sim.outcomeOf(id)?.ok).toBe(true)

      // Every live node ends up with the same log prefix; log matching has been asserted on every
      // delivery, so this is only a readable end-state check.
      const logs = sim.logs()
      const lengths = Object.values(logs).map((log) => log.length)
      const shortest = Math.min(...lengths)
      for (const log of Object.values(logs)) {
        expect(log.slice(0, shortest)).toEqual((logs.n1 as string[]).slice(0, shortest))
      }
    })
  }

  test("a three-node cluster commits through a leader that keeps dying", () => {
    const sim = new Simulator({
      seed: 20260912,
      nodes: ["a", "b", "c"],
      drop: 0.02,
      minDelayMs: 1,
      maxDelayMs: 15,
      electionTimeoutMs: 300,
      heartbeatMs: 60,
    })
    sim.campaign("a")
    sim.runUntil(() => sim.leader() !== null, 5000, "a first leader")

    for (let round = 0; round < 3; round++) {
      const leader = sim.leader()
      if (!leader) {
        sim.runUntil(() => sim.leader() !== null, 10_000, "a leader")
        continue
      }
      const id = sim.propose(leader.id, ack(round))
      sim.runUntil(() => sim.outcomeOf(id) !== null, 10_000, `proposal ${round} settling`)
      sim.stop(leader.id)
      sim.runUntil(
        () => sim.leaders().some((node) => node.id !== leader.id),
        20_000,
        "a replacement leader",
      )
      sim.restart(leader.id)
      sim.advance(1000)
    }
  })
})

describe("elections", () => {
  test("a single-node cluster elects itself and commits with a quorum of one", () => {
    const raft = new Raft({ id: "solo", config: ["solo"], random: prng(1) })
    const actions = raft.step({ type: "campaign" }, 0)
    expect(raft.role).toBe("leader")
    expect(raft.term).toBe(1)
    // The no-op of §5.4.2 is appended and, with a quorum of one, committed in the same step.
    expect(raft.commitIndex).toBe(1)
    const applied = actions.filter((action) => action.type === "apply")
    expect(applied).toHaveLength(1)

    const id = 7
    raft.step({ type: "propose", id, command: { kind: "command", data: encodeCommand(ack(1)) } }, 1)
    expect(raft.commitIndex).toBe(2)
  })

  test("persist comes before send in every batch", () => {
    const raft = new Raft({ id: "a", config: ["a", "b", "c"], preVote: false, random: prng(3) })
    const actions = raft.step({ type: "campaign" }, 0)
    const firstSend = actions.findIndex((action) => action.type === "send")
    const lastPersist = actions.map((action) => action.type).lastIndexOf("persist")
    expect(lastPersist).toBeGreaterThanOrEqual(0)
    expect(firstSend).toBeGreaterThan(lastPersist)
    // And the thing being persisted is the term the vote request carries.
    const persisted = actions.find((action) => action.type === "persist")
    expect(persisted).toMatchObject({ hardState: { term: 1, votedFor: "a" } })
    expect(only(actions, "requestVote")[0]?.term).toBe(1)
  })

  test("a node only votes once in a term", () => {
    const raft = new Raft({ id: "b", config: ["a", "b", "c"], random: prng(5) })
    const grant = raft.step(
      {
        type: "message",
        from: "a",
        message: { type: "requestVote", term: 1, lastLogIndex: 0, lastLogTerm: 0 },
      },
      0,
    )
    expect(only(grant, "requestVoteResp")[0]?.granted).toBe(true)
    const refuse = raft.step(
      {
        type: "message",
        from: "c",
        message: { type: "requestVote", term: 1, lastLogIndex: 0, lastLogTerm: 0 },
      },
      1,
    )
    expect(only(refuse, "requestVoteResp")[0]?.granted).toBe(false)
  })

  test("a stale log cannot win an election", () => {
    const raft = new Raft({
      id: "b",
      config: ["a", "b", "c"],
      entries: [entry(1, 5), entry(2, 5)],
      hardState: { term: 5, votedFor: null },
      random: prng(9),
    })
    const actions = raft.step(
      {
        type: "message",
        from: "a",
        message: { type: "requestVote", term: 6, lastLogIndex: 1, lastLogTerm: 5 },
      },
      0,
    )
    expect(only(actions, "requestVoteResp")[0]?.granted).toBe(false)
  })
})

describe("pre-vote", () => {
  test("a returning partitioned node does not disturb a healthy leader", () => {
    const sim = new Simulator({
      seed: 4242,
      nodes: ["a", "b", "c"],
      minDelayMs: 1,
      maxDelayMs: 5,
      electionTimeoutMs: 300,
      heartbeatMs: 60,
    })
    sim.campaign("a")
    sim.runUntil(() => sim.leader()?.id === "a", 5000, "a as leader")
    const term = sim.node("a").raft.term

    sim.partition(["c"], ["a", "b"])
    sim.advance(5000)
    // `c` has been campaigning into the void for sixteen election timeouts and has not moved its
    // own term once, because a pre-vote never does.
    expect(sim.node("c").raft.term).toBe(term)

    sim.heal()
    sim.advance(2000)
    expect(sim.node("a").raft.role).toBe("leader")
    expect(sim.node("a").raft.term).toBe(term)
  })

  test("without it, the same node deposes the leader on its way back", () => {
    const sim = new Simulator({
      seed: 4242,
      nodes: ["a", "b", "c"],
      minDelayMs: 1,
      maxDelayMs: 5,
      electionTimeoutMs: 300,
      heartbeatMs: 60,
      preVote: false,
    })
    sim.campaign("a")
    sim.runUntil(() => sim.leader()?.id === "a", 5000, "a as leader")
    const term = sim.node("a").raft.term

    sim.partition(["c"], ["a", "b"])
    sim.advance(5000)
    expect(sim.node("c").raft.term).toBeGreaterThan(term)

    sim.heal()
    sim.advance(2000)
    expect(sim.node("a").raft.term).toBeGreaterThan(term)
  })
})

describe("log replication", () => {
  test("a rejection names the first index of the conflicting term", () => {
    // The follower holds terms 1,1,2,2,2 and the leader is asking about index 5 in term 4.
    const follower = new Raft({
      id: "f",
      config: ["l", "f"],
      hardState: { term: 4, votedFor: null },
      entries: [entry(1, 1), entry(2, 1), entry(3, 2), entry(4, 2), entry(5, 2)],
      random: prng(11),
    })
    const actions = follower.step(
      {
        type: "message",
        from: "l",
        message: {
          type: "appendEntries",
          term: 4,
          prevLogIndex: 5,
          prevLogTerm: 4,
          entries: [],
          leaderCommit: 0,
        },
      },
      0,
    )
    const response = only(actions, "appendEntriesResp")[0]
    expect(response?.success).toBe(false)
    expect(response?.conflictTerm).toBe(2)
    // Term 2 starts at index 3, so one round trip takes the leader back past all three of them.
    expect(response?.conflictIndex).toBe(3)
  })

  test("a short log reports where it actually ends", () => {
    const follower = new Raft({
      id: "f",
      config: ["l", "f"],
      hardState: { term: 3, votedFor: null },
      entries: [entry(1, 1)],
      random: prng(12),
    })
    const actions = follower.step(
      {
        type: "message",
        from: "l",
        message: {
          type: "appendEntries",
          term: 3,
          prevLogIndex: 9,
          prevLogTerm: 3,
          entries: [],
          leaderCommit: 0,
        },
      },
      0,
    )
    const response = only(actions, "appendEntriesResp")[0]
    expect(response?.success).toBe(false)
    expect(response?.conflictIndex).toBe(2)
    expect(response?.conflictTerm).toBe(0)
  })

  test("a conflicting suffix is truncated and replaced", () => {
    const follower = new Raft({
      id: "f",
      config: ["l", "f"],
      hardState: { term: 4, votedFor: null },
      entries: [entry(1, 1), entry(2, 2), entry(3, 2)],
      random: prng(13),
    })
    const replacement: LogEntry = { index: 2, term: 4, kind: "command", data: encodeCommand(ack(77)) }
    const actions = follower.step(
      {
        type: "message",
        from: "l",
        message: {
          type: "appendEntries",
          term: 4,
          prevLogIndex: 1,
          prevLogTerm: 1,
          entries: [replacement],
          leaderCommit: 0,
        },
      },
      0,
    )
    const persisted = actions.find((action) => action.type === "persist")
    expect(persisted).toMatchObject({ truncateFrom: 2 })
    expect(follower.lastIndex).toBe(2)
    expect(only(actions, "appendEntriesResp")[0]?.success).toBe(true)
  })

  test("a leader never commits an entry of an earlier term by counting replicas", () => {
    // `a` inherits one uncommitted entry from term 1 and wins term 2 with it.
    const raft = new Raft({
      id: "a",
      config: ["a", "b", "c"],
      preVote: false,
      hardState: { term: 1, votedFor: null },
      entries: [entry(1, 1)],
      random: prng(17),
    })
    raft.step({ type: "campaign" }, 0)
    raft.step(
      { type: "message", from: "b", message: { type: "requestVoteResp", term: 2, granted: true } },
      1,
    )
    expect(raft.role).toBe("leader")
    expect(raft.lastIndex).toBe(2) // the inherited entry, then the no-op

    // `b` acknowledges only the inherited entry. A quorum holds index 1 — and it stays uncommitted,
    // which is the figure-8 rule.
    raft.step(
      {
        type: "message",
        from: "b",
        message: { type: "appendEntriesResp", term: 2, success: true, matchIndex: 1 },
      },
      2,
    )
    expect(raft.commitIndex).toBe(0)

    // The moment the no-op — an entry of the leader's own term — is acknowledged, both commit.
    raft.step(
      {
        type: "message",
        from: "b",
        message: { type: "appendEntriesResp", term: 2, success: true, matchIndex: 2 },
      },
      3,
    )
    expect(raft.commitIndex).toBe(2)
  })
})

describe("snapshots", () => {
  test("the log is compacted once it passes snapshotEntries", () => {
    const raft = new Raft({ id: "solo", config: ["solo"], snapshotEntries: 4, random: prng(19) })
    raft.step({ type: "campaign" }, 0)
    let compactions = 0
    for (let n = 1; n <= 12; n++) {
      const actions = raft.step(
        { type: "propose", id: n, command: { kind: "command", data: encodeCommand(ack(n)) } },
        n,
      )
      for (const action of actions) {
        if (action.type !== "snapshot" || action.reason !== "compact") continue
        compactions += 1
        raft.compact(action.index, action.term, new Uint8Array([1, 2, 3]))
      }
    }
    expect(compactions).toBeGreaterThan(0)
    expect(raft.entries.length).toBeLessThanOrEqual(4)
    expect(raft.snapshot?.config).toEqual(["solo"])
  })

  test("a follower too far behind is caught up with a snapshot, not with entries", () => {
    const sim = new Simulator({
      seed: 555,
      nodes: ["a", "b", "c"],
      minDelayMs: 1,
      maxDelayMs: 5,
      electionTimeoutMs: 300,
      heartbeatMs: 60,
      snapshotEntries: 8,
    })
    sim.campaign("a")
    sim.runUntil(() => sim.leader()?.id === "a", 5000, "a as leader")

    sim.stop("c")
    for (let n = 1; n <= 60; n++) sim.propose("a", ack(n))
    sim.advance(4000)
    expect(sim.node("a").raft.snapshotIndex).toBeGreaterThan(0)

    sim.restart("c")
    sim.runUntil(
      () => sim.node("c").raft.snapshotIndex > 0,
      20_000,
      "c catching up through a snapshot",
    )
    expect(sim.node("c").raft.commitIndex).toBeGreaterThanOrEqual(sim.node("c").raft.snapshotIndex)
  })
})

describe("membership", () => {
  test("one server at a time, and a second change is refused while one is in flight", () => {
    const raft = new Raft({ id: "n1", config: ["n1"], random: prng(23) })
    raft.step({ type: "campaign" }, 0)
    expect(raft.commitIndex).toBe(1)

    const added = raft.step(
      { type: "propose", id: "add-n2", command: { kind: "config", change: { type: "add", node: "n2" } } },
      1,
    )
    expect(added.filter((action) => action.type === "proposalResult")).toHaveLength(0)
    // A configuration takes effect when it is appended: the quorum is already 2, so the entry
    // cannot commit until `n2` answers.
    expect(raft.config.sort()).toEqual(["n1", "n2"])
    expect(raft.commitIndex).toBe(1)

    const refused = raft.step(
      { type: "propose", id: "add-n3", command: { kind: "config", change: { type: "add", node: "n3" } } },
      2,
    )
    const result = refused.find((action) => action.type === "proposalResult")
    expect(result).toMatchObject({ id: "add-n3", ok: false })
    expect((result as { reason: string }).reason).toContain("already in flight")

    // Once `n2` acknowledges, the change commits and the next one is allowed.
    const committed = raft.step(
      {
        type: "message",
        from: "n2",
        message: { type: "appendEntriesResp", term: 1, success: true, matchIndex: 2 },
      },
      3,
    )
    expect(committed.find((action) => action.type === "proposalResult")).toMatchObject({
      id: "add-n2",
      ok: true,
    })
    const third = raft.step(
      { type: "propose", id: "add-n3b", command: { kind: "config", change: { type: "add", node: "n3" } } },
      4,
    )
    expect(third.filter((action) => action.type === "proposalResult")).toHaveLength(0)
  })

  test("a learner is replicated to but never counted in a quorum", () => {
    const raft = new Raft({ id: "n1", config: ["n1"], random: prng(29) })
    raft.step({ type: "campaign" }, 0)
    raft.step(
      {
        type: "propose",
        id: 1,
        command: { kind: "config", change: { type: "add", node: "r1", status: "learner" } },
      },
      1,
    )
    expect(raft.config).toEqual(["n1"])
    expect(raft.learners).toEqual(["r1"])
    // Quorum is still one, so the change commits on its own.
    expect(raft.commitIndex).toBe(2)
    // And it is still sent entries.
    const actions = raft.step({ type: "tick" }, 1000)
    expect(only(actions, "appendEntries").length).toBeGreaterThan(0)
  })

  test("a config change decodes back to what was proposed", () => {
    const bytes = encodeConfigChange({ type: "add", node: "n7", advertise: "ws://n7:4321", zone: "b" })
    const raft = new Raft({
      id: "n1",
      config: ["n1"],
      entries: [{ index: 1, term: 1, kind: "config", data: bytes }],
      hardState: { term: 1, votedFor: null },
      random: prng(31),
    })
    expect(raft.config.sort()).toEqual(["n1", "n7"])
  })
})

describe("proposals", () => {
  test("a follower refuses a proposal and says who to ask", () => {
    const raft = new Raft({ id: "b", config: ["a", "b", "c"], random: prng(37) })
    raft.step(
      {
        type: "message",
        from: "a",
        message: {
          type: "appendEntries",
          term: 3,
          prevLogIndex: 0,
          prevLogTerm: 0,
          entries: [],
          leaderCommit: 0,
        },
      },
      0,
    )
    const actions = raft.step(
      { type: "propose", id: 1, command: { kind: "command", data: encodeCommand(ack(1)) } },
      1,
    )
    const result = actions.find((action) => action.type === "proposalResult")
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toContain("the leader is a")
  })

  test("a leader that loses its term fails everything it had in flight", () => {
    const raft = new Raft({ id: "a", config: ["a", "b", "c"], preVote: false, random: prng(41) })
    raft.step({ type: "campaign" }, 0)
    raft.step(
      { type: "message", from: "b", message: { type: "requestVoteResp", term: 1, granted: true } },
      1,
    )
    expect(raft.role).toBe("leader")
    raft.step(
      { type: "propose", id: "doomed", command: { kind: "command", data: encodeCommand(ack(1)) } },
      2,
    )
    const deposed = raft.step(
      {
        type: "message",
        from: "c",
        message: {
          type: "appendEntries",
          term: 9,
          prevLogIndex: 0,
          prevLogTerm: 0,
          entries: [],
          leaderCommit: 0,
        },
      },
      3,
    )
    expect(deposed.find((action) => action.type === "proposalResult")).toMatchObject({
      id: "doomed",
      ok: false,
    })
  })
})
