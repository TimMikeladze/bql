/**
 * A clustered bus: three bql.sh nodes in this process, each serving the bus
 * under /bus on its own listener. The primary of database `bus` closes, a
 * survivor is promoted, and the work carries on through one multi-URL client.
 * Then ACK_TIMEOUT, with a replica that is attached and never acks.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bql } from "../../db/src/embedded.ts";
import {
  encodeJson,
  FRAME,
  FrameReader,
  makeProof,
  PROTO_VERSION,
} from "../../db/src/replication/protocol.ts";
import { busNode, type BusNode } from "../src/bus/node";
import { generateKey } from "../src/bus/tokens";
import { BusClient, BusRequestError } from "../src/client/bus";
import type { Envelope } from "../src/shared/protocol";

const SECRET = "bus-cluster-test-secret-0123456789";
const signingKey = generateKey();
const adminToken = generateKey();

interface Node {
  id: string;
  bq: Bql;
  bus: BusNode;
  url: string;
}

let open: Node[] = [];
const dirs: string[] = [];
const closers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const closer of closers.splice(0)) await closer.close().catch(() => {});
  for (const node of open.splice(0)) await stop(node);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function stop(node: Node) {
  if (node.bq.closed) return;
  await node.bus.close();
  await node.bq.close();
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/**
 * A replica that subscribes to `db` and never acks: the stalled replica of
 * packages/db's replication harness, against a served `Bql`.
 */
async function silentReplica(bq: Bql, port: number, db: string) {
  const tenant = bq.tenantOf(db);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/replication`);
  socket.binaryType = "arraybuffer";
  const reader = new FrameReader();
  // The DOM lib types `send` narrower than the frames bql.sh encodes.
  const send = (frame: unknown) => socket.send(frame as string);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      for (const frame of reader.push(event.data as ArrayBuffer)) {
        if (frame.type !== FRAME.HELLO) continue;
        const body = JSON.parse(new TextDecoder().decode(frame.body)) as Record<string, string>;
        if (body.nonce) {
          send(
            encodeJson(FRAME.HELLO, {
              proto: PROTO_VERSION,
              node: "silent",
              proof: makeProof(bq.config.replication.secret as string, body.nonce),
            }),
          );
        } else if (body.ok) {
          send(
            encodeJson(FRAME.SUBSCRIBE, {
              stream: 1,
              db,
              fromTxid: tenant.txid.toString(),
              epoch: tenant.epoch,
              checksum: tenant.checksum.toString(),
            }),
          );
          resolve();
        }
      }
    });
    socket.addEventListener("error", () => reject(new Error("no replication socket")));
  });
  await waitFor("the silent replica to attach", () => {
    try {
      bq.assertReplicas(db, "replica");
      return true;
    } catch {
      return false;
    }
  });
  return { close: async () => socket.close() };
}

/** Replica streams attached to `node` for database `bus`. */
function streaming(node: Node): number {
  return node.bq.runtime.replication?.replicasOf("bus").length ?? 0;
}

async function cluster(ids: string[]): Promise<Node[]> {
  const ports = new Map<string, number>();
  for (const id of ids) ports.set(id, await freePort());
  const advertise = (id: string) => `ws://127.0.0.1:${ports.get(id)}`;
  const nodes: Node[] = [];
  for (const id of ids) {
    const dir = mkdtempSync(join(tmpdir(), `bql-bus-cluster-${id}-`));
    dirs.push(dir);
    const bq = await Bql.open({
      dir,
      server: { port: ports.get(id)!, host: "127.0.0.1", node: id },
      replication: { secret: SECRET, heartbeatMs: 100, reconnectMs: 20 },
      cluster: {
        enabled: true,
        id,
        advertise: advertise(id),
        peers: ids.filter((peer) => peer !== id).map((peer) => `${peer}=${advertise(peer)}`),
        bootstrap: true,
        rf: ids.length,
        // The timings packages/db's cluster tests use for three nodes on one event loop.
        leaseTtlMs: 1200,
        leaseRenewMs: 300,
        leaseGuardMs: 400,
        electionTimeoutMs: 700,
        heartbeatMs: 120,
      },
      sqlite: { foreignKeys: true },
      onError: () => {},
    });
    const bus = busNode({ bq, signingKey, adminToken, ack: "replica", tickMs: 100 });
    await bq.serve({ mount: [bus.mount] });
    const node = { id, bq, bus, url: `http://127.0.0.1:${ports.get(id)}/bus` };
    open.push(node);
    nodes.push(node);
  }
  await Promise.all(nodes.map((node) => node.bus.start()));
  return nodes;
}

test(
  "the primary closes; a replica takes over with the log, the leases and the clients",
  async () => {
    const nodes = await cluster(["n1", "n2", "n3"]);
    const primary = nodes.find((node) => node.bus.role === "primary")!;
    const replicas = nodes.filter((node) => node !== primary);
    expect(primary).toBeDefined();
    expect(replicas.every((node) => node.bus.role === "replica")).toBe(true);

    // Replicas first in the list, so the first write is redirected.
    const client = new BusClient({
      url: [...replicas, primary].map((node) => node.url),
      token: adminToken,
    });
    await client.subscribe({ name: "work", pattern: "work.>", deliverFrom: "beginning" });
    expect(client.url).toBe(primary.url);

    // Placement names the replicas before their streams attach, and `replica`
    // is refused with NO_REPLICAS until one has.
    await waitFor("both replicas to stream from the primary", () => streaming(primary) === 2);
    const acked: number[] = [];
    for (let i = 0; i < 20; i++)
      acked.push((await client.publish({ subject: "work.a", body: i, ack: "replica" })).seq);

    // A replica refuses a write with the primary's bus URL, and serves reads.
    const replica = replicas[0]!;
    const refused = await fetch(`${replica.url}/api/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "work.x" }),
    });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { code: string }).code).toBe("NOT_PRIMARY");
    expect(refused.headers.get("bql-primary")).toBe(primary.url);
    const local = new BusClient({ url: replica.url, token: adminToken });
    await waitFor("the replica to have every message", async () =>
      (await local.log(0, 100)).length === 20,
    );
    expect((await local.subscriptions()).map((one) => one.name)).toEqual(["work"]);
    expect((await local.stats()).lastSeq).toBe(acked.at(-1)!);
    const health = (await (await fetch(`${replica.url}/health`)).json()) as { role: string };
    expect(health.role).toBe("replica");

    // A lease taken on the old primary, and still live when it goes.
    const [held] = (await client.claim("work", "c1", 1)) as [Envelope];
    expect(held).toBeDefined();
    // Every replica has the claim before the primary goes.
    const claimTxid = primary.bq.db("bus").txid;
    await waitFor("the replicas to apply the claim", () =>
      replicas.every((node) => node.bq.runtime.registry.open("bus").txid >= BigInt(claimTxid)),
    );

    await stop(primary);
    await waitFor("a survivor to become the bus primary", () =>
      replicas.some((node) => node.bus.role === "primary"),
    );
    const promoted = replicas.find((node) => node.bus.role === "primary")!;
    // The other survivor reconnects to the new primary a few ms after the
    // promotion; until it has, `replica` answers NO_REPLICAS, which the
    // multi-URL client waits out rather than throwing.

    // The client finds it: the closed node refuses connections, a replica redirects.
    for (let i = 20; i < 30; i++)
      acked.push((await client.publish({ subject: "work.a", body: i, ack: "replica" })).seq);
    expect(client.url).toBe(promoted.url);

    // The lease kept its generation: the old consumer's ack lands.
    const acknowledged = await client.ack(held.delivery, "c1");
    expect(acknowledged.replayed ?? false).toBe(false);

    const log = await new BusClient({ url: promoted.url, token: adminToken }).log(0, 1000);
    const seqs = new Set(log.map((message) => message.seq));
    expect(acked.filter((seq) => !seqs.has(seq))).toEqual([]);

    // Everything else is still deliverable, once.
    const processed = new Set<number>([held.message.seq]);
    while (processed.size < 30) {
      const envelopes = await client.claim("work", "c2", 50);
      if (envelopes.length === 0) break;
      for (const envelope of envelopes) {
        processed.add(envelope.message.seq);
        await client.ack(envelope.delivery, "c2");
      }
    }
    expect(processed.size).toBe(30);
  },
  120_000,
);

test("a replica that never acks: ACK_TIMEOUT with the seq, and the client does not resend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bql-bus-acktimeout-"));
  dirs.push(dir);
  const bq = await Bql.open({
    dir,
    server: { node: "primary" },
    replication: { secret: SECRET, heartbeatMs: 100, ackTimeoutMs: 200 },
    sqlite: { foreignKeys: true },
  });
  const bus = busNode({ bq, signingKey, adminToken });
  const handle = await bq.serve({ port: 0, host: "127.0.0.1", mount: [bus.mount] });
  await bus.start();
  const node: Node = { id: "primary", bq, bus, url: `http://127.0.0.1:${handle.server.port}/bus` };
  open.push(node);
  closers.push(await silentReplica(bq, handle.server.port as number, "bus"));

  // Two URLs: a retry would have somewhere to go.
  const client = new BusClient({ url: [node.url, node.url], token: adminToken });
  const error = await client
    .publish({ subject: "work.t", body: 1, ack: "replica" })
    .then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(BusRequestError);
  const failure = error as BusRequestError;
  expect(failure.status).toBe(503);
  expect(failure.code).toBe("ACK_TIMEOUT");
  expect(typeof failure.details.seq).toBe("number");
  expect(failure.details.needed).toBe(1);

  // Committed once, not resent.
  const log = await client.log(0, 10, { subject: "work.t" });
  expect(log.map((message) => message.seq)).toEqual([failure.details.seq as number]);

  // A publish at fsync does not wait for the replica.
  const local = await client.publish({ subject: "work.t", body: 2, ack: "fsync" });
  expect(local.seq).toBeGreaterThan(failure.details.seq as number);
});

test("a request cut off mid-flight is resent only when it carries a dedupeKey", async () => {
  const seen: string[] = [];
  let calls = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    seen.push(String(url));
    // The first attempt dies after the request went out; the second works.
    if (calls++ % 2 === 0)
      throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    return Response.json({ seq: 7, duplicate: false }, { status: 201 });
  }) as typeof fetch;
  const client = new BusClient({
    url: ["http://a.invalid", "http://b.invalid"],
    token: "t",
    fetchImpl,
  });

  await expect(client.publish({ subject: "x" })).rejects.toThrow("socket closed");
  expect(seen).toEqual(["http://a.invalid/api/publish"]);

  seen.length = 0;
  calls = 0;
  const result = await client.publish({ subject: "x", dedupeKey: "k1" });
  expect(result.seq).toBe(7);
  expect(seen).toEqual(["http://a.invalid/api/publish", "http://b.invalid/api/publish"]);
});

test("a single-URL client waits out NO_REPLICAS, bounded by failoverMs", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    // The node was just promoted and its replicas have not followed yet.
    if (calls++ < 3)
      return Response.json(
        { error: "no replica", code: "NO_REPLICAS", acks: 0, needed: 1 },
        { status: 503 },
      );
    return Response.json({ seq: 9, duplicate: false }, { status: 201 });
  }) as unknown as typeof fetch;
  const client = new BusClient({ url: "http://a.invalid", token: "t", fetchImpl });
  expect((await client.publish({ subject: "x", ack: "replica" })).seq).toBe(9);
  expect(calls).toBe(4);

  // With nothing ever following, the answer comes back once failoverMs is spent.
  calls = -1_000;
  const impatient = new BusClient({
    url: "http://a.invalid",
    token: "t",
    fetchImpl,
    failoverMs: 100,
  });
  const started = Date.now();
  await expect(impatient.publish({ subject: "x", ack: "replica" })).rejects.toMatchObject({
    code: "NO_REPLICAS",
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
});
