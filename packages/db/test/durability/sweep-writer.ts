// The far end of `sweep.test.ts`'s crash case. Writes at `ack: "fsync"` with the shared sweep on,
// printing the txid of every write it has been *answered* for, until it is killed.
//
// Its own file because the test kills the process, and the claim under test is about what survives
// that: a caller answered at txid N must still find N after a `kill -9`, whatever the sweep is
// doing with its own timer. If `ack: "fsync"` had been quietly moved onto the sweep, this is the
// test that would fail.

import { TenantRegistry } from "../../src/tenant/index.ts"

const dir = process.argv[2] as string
const registry = TenantRegistry.open({ dir, fsyncSweep: "shared" })
const tenant = await registry.create("acme", {})
tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))

let n = 0
console.log("ready")
for (;;) {
  const written = await tenant.writeQueued((db) => db.run("insert into t (v) values (?)", [`v${n++}`]), {
    ack: "fsync",
  })
  // Printed only after the write was answered, so the last line the test reads is a txid the node
  // promised was on this machine's disk.
  console.log(String(written.txid))
}
