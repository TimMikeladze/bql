// Every code in `ERROR_STATUS` is a refusal this server wrote on purpose, and several of them are
// 5xx. Reporting those as faults filled the log with stack traces for a replica answering exactly
// the question it is supposed to answer, and buried the 500s that are real bugs.

import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, type ServerHandle } from "../../src/server/app.ts"
import { loadConfig } from "../../src/server/config.ts"
import { ReplicaOffline } from "../../src/replication/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const running: ServerHandle[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.close()
  for (const dir of dirs.splice(0)) removeTempDir(dir)
})

test("a deliberate 503 is answered, not reported as a fault", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-report-"))
  dirs.push(dir)
  const faults: unknown[] = []
  const config = loadConfig({
    env: {},
    overrides: {
      server: { port: 0, host: "127.0.0.1", node: "replica-under-test" },
      data: { dir },
      auth: { adminKey: "admin-key-for-this-test" },
      // A replica whose primary does not exist: the admin routes refuse with NOT_PRIMARY, which
      // is the deliberate 503 this test is about.
      replication: { role: "replica", primary: "ws://127.0.0.1:1/v1/replication", secret: "s" },
    },
  })
  const handle = await startServer(config, {
    log: () => {},
    // The replica client's own "I cannot reach my primary" notices are operational news and are
    // not what this test is measuring.
    onError: (err) => {
      if (!(err instanceof ReplicaOffline)) faults.push(err)
    },
  })
  running.push(handle)

  const response = await fetch(`http://127.0.0.1:${handle.server.port}/v1/db`, {
    method: "POST",
    headers: {
      authorization: "Bearer admin-key-for-this-test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "acme" }),
  })

  expect(response.status).toBe(503)
  const body = (await response.json()) as { error: { code: string } }
  expect(body.error.code).toBe("NOT_PRIMARY")
  expect(faults).toEqual([])
})
