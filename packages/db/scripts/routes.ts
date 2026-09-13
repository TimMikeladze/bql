// Prints the route table `Bun.serve` is actually given, so `docs/api.md` is written against the
// server rather than against a memory of it.
//
//   bun run scripts/routes.ts            # a markdown table
//   bun run scripts/routes.ts --check    # exits 1 when docs/api.md is missing a route, or when
//                                        # a route was added outside src/server/registry.ts
//
// The second check is what H6 bought. The table is *built* from the registry now
// (`docs/h6-mount.md`), so the two cannot disagree about an operation's path — but a hand-written
// entry added to `createApp` afterwards would be a route no document describes, which is exactly
// the drift the milestone removed. Only Hrana is allowed to be outside the registry, because it
// carries libsql's RPC envelope rather than BunQL's API.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createApp, createRuntime } from "../src/server/app.ts"
import { loadConfig } from "../src/server/config.ts"
import { serverRegistry } from "../src/server/registry.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-routes-"))
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }))

const config = loadConfig({ env: {}, overrides: { data: { dir }, server: { port: 0 } } })
const { runtime } = await createRuntime(config)
const app = await createApp(runtime)

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"]
const rows: { method: string; path: string }[] = []
for (const [route, handlers] of Object.entries(app.routes)) {
  for (const method of METHODS) {
    if ((handlers as Record<string, unknown>)[method]) rows.push({ method, path: route })
  }
}
// `/v1/ws` is reached through the `fetch` fallback rather than the route table, because the
// upgrade needs the server object that `Bun.serve` only passes there.
rows.push({ method: "GET", path: "/v1/ws" })
rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))

if (Bun.argv.includes("--check")) {
  const doc = fs.readFileSync(path.join(import.meta.dir, "..", "docs", "api.md"), "utf8")
  const missing = rows.filter((r) => !doc.includes(`${r.method} ${r.path}`))
  if (missing.length > 0) {
    console.error(`docs/api.md is missing ${missing.length} route(s):`)
    for (const row of missing) console.error(`  ${row.method} ${row.path}`)
    runtime.close()
    process.exit(1)
  }
  // Every route the table serves has to come from the registry, or from Hrana.
  const described = new Set(
    serverRegistry(app.surfaces, { api: config.api.enabled, graphql: true })
      .operations()
      .map((operation) => `${operation.method.toUpperCase()} ${operation.path}`),
  )
  const HRANA = /^\/v[23](\/|$)|^\/v1\/db\/:db\/(hrana|v[23])(\/|$)/
  const undescribed = rows.filter(
    (row) => !described.has(`${row.method} ${row.path}`) && !HRANA.test(row.path) && row.path !== "/v1/ws",
  )
  if (undescribed.length > 0) {
    console.error(`${undescribed.length} route(s) are served but not in src/server/registry.ts:`)
    for (const row of undescribed) console.error(`  ${row.method} ${row.path}`)
    runtime.close()
    process.exit(1)
  }
  console.log(`docs/api.md covers all ${rows.length} routes, and every one is in the registry.`)
} else {
  console.log("| method | path |")
  console.log("|---|---|")
  for (const row of rows) console.log(`| \`${row.method}\` | \`${row.path}\` |`)
}

runtime.close()
