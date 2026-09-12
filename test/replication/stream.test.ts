// The test bar of `docs/plan-phase1.md`: a write is visible on the replica, an empty replica
// bootstraps by snapshot, a dropped socket resumes with no gap and no duplicate, a retention gap
// and a checksum divergence each force a re-snapshot, a replica claiming a newer epoch is refused,
// writes on a replica are refused, a restarted replica resumes from its persisted position, and a
// chain of three nodes carries records to the end.
//
// Everything here polls with a deadline rather than sleeping for a fixed time: the assertions say
// what has to become true, and the only thing a slow machine costs is the time it takes.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HEADERS } from "../../src/client/protocol.ts"
import {
  createDb,
  query,
  startCluster,
  startPrimary,
  startReplica,
  stopAll,
  until,
  untilFollowing,
  untilSynced,
  untilTxid,
  type Cluster,
  type Node,
} from "./harness.ts"

const SCHEMA = "create table t (id integer primary key, v text)"

let open: { close(): Promise<void> }[] = []

function track<T extends { close(): Promise<void> }>(thing: T): T {
  open.push(thing)
  return thing
}

afterEach(async () => {
  const current = open
  open = []
  for (const thing of current.reverse()) {
    try {
      await thing.close()
    } catch {
      // A test that already closed a node leaves nothing to do here.
    }
  }
})

afterAll(async () => {
  await stopAll()
})

/** The replication view of a database, from whichever node is asked. */
async function replicationOf(node: Node, db: string): Promise<Record<string, unknown>> {
  return await node.json<Record<string, unknown>>(`/v1/db/${db}/replication`)
}

describe("streaming", () => {
  test("a write on the primary is readable on the replica", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")

    const written = await query(cluster.primary, "acme", "insert into t (v) values ('one')")
    await untilTxid(replica, "acme", written.txid)

    const read = await query(replica, "acme", "select v from t")
    expect(read.rows).toEqual([["one"]])
  })

  test("a burst of writes arrives in order and none are lost", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")

    let last = 0
    for (let i = 0; i < 50; i++) {
      last = (await query(cluster.primary, "acme", "insert into t (v) values (?)", [`v${i}`])).txid
    }
    await untilTxid(replica, "acme", last)

    const read = await query(replica, "acme", "select count(*) as n from t")
    expect(read.rows).toEqual([[50]])
    // The rolling checksum is the whole proof: equal checksums means byte-identical databases.
    const primaryView = await replicationOf(cluster.primary, "acme")
    const replicaView = await replicationOf(replica, "acme")
    expect(replicaView.checksum).toBe(primaryView.checksum)
  })

  test("a database created after the replica connected starts replicating", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await until(
      () => Boolean(replica.handle.runtime.replica?.connected),
      "the replica to finish its handshake",
    )

    await createDb(cluster.primary, "later", SCHEMA)
    await untilSynced(cluster.primary, replica, "later")
    const written = await query(cluster.primary, "later", "insert into t (v) values ('x')")
    await untilTxid(replica, "later", written.txid)
    expect((await query(replica, "later", "select v from t")).rows).toEqual([["x"]])
  })

  test("only the databases in `follow` are replicated", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "wanted", SCHEMA)
    await createDb(primary, "ignored", SCHEMA)
    const replica = track(await startReplica(primary, { follow: ["wanted"] }))
    await untilSynced(primary, replica, "wanted")

    const written = await query(primary, "wanted", "insert into t (v) values ('yes')")
    await untilTxid(replica, "wanted", written.txid)
    expect(replica.handle.runtime.replica?.followed).toEqual(["wanted"])
    expect(replica.handle.registry.list().map((row) => row.name)).toEqual(["wanted"])
  })
})

describe("bootstrap", () => {
  test("an empty replica bootstraps from a snapshot of a database with history", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    let last = 0
    for (let i = 0; i < 20; i++) {
      last = (await query(primary, "acme", "insert into t (v) values (?)", [`v${i}`])).txid
    }
    // A snapshot on the primary is what the replica will be sent, rather than 20 records.
    const snapshot = await primary.fetch("/v1/db/acme/snapshot", { method: "POST" })
    expect(snapshot.status).toBe(200)
    const after = (await query(primary, "acme", "insert into t (v) values ('after')")).txid

    const replica = track(await startReplica(primary))
    await untilTxid(replica, "acme", after)
    expect((await query(replica, "acme", "select count(*) as n from t")).rows).toEqual([[21]])
    expect((await replicationOf(replica, "acme")).checksum).toBe(
      (await replicationOf(primary, "acme")).checksum,
    )
  })

  test("a replica of an empty database starts from its snapshot and follows on", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "fresh")
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "fresh")

    await query(primary, "fresh", SCHEMA)
    const written = await query(primary, "fresh", "insert into t (v) values ('first')")
    await untilTxid(replica, "fresh", written.txid)
    expect((await query(replica, "fresh", "select v from t")).rows).toEqual([["first"]])
  })

  test("a retention gap forces a re-snapshot", async () => {
    // One segment per record, so `retain` has whole segments to drop rather than one big one.
    const primary = track(await startPrimary({ durability: { segmentBytes: 1 } }))
    await createDb(primary, "acme", SCHEMA)
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "acme")
    const first = await query(primary, "acme", "insert into t (v) values ('before')")
    await untilTxid(replica, "acme", first.txid)

    // Take the replica away, write past its position, then drop the log out from under it: a
    // resume is impossible and the only honest answer is a fresh snapshot.
    await replica.close()
    open = open.filter((one) => one !== replica)
    let last = first.txid
    for (let i = 0; i < 5; i++) {
      last = (await query(primary, "acme", "insert into t (v) values (?)", [`v${i}`])).txid
    }
    await primary.fetch("/v1/db/acme/snapshot", { method: "POST" })
    const tenant = primary.handle.registry.open("acme")
    // `retain` keeps the newest segment, so rolling one first is what lets the old ones go.
    tenant.log.retain({ maxBytes: 1, keepAfterTxid: tenant.txid })
    expect(tenant.log.firstTxid).not.toBe(1n)

    const back = track(await startReplica(primary, { dir: replica.dir }))
    await untilTxid(back, "acme", last)
    expect(back.handle.runtime.replica?.status().lastError).toContain("RETENTION")
    expect((await query(back, "acme", "select count(*) as n from t")).rows).toEqual([[6]])
    expect((await replicationOf(back, "acme")).checksum).toBe(
      (await replicationOf(primary, "acme")).checksum,
    )
  })

  test("a diverged replica is caught by its checksum and re-snapshotted", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const replica = track(await startReplica(primary))
    await untilSynced(primary, replica, "acme")
    const first = await query(primary, "acme", "insert into t (v) values ('real')")
    await untilTxid(replica, "acme", first.txid)

    await replica.close()
    open = open.filter((one) => one !== replica)
    // Rewrite the checksum in the applier's own `meta.json` — the file a replica trusts over
    // everything else. It now claims a state the primary never produced, which is what bit rot or
    // a split brain looks like from the primary's side.
    const { tenantDir } = await import("../../src/tenant/tenant.ts")
    const metaPath = `${tenantDir(replica.dir, "acme")}/meta.json`
    const meta = JSON.parse(await Bun.file(metaPath).text()) as Record<string, unknown>
    expect(meta.postChecksum).not.toBe("1311768467463790320")
    meta.postChecksum = "1311768467463790320"
    await Bun.write(metaPath, JSON.stringify(meta))

    const more = await query(primary, "acme", "insert into t (v) values ('second')")
    const back = track(await startReplica(primary, { dir: replica.dir }))
    await untilTxid(back, "acme", more.txid)
    expect(back.handle.runtime.replica?.status().lastError).toContain("DIVERGED")
    expect((await query(back, "acme", "select v from t order by id")).rows).toEqual([
      ["real"],
      ["second"],
    ])
    expect((await replicationOf(back, "acme")).checksum).toBe(
      (await replicationOf(primary, "acme")).checksum,
    )
  })
})

describe("resume", () => {
  test("a dropped socket resumes with no gap and no duplicate", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")
    const before = await query(cluster.primary, "acme", "insert into t (v) values ('before')")
    await untilTxid(replica, "acme", before.txid)

    // Drop the socket from the primary's side, the way a network partition would.
    cluster.primary.handle.runtime.replication?.stop()
    await until(
      () => replica.handle.runtime.replica?.connected === false,
      "the replica to notice the socket is gone",
    )

    // Writes the replica cannot see yet. On reconnect they must arrive exactly once each.
    let last = before.txid
    for (let i = 0; i < 5; i++) {
      last = (await query(cluster.primary, "acme", "insert into t (v) values (?)", [`v${i}`])).txid
    }

    // A fresh endpoint on the same registry stands in for the primary coming back.
    const { ReplicationServer } = await import("../../src/replication/primary.ts")
    const revived = new ReplicationServer({
      registry: cluster.primary.handle.registry,
      node: "primary",
      secret: cluster.primary.handle.config.replication.secret,
      heartbeatMs: 100,
      onError: () => {},
    })
    // `runtime.replication` is readonly by design; the test swaps it for the revived one.
    Object.defineProperty(cluster.primary.handle.runtime, "replication", { value: revived })

    await untilTxid(replica, "acme", last)
    const rows = await query(replica, "acme", "select v from t order by id")
    expect(rows.rows).toEqual([["before"], ["v0"], ["v1"], ["v2"], ["v3"], ["v4"]])
    expect((await replicationOf(replica, "acme")).checksum).toBe(
      (await replicationOf(cluster.primary, "acme")).checksum,
    )
    // A resume, not a re-bootstrap: `RETENTION` or `DIVERGED` would have been recorded here.
    expect(replica.handle.runtime.replica?.status().lastError).toBeNull()
    revived.stop()
  })

  test("a replica restart resumes from its persisted position", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const replica = await startReplica(primary)
    open.push(replica)
    await untilSynced(primary, replica, "acme")
    const before = await query(primary, "acme", "insert into t (v) values ('before')")
    await untilTxid(replica, "acme", before.txid)

    await replica.close()
    open = open.filter((one) => one !== replica)
    const written = await query(primary, "acme", "insert into t (v) values ('while down')")

    const back = track(await startReplica(primary, { dir: replica.dir }))
    await untilTxid(back, "acme", written.txid)
    expect((await query(back, "acme", "select v from t order by id")).rows).toEqual([
      ["before"],
      ["while down"],
    ])
    // Resuming means streaming, not re-bootstrapping: the log still reached back far enough, so
    // the primary never had to tell this replica its position was unusable.
    expect((await replicationOf(back, "acme")).lagTxid).toBe(0)
    expect(back.handle.runtime.replica?.status().lastError).toBeNull()
  })
})

describe("refusals", () => {
  test("a write on a replica is 503 NOT_PRIMARY with a BunQL-Primary header", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")

    const response = await replica.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('nope')" }),
    })
    expect(response.status).toBe(503)
    expect(response.headers.get(HEADERS.role)).toBe("replica")
    expect(response.headers.get(HEADERS.primary)).toBe(cluster.primary.replicationUrl)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("NOT_PRIMARY")
  })

  test("an interactive transaction on a replica is refused too", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")

    const response = await replica.fetch("/v1/db/acme/tx", { method: "POST", body: "{}" })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_PRIMARY")
  })

  test("reads still work on a replica, including minTxid waits", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")
    const written = await query(cluster.primary, "acme", "insert into t (v) values ('rw')")

    // Sent before the record can have arrived: the replica has to wait for it, not refuse.
    const response = await replica.fetch("/v1/db/acme/query", {
      method: "POST",
      headers: { [HEADERS.minTxid]: String(written.txid) },
      body: JSON.stringify({ sql: "select v from t" }),
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { rows: unknown[][] }).rows).toEqual([["rw"]])
  })

  test("a replica claiming a newer epoch is refused EPOCH_AHEAD", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    await query(primary, "acme", "insert into t (v) values ('one')")

    const { FRAME, FrameReader, encodeJson, makeProof, PROTO_VERSION } = await import(
      "../../src/replication/protocol.ts"
    )
    const errors = await new Promise<{ code: string; message: string }[]>((resolve, reject) => {
      const seen: { code: string; message: string }[] = []
      const reader = new FrameReader()
      const socket = new WebSocket(primary.replicationUrl)
      socket.binaryType = "arraybuffer"
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error(`no ERROR frame arrived; saw ${JSON.stringify(seen)}`))
      }, 5000)
      socket.addEventListener("message", (event) => {
        for (const frame of reader.push(event.data as ArrayBuffer)) {
          const body = JSON.parse(new TextDecoder().decode(frame.body)) as Record<string, string>
          if (frame.type === FRAME.HELLO && body.nonce) {
            socket.send(
              encodeJson(FRAME.HELLO, {
                proto: PROTO_VERSION,
                node: "impostor",
                proof: makeProof(primary.handle.config.replication.secret, body.nonce),
              }),
            )
            continue
          }
          if (frame.type === FRAME.HELLO && body.ok) {
            socket.send(
              encodeJson(FRAME.SUBSCRIBE, {
                stream: 1,
                db: "acme",
                fromTxid: "1",
                // A deposed primary that came back claims a term the live one never issued.
                epoch: 99,
                checksum: "0",
              }),
            )
            continue
          }
          if (frame.type === FRAME.ERROR) {
            seen.push({ code: body.code as string, message: body.message as string })
            clearTimeout(timer)
            socket.close()
            resolve(seen)
            return
          }
        }
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("the replication socket failed to open"))
      })
    })
    expect(errors[0]?.code).toBe("EPOCH_AHEAD")
    expect(errors[0]?.message).toContain("epoch 99")
    expect(primary.handle.runtime.replication?.replicasOf("acme")).toEqual([])
  })

  test("a wrong cluster secret is refused AUTH_FAILED and the socket closes", async () => {
    const primary = track(await startPrimary())
    const { FRAME, FrameReader, encodeJson, makeProof, PROTO_VERSION } = await import(
      "../../src/replication/protocol.ts"
    )
    const outcome = await new Promise<string>((resolve, reject) => {
      const reader = new FrameReader()
      let code = "none"
      const socket = new WebSocket(primary.replicationUrl)
      socket.binaryType = "arraybuffer"
      const timer = setTimeout(() => reject(new Error("the socket was never closed")), 5000)
      socket.addEventListener("message", (event) => {
        for (const frame of reader.push(event.data as ArrayBuffer)) {
          const body = JSON.parse(new TextDecoder().decode(frame.body)) as Record<string, string>
          if (frame.type === FRAME.HELLO && body.nonce) {
            socket.send(
              encodeJson(FRAME.HELLO, {
                proto: PROTO_VERSION,
                node: "impostor",
                proof: makeProof("the wrong secret entirely", body.nonce),
              }),
            )
          } else if (frame.type === FRAME.ERROR) {
            code = body.code as string
          }
        }
      })
      socket.addEventListener("close", () => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    expect(outcome).toBe("AUTH_FAILED")
  })

  test("a node with no cluster secret answers 403 REPLICATION_DISABLED", async () => {
    const primary = track(await startPrimary({ replication: { secret: "" } }))
    const response = await fetch(`${primary.url}/v1/replication`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": Buffer.from(new Uint8Array(16)).toString("base64"),
        "sec-websocket-version": "13",
      },
    })
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "REPLICATION_DISABLED",
    )
  })
})

describe("observability", () => {
  test("the primary lists its replicas and the replica reports its stream", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")
    const written = await query(cluster.primary, "acme", "insert into t (v) values ('one')")
    await untilTxid(replica, "acme", written.txid)
    await until(async () => {
      const view = (await replicationOf(cluster.primary, "acme")) as { replicas: unknown[] }
      return view.replicas.length > 0 && (view.replicas[0] as { txid: number }).txid >= written.txid
    }, "the primary to record the replica's ack")

    const onPrimary = (await replicationOf(cluster.primary, "acme")) as {
      role: string
      replicas: { node: string; txid: number; lag: number; fsynced: boolean }[]
    }
    expect(onPrimary.role).toBe("primary")
    expect(onPrimary.replicas).toHaveLength(1)
    expect(onPrimary.replicas[0]?.node).toBe("replica-1")
    expect(onPrimary.replicas[0]?.lag).toBe(0)
    expect(onPrimary.replicas[0]?.fsynced).toBe(true)

    const onReplica = (await replicationOf(replica, "acme")) as {
      role: string
      connected: boolean
      applied: number
      lagTxid: number
      primary: string
    }
    expect(onReplica.role).toBe("replica")
    expect(onReplica.connected).toBe(true)
    expect(onReplica.applied).toBe(written.txid)
    expect(onReplica.lagTxid).toBe(0)
    expect(onReplica.primary).toBe(cluster.primary.replicationUrl)
  })

  test("both nodes export the four replication series", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")
    const written = await query(cluster.primary, "acme", "insert into t (v) values ('one')")
    await untilTxid(replica, "acme", written.txid)

    const primaryText = await (await cluster.primary.fetch("/metrics")).text()
    expect(primaryText).toContain("bunql_replication_connected")
    expect(primaryText).toContain("bunql_replication_lag_txid")
    expect(primaryText).toMatch(/bunql_replication_records_total\{[^}]*\} [1-9]/)
    expect(primaryText).toMatch(/bunql_replication_bytes_total\{[^}]*\} [1-9]/)

    const replicaText = await (await replica.fetch("/metrics")).text()
    expect(replicaText).toMatch(/bunql_replication_connected\{[^}]*\} 1/)
    expect(replicaText).toMatch(/bunql_replication_records_total\{[^}]*\} [1-9]/)
  })

  test("readyz on a replica reports the stream, and healthz reports the role", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await until(
      () => Boolean(replica.handle.runtime.replica?.connected),
      "the replica to connect",
    )
    const ready = await replica.json<{ ready: boolean; role: string; connected: boolean }>(
      "/readyz",
    )
    expect(ready).toMatchObject({ ready: true, role: "replica", connected: true })
    expect(await cluster.primary.json<{ role: string }>("/healthz")).toMatchObject({
      role: "primary",
    })
  })
})

describe("chained replication", () => {
  test("primary → replica → replica carries records to the end", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const middle = track(await startReplica(primary, { node: "middle" }))
    await untilSynced(primary, middle, "acme")
    // The middle node is a replica that is also a primary for the one behind it.
    const tail = track(await startReplica(middle, { node: "tail" }))
    await untilSynced(middle, tail, "acme")

    let last = 0
    for (let i = 0; i < 10; i++) {
      last = (await query(primary, "acme", "insert into t (v) values (?)", [`v${i}`])).txid
    }
    await untilTxid(middle, "acme", last)
    await untilTxid(tail, "acme", last)

    expect((await query(tail, "acme", "select count(*) as n from t")).rows).toEqual([[10]])
    const checksum = (await replicationOf(primary, "acme")).checksum
    expect((await replicationOf(middle, "acme")).checksum).toBe(checksum)
    expect((await replicationOf(tail, "acme")).checksum).toBe(checksum)
  })
})

describe("fan-out", () => {
  test("two replicas of one primary both stay current", async () => {
    const cluster = track(await startCluster(2))
    const [first, second] = cluster.replicas as [Node, Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, first, "acme")
    await untilSynced(cluster.primary, second, "acme")

    let last = 0
    for (let i = 0; i < 10; i++) {
      last = (await query(cluster.primary, "acme", "insert into t (v) values (?)", [`v${i}`])).txid
    }
    await untilTxid(first, "acme", last)
    await untilTxid(second, "acme", last)

    const checksum = (await replicationOf(cluster.primary, "acme")).checksum
    expect((await replicationOf(first, "acme")).checksum).toBe(checksum)
    expect((await replicationOf(second, "acme")).checksum).toBe(checksum)
    await until(
      () => (cluster.primary.handle.runtime.replication?.replicasOf("acme").length ?? 0) === 2,
      "the primary to see both replicas",
    )
  })
})
