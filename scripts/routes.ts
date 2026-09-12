// Prints the route table `Bun.serve` is actually given, so `docs/api.md` is written against the
// server rather than against a memory of it.
//
//   bun run scripts/routes.ts            # a markdown table
//   bun run scripts/routes.ts --check    # exits 1 when docs/api.md is missing a route

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createApp, createRuntime } from "../src/server/app.ts"
import { loadConfig } from "../src/server/config.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-routes-"))
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }))

const config = loadConfig({ env: {}, overrides: { data: { dir }, server: { port: 0 } } })
const { runtime } = await createRuntime(config)
const app = createApp(runtime)

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
  console.log(`docs/api.md covers all ${rows.length} routes.`)
} else {
  console.log("| method | path |")
  console.log("|---|---|")
  for (const row of rows) console.log(`| \`${row.method}\` | \`${row.path}\` |`)
}

runtime.close()
