/**
 * Replication and the promotion fence.
 *
 * The property under test is not "the follower has the same rows" — it is that
 * a follower refuses writes, that a promoted node advances the epoch, and that
 * the *old* leader stops writing once it sees the epoch move. A fence only one
 * side checks is a suggestion.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileLease, promote } from "../src/bus/replication";
import { BusStore } from "../src/bus/store";

const W = "default";

test("a follower applies the log with its sequence numbers intact", async () => {
  const leader = new BusStore(":memory:");
  const replica = new BusStore(":memory:");
  leader.subscribe(W, { name: "work", pattern: "work.>", deliverFrom: "beginning" });
  for (let index = 0; index < 5; index++)
    await leader.publish(W, { subject: "work.do", body: { index } });
  // Move the cursor, so the cursor is a thing worth replicating.
  const claimed = await leader.claim(W, "work", "c1", 3);
  for (const envelope of claimed)
    await leader.ack(W, envelope.delivery.id, "c1", envelope.delivery.generation);

  replica.demote("http://leader");
  await replica.applyReplicated(await leader.log(W, 0, 100));
  replica.applyCursors(leader.subscriptions(W));

  expect(replica.lastSeq()).toBe(leader.lastSeq());
  expect((await replica.log(W, 0, 100)).map((m) => m.seq)).toEqual(
    (await leader.log(W, 0, 100)).map((m) => m.seq),
  );
  expect(replica.subscription(W, "work").cursorSeq).toBe(
    leader.subscription(W, "work").cursorSeq,
  );
  expect(replica.cluster().appliedSeq).toBe(leader.lastSeq());
  leader.close();
  replica.close();
});

test("a follower refuses writes, including claims", async () => {
  const replica = new BusStore(":memory:");
  replica.subscribe(W, { name: "work", pattern: "work.>" });
  replica.demote("http://leader");
  await expect(
    replica.publish(W, { subject: "work.do", body: 1 }),
  ).rejects.toThrow(/not accepting writes/);
  // A lease handed out by a replica is a promise the replica cannot keep.
  await expect(replica.claim(W, "work", "c1", 1)).rejects.toThrow(
    /not accepting writes/,
  );
  replica.close();
});

test("being a follower survives a restart", async () => {
  const directory = await mkdtemp(`${tmpdir()}/agenticbus-follow-`);
  try {
    const path = `${directory}/bus.db`;
    const first = new BusStore(path);
    first.demote("http://leader");
    first.close();

    // A follower that forgets it is a follower starts accepting writes its
    // upstream will overwrite.
    const reopened = new BusStore(path);
    expect(reopened.cluster().role).toBe("follower");
    await expect(
      reopened.publish(W, { subject: "work.do", body: 1 }),
    ).rejects.toThrow(/not accepting writes/);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("promotion advances the epoch, and the old leader is fenced out", async () => {
  const directory = await mkdtemp(`${tmpdir()}/agenticbus-fence-`);
  try {
    const lease = fileLease(`${directory}/lease.json`);
    const old = new BusStore(`${directory}/old.db`);
    const replica = new BusStore(`${directory}/replica.db`);
    replica.demote("http://old");

    const first = await promote(old, lease, "old");
    expect(first.epoch).toBe(1);
    expect(old.cluster().role).toBe("leader");

    const second = await promote(replica, lease, "replica");
    expect(second.epoch).toBe(2);
    expect(replica.cluster().readOnly).toBe(false);

    // The old leader's own epoch is now stale. This is what `fenceWatcher`
    // acts on; the store half is that it can be told and then refuses.
    const seen = await lease.read();
    expect(seen!.epoch).toBeGreaterThan(old.cluster().epoch);
    old.setReadOnly(true, "fenced out");
    await expect(
      old.publish(W, { subject: "work.do", body: 1 }),
    ).rejects.toThrow(/fenced out/);

    // An epoch that does not advance is refused outright, so a stale promotion
    // cannot take the role back.
    expect(() => old.promote(1)).toThrow(/does not advance/);

    old.close();
    replica.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a promoted follower re-materializes deliveries from its cursor", async () => {
  const leader = new BusStore(":memory:");
  const replica = new BusStore(":memory:");
  leader.subscribe(W, { name: "work", pattern: "work.>", deliverFrom: "beginning" });
  for (let index = 0; index < 4; index++)
    await leader.publish(W, { subject: "work.do", body: { index } });

  replica.demote("http://leader");
  await replica.applyReplicated(await leader.log(W, 0, 100));
  // Cursor at zero: nothing has been consumed on the leader either.
  replica.applyCursors(leader.subscriptions(W));
  replica.promote(1);

  // Deliveries were never replicated — leases are ephemeral and meaningless on
  // another machine — so the promoted node recreates them from the cursor,
  // through the same path a cold start uses.
  const claimed = await replica.claim(W, "work", "c1", 10);
  expect(claimed.map((envelope) => envelope.message.seq)).toEqual([1, 2, 3, 4]);
  leader.close();
  replica.close();
});

test("a follower refuses operator writes too, not just publishes", async () => {
  const replica = new BusStore(":memory:");
  replica.subscribe(W, { name: "work", pattern: "work.>" });
  await replica.publish(W, { subject: "work.do", body: 1 });
  replica.demote("http://leader");
  // A subscription created on a follower would be silently overwritten by the
  // next cursor sync, and a cancel would be undone by the next log batch.
  expect(() => replica.subscribe(W, { name: "other", pattern: "work.>" })).toThrow(
    /not accepting writes/,
  );
  expect(() => replica.cancelMessage(W, 1)).toThrow(/not accepting writes/);
  replica.close();
});
