// A replica that cannot reach its primary has to say so. Before this, a node pointed at a primary
// whose `[replication] secret` is empty retried forever against a `403 REPLICATION_DISABLED` it
// could not see, logged nothing, and answered `GET /v1/db` with an empty list — a configuration
// mistake that looks exactly like an empty cluster.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ReplicaClient, ReplicaOffline, type ClientSocket } from "../../src/replication/index.ts"
import { TenantRegistry } from "../../src/tenant/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const open: { registry: TenantRegistry; dir: string }[] = []

afterEach(() => {
  for (const { registry, dir } of open.splice(0)) {
    registry.close()
    removeTempDir(dir)
  }
})

function registry(): TenantRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-offline-"))
  const reg = TenantRegistry.open({ dir })
  open.push({ registry: reg, dir })
  return reg
}

/** A socket that never opens: `close` fires on the next tick, as a failed upgrade does. */
function deadSocket(reason?: string): ClientSocket {
  const listeners = new Map<string, (event: never) => void>()
  queueMicrotask(() => {
    listeners.get("error")?.(undefined as never)
    listeners.get("close")?.({ code: 1006, reason } as never)
  })
  return {
    send() {},
    close() {},
    binaryType: "arraybuffer",
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
  }
}

describe("a replica that cannot connect", () => {
  test("reports the first failure and then only on powers of two", async () => {
    const errors: unknown[] = []
    const client = new ReplicaClient({
      registry: registry(),
      primary: "ws://127.0.0.1:1/v1/replication",
      secret: "s",
      node: "replica-1",
      reconnectMs: 1,
      onError: (err) => errors.push(err),
      factory: () => deadSocket(),
    })
    client.start()
    // Long enough for well past eight attempts at a 1 ms base backoff.
    await Bun.sleep(250)
    client.stop()

    expect(errors.length).toBeGreaterThanOrEqual(4)
    expect(errors.every((err) => err instanceof ReplicaOffline)).toBe(true)
    const attempts = errors.map((err) => Number(/attempt (\d+)/.exec((err as Error).message)?.[1]))
    // 1, 2, 4, 8, … and nothing in between: prompt notice, then a slow drumbeat.
    expect(attempts.slice(0, 4)).toEqual([1, 2, 4, 8])
  })

  test("keeps the reason the primary closed with, over the generic one", async () => {
    const errors: ReplicaOffline[] = []
    const client = new ReplicaClient({
      registry: registry(),
      primary: "ws://127.0.0.1:1/v1/replication",
      secret: "s",
      node: "replica-1",
      reconnectMs: 5,
      onError: (err) => {
        if (err instanceof ReplicaOffline) errors.push(err)
      },
      factory: () => deadSocket("the cluster secret proof did not verify"),
    })
    client.start()
    await Bun.sleep(40)
    client.stop()

    expect(errors[0]?.message).toContain("the cluster secret proof did not verify")
    expect(client.status().lastError).toContain("the cluster secret proof did not verify")
  })
})
