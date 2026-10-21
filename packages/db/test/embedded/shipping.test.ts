// `bq.startShipping()`: the S3 shipper without a listener, which is how `bql bus serve` backs up
// database `bus` on a single node that never calls `serve()`.

import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bql } from "../../src/embedded.ts"
import { FakeS3 } from "../storage/fake-s3.ts"
import { removeTempDir } from "../tmpdir.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-shipping-"))
const bucket = await FakeS3.start({ bucket: "bql-shipping" })

afterAll(async () => {
  bucket.stop()
  removeTempDir(dir)
})

test("startShipping ships commits without serve(), and close ships the rest", async () => {
  const bq = await Bql.open({
    dir,
    s3: { ...bucket.storeOptions, prefix: "ship/", shipIntervalMs: 10_000 },
  })
  const db = await bq.create("bus")
  db.sync.write((d) => d.run("CREATE TABLE t (x)"))
  bq.startShipping()
  // A second call is a no-op rather than a second shipper.
  bq.startShipping()
  for (let i = 0; i < 5; i++) db.sync.write((d) => d.run("INSERT INTO t VALUES (?)", [i]))
  // The ship interval is longer than the test: whatever reaches the bucket got there on close.
  await bq.close()
  const keys = [...bucket.objects.keys()]
  expect(keys).toContain("ship/db/bus/manifest.json")
  // Every commit, including the one before `startShipping`, is in a shipped segment.
  const manifest = JSON.parse(
    new TextDecoder().decode(bucket.objects.get("ship/db/bus/manifest.json")!.body),
  ) as { shippedTxid: string }
  expect(manifest.shippedTxid).toBe("6")
})
