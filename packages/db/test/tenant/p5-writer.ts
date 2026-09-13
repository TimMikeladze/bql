// The far end of `defer-append.test.ts`'s crash case: writes with P5's deferral on until killed.
// Its own file because the test kills the *process*, and there is no killing a promise.

import { TenantRegistry } from "../../src/tenant/index.ts"

const dir = process.argv[2] as string
const registry = TenantRegistry.open({ dir, compressLog: true, deferAppend: true })
const tenant = await registry.create("acme", {})
tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
const insert = tenant.writer.prepare("insert into t (v) values (?)")
let n = 0
console.log("ready")
for (;;) {
  tenant.write(() => insert.run(`v${n++}`))
  // Yields, so the microtask that files the pending records actually gets to run sometimes — a
  // writer that never yielded would be testing a queue that only ever grows.
  if (n % 200 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
}
