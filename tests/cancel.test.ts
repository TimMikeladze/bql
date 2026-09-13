import { afterAll, expect, test } from "bun:test";
import { createServer } from "../src/bus/server";
import { BusStore } from "../src/bus/store";
import { generateKey, mint } from "../src/bus/tokens";
import { BusClient, BusRequestError } from "../src/client/bus";

const signingKey = generateKey();
const adminToken = generateKey();
const store = new BusStore(":memory:");
const server = createServer({
  store,
  signingKey,
  adminToken,
  port: 0,
  hostname: "127.0.0.1",
});
const url = `http://127.0.0.1:${server.port}`;

const admin = new BusClient({ url, token: adminToken });
const tokenFor = (sub: string) =>
  mint(
    {
      sub,
      scope: "consumer",
      workspace: "default",
      publish: ["jobs.>"],
      subscribe: ["jobs", "audit"],
      exp: 0,
    },
    signingKey,
  );
const alice = new BusClient({ url, token: tokenFor("alice") });
const mallory = new BusClient({ url, token: tokenFor("mallory") });

afterAll(() => {
  server.stop(true);
  store.close();
});

test("a leased delivery is cancelled, and the consumer learns on its next extend", async () => {
  await admin.subscribe({ name: "jobs", pattern: "jobs.>", ackWaitMs: 30_000 });
  const published = await alice.publish({
    subject: "jobs.long",
    body: { ms: 60_000 },
  });

  const [envelope] = await alice.claim("jobs", "alice", 1);
  expect(envelope).toBeDefined();
  expect((await alice.extend(envelope!.delivery, "alice")).cancelled).toBe(false);

  const result = await alice.cancelMessage(published.seq);
  expect(result.cancelled).toBe(1);

  const renewed = await alice.extend(envelope!.delivery, "alice");
  expect(renewed.cancelled).toBe(true);
  expect(renewed.leaseUntil).toBeNull();

  // Terminal: it is not handed to anyone else, ever.
  expect(await alice.claim("jobs", "alice", 5)).toHaveLength(0);
  const stats = await admin.stats();
  const jobs = stats.subscriptions.find((s) => s.name === "jobs")!;
  expect(jobs.cancelled).toBe(1);
  expect(jobs.pending).toBe(0);
  expect(jobs.leased).toBe(0);
});

test("cancelling before anyone has claimed stops the delivery being created at all", async () => {
  const published = await alice.publish({
    subject: "jobs.never",
    body: { skip: true },
  });
  await alice.cancelMessage(published.seq);

  const claimed = await alice.claim("jobs", "alice", 5);
  expect(claimed).toHaveLength(0);

  // The cursor still moved past it: a cancelled message must not stall the
  // subscription behind it.
  const later = await alice.publish({ subject: "jobs.next", body: { ok: true } });
  const after = await alice.claim("jobs", "alice", 5);
  expect(after).toHaveLength(1);
  expect(after[0]!.message.seq).toBe(later.seq);
  await alice.ack(after[0]!.delivery, "alice");
});

test("cancelling one delivery leaves the other subscriptions alone", async () => {
  await admin.subscribe({ name: "audit", pattern: "jobs.>", ackWaitMs: 30_000 });
  const published = await alice.publish({ subject: "jobs.fanout", body: 1 });

  const [forJobs] = await alice.claim("jobs", "alice", 1);
  expect(forJobs!.message.seq).toBe(published.seq);
  await alice.cancelDelivery(forJobs!.delivery.id);

  const [forAudit] = await alice.claim("audit", "alice", 1);
  expect(forAudit!.message.seq).toBe(published.seq);
  await alice.ack(forAudit!.delivery, "alice");
});

test("only the publisher or an admin may cancel", async () => {
  const published = await alice.publish({ subject: "jobs.mine", body: 1 });

  await expect(mallory.cancelMessage(published.seq)).rejects.toThrow(
    /only the publisher/,
  );
  // …and the message is still live for a consumer to take.
  const claimed = await alice.claim("jobs", "alice", 5);
  expect(claimed.some((e) => e.message.seq === published.seq)).toBe(true);
  for (const envelope of claimed) await alice.ack(envelope.delivery, "alice");

  // An admin token may cancel anything, including work it did not publish.
  const other = await alice.publish({ subject: "jobs.theirs", body: 2 });
  expect((await admin.cancelMessage(other.seq)).cancelled).toBeGreaterThanOrEqual(
    0,
  );
  expect(store.messageMeta("default", other.seq).cancelledAt).not.toBeNull();
});

test("cancelling twice is not an error, and reports that it was already cancelled", async () => {
  const published = await alice.publish({ subject: "jobs.twice", body: 1 });
  const first = await alice.cancelMessage(published.seq);
  expect(first.alreadyCancelled).toBe(false);
  const second = await alice.cancelMessage(published.seq);
  expect(second.alreadyCancelled).toBe(true);
  expect(second.cancelled).toBe(0);
});

test("cancelling a message nobody published is a 404, not a silent success", async () => {
  await expect(alice.cancelMessage(999_999)).rejects.toMatchObject({
    status: 404,
  } satisfies Partial<BusRequestError>);
});

test("a consumer token minted as '*' cannot cancel what an admin published", async () => {
  // `*` is the subject an admin token publishes under, so a non-admin token
  // minted with that subject would otherwise match every admin-published
  // message and inherit the right to cancel it.
  const wildcard = new BusClient({
    url,
    token: mint(
      {
        sub: "*",
        scope: "consumer",
        workspace: "default",
        publish: ["jobs.>"],
        subscribe: ["jobs"],
        exp: 0,
      },
      signingKey,
    ),
  });
  const byAdmin = await admin.publish({ subject: "jobs.admin", body: 1 });
  expect(store.messageMeta("default", byAdmin.seq).publisher).toBe("*");

  await expect(wildcard.cancelMessage(byAdmin.seq)).rejects.toThrow(
    /only the publisher/,
  );
  expect(store.messageMeta("default", byAdmin.seq).cancelledAt).toBeNull();
});
