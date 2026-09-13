/**
 * Revocation, key rotation, rate limits, quotas and the audit trail.
 *
 * Each of these is the answer to a question that only gets asked once
 * something has gone wrong, which is exactly why they need tests that do not
 * depend on anything having gone wrong.
 */
import { expect, test } from "bun:test";
import { gate, tokenBucket } from "../src/bus/limits";
import { createServer } from "../src/bus/server";
import { BusStore } from "../src/bus/store";
import {
  generateKey,
  keyring,
  mint,

  verify,
} from "../src/bus/tokens";
import { BusClient, BusRequestError } from "../src/client/bus";
import type { TokenClaims } from "../src/shared/protocol";

const W = "default";
const claims = (over: Partial<TokenClaims> = {}): TokenClaims => ({
  sub: "worker-1",
  scope: "consumer",
  workspace: W,
  publish: ["work.>"],
  subscribe: ["work"],
  exp: 0,
  ...over,
});

// --------------------------------------------------------- key rotation

test("a rotated key verifies old tokens until the old key is retired", () => {
  const k1 = generateKey();
  const k2 = generateKey();
  const before = keyring({ k1 }, "k1");
  const token = mint(claims(), before);

  // Both keys live: this is the overlap window, and without it rotating would
  // invalidate every token in the fleet at the same instant.
  const during = keyring({ k1, k2 }, "k2");
  expect(verify(token, during).sub).toBe("worker-1");
  // A token minted now carries the new key id.
  expect(verify(mint(claims(), during), during).kid).toBe("k2");

  const after = keyring({ k2 }, "k2");
  expect(() => verify(token, after)).toThrow(/retired/);
});

// ----------------------------------------------------------- revocation

test("a revoked token is refused, and the revocation expires with it", async () => {
  const store = new BusStore(":memory:");
  const signingKey = generateKey();
  const adminToken = generateKey();
  const server = createServer({
    store,
    signingKey,
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
  });
  const url = `http://127.0.0.1:${server.port}`;
  const admin = new BusClient({ url, token: adminToken });
  await admin.subscribe({ name: "work", pattern: "work.>" });

  const issued = await admin.call<{ token: string; claims: TokenClaims }>(
    "/api/tokens",
    { consumer: "worker-1", publish: ["work.>"], subscribe: ["work"] },
  );
  const worker = new BusClient({ url, token: issued.token });
  expect((await worker.publish({ subject: "work.a", body: 1 })).seq).toBe(1);

  const jti = verify(issued.token, signingKey).jti!;
  await admin.revokeToken(jti);
  await expect(worker.publish({ subject: "work.a", body: 2 })).rejects.toThrow(
    /revoked/,
  );

  // The list is not allowed to grow forever: a revocation whose token has
  // already expired is dead weight, and the sweep drops the row.
  store.revoke("live-jti", Date.now() + 60_000);
  store.revoke("expired-jti", Date.now() - 1);
  expect(store.isRevoked("live-jti")).toBe(true);
  expect(store.isRevoked("expired-jti")).toBe(false);
  store.sweep();
  expect(new Set(store.revocations().map((entry) => entry.jti))).toEqual(
    new Set(["live-jti", jti]),
  );

  server.stop(true);
  store.close();
});

// ---------------------------------------------------------- rate limits

test("a token bucket refills over time and says how long to wait", () => {
  let now = 0;
  const bucket = tokenBucket({ perSecond: 10, burst: 2 }, () => now);
  expect(bucket.take("a").ok).toBe(true);
  expect(bucket.take("a").ok).toBe(true);
  const refused = bucket.take("a");
  expect(refused.ok).toBe(false);
  expect(refused.retryAfterMs).toBeGreaterThan(0);
  // A different credential has its own bucket.
  expect(bucket.take("b").ok).toBe(true);
  now += 200;
  expect(bucket.take("a").ok).toBe(true);
  // Buckets nobody touches are dropped, so an unbounded key space cannot leak.
  now += 10 * 60_000;
  bucket.sweep();
  expect(bucket.size()).toBe(0);
});

test("publishing over the limit answers 429 with Retry-After", async () => {
  const store = new BusStore(":memory:");
  const adminToken = generateKey();
  const signingKey = generateKey();
  const server = createServer({
    store,
    signingKey,
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
    publishRate: { perSecond: 1, burst: 1 },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const worker = new BusClient({
    url,
    token: mint(claims({ publish: ["work.>"] }), signingKey),
  });
  expect((await worker.publish({ subject: "work.a", body: 1 })).seq).toBe(1);

  const response = await fetch(`${url}/api/publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mint(claims({ publish: ["work.>"] }), signingKey)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ subject: "work.a", body: 2 }),
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).not.toBeNull();
  server.stop(true);
  store.close();
});

test("a gate caps concurrent holders per key", () => {
  const polls = gate(2);
  expect(polls.enter("a")).toBe(true);
  expect(polls.enter("a")).toBe(true);
  expect(polls.enter("a")).toBe(false);
  expect(polls.enter("b")).toBe(true);
  polls.leave("a");
  expect(polls.enter("a")).toBe(true);
});

// --------------------------------------------------------------- quotas

test("a workspace over its quota is refused, and other workspaces are not", async () => {
  const store = new BusStore(":memory:");
  store.setQuota("tight", { maxMessages: 2 });
  await store.publish("tight", { subject: "work.a", body: 1 });
  await store.publish("tight", { subject: "work.a", body: 2 });
  await expect(
    store.publish("tight", { subject: "work.a", body: 3 }),
  ).rejects.toThrow(/message quota/);
  // One tenant's ceiling is not every tenant's.
  expect((await store.publish("roomy", { subject: "work.a", body: 1 })).seq).toBeGreaterThan(0);

  store.setQuota("tight", { maxMessages: 0, maxSubscriptions: 1 });
  store.subscribe("tight", { name: "one", pattern: "work.>" });
  expect(() =>
    store.subscribe("tight", { name: "two", pattern: "work.>" }),
  ).toThrow(/subscription quota/);
  store.close();
});

// ----------------------------------------------------------- audit trail

test("operator actions are recorded against the token that took them", async () => {
  const store = new BusStore(":memory:");
  const adminToken = generateKey();
  const server = createServer({
    store,
    signingKey: generateKey(),
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
  });
  const url = `http://127.0.0.1:${server.port}`;
  const admin = new BusClient({ url, token: adminToken });
  await admin.subscribe({ name: "work", pattern: "work.>" });
  await admin.pause("work", true);
  await admin.purge("work");

  const entries = await admin.auditLog();
  expect(entries.map((entry) => entry.action)).toEqual([
    "subscription.purge",
    "subscription.pause",
  ]);
  expect(entries[0]!.target).toBe("work");
  expect(entries[0]!.scope).toBe("admin");
  server.stop(true);
  store.close();
});

test("a consumer token cannot reach another workspace's audit trail", async () => {
  const store = new BusStore(":memory:");
  const signingKey = generateKey();
  const adminToken = generateKey();
  const server = createServer({
    store,
    signingKey,
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
  });
  const url = `http://127.0.0.1:${server.port}`;
  const reader = new BusClient({
    url,
    token: mint(claims({ scope: "reader", workspace: "theirs" }), signingKey),
    // A pinned token that names someone else's workspace is refused outright.
    workspace: "ours",
  });
  await expect(reader.auditLog()).rejects.toThrow(BusRequestError);
  server.stop(true);
  store.close();
});
