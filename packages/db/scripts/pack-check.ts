// The gate L7 exists for: prove the **published tarball** can build its own SQLite and run.
//
// Invariant: nothing here touches the working tree. `npm pack` produces a tarball, the tarball is
// installed into a fresh temp directory as a dependency, and every command after that runs there —
// so a file the repo has and the package does not is a failure rather than an invisible pass. That
// is exactly what `package.json` `files` got wrong before L7: it excluded `scripts/`, so
// `sqlite:build` — advertised in `package.json` and in the README — was not in the published
// package at all, and a clone with a locally built `vendor/` hid it completely.
//
//   bun run scripts/pack-check.ts            pack, install, build, smoke
//   bun run scripts/pack-check.ts --keep     leave the temp directory behind for inspection
//
// It is deliberately not a `bun test`: it shells out to `npm` and compiles SQLite, which is a
// minute of CPU and a network fetch, and neither belongs in a suite that runs on every save.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const KEEP = Bun.argv.includes("--keep")
const ROOT = resolve(import.meta.dir, "..")

function run(cmd: string[], cwd: string, label: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const out = new TextDecoder().decode(result.stdout)
  const err = new TextDecoder().decode(result.stderr)
  if (!result.success) {
    console.error(`${label} failed (exit ${result.exitCode})`)
    if (out.trim()) console.error(out.trim())
    if (err.trim()) console.error(err.trim())
    process.exit(1)
  }
  return out
}

console.log("pack-check: npm pack")
// `--pack-destination` keeps the tarball out of the working tree, which is the point.
const stage = mkdtempSync(join(tmpdir(), "bunql-pack-"))
const packed = run(
  ["npm", "pack", "--silent", "--pack-destination", stage],
  ROOT,
  "npm pack",
)
  .trim()
  .split("\n")
  .pop() as string
const tarball = join(stage, packed)
if (!existsSync(tarball)) {
  console.error(`pack-check: npm pack printed ${packed} but no such file in ${stage}`)
  process.exit(1)
}
console.log(`pack-check: ${packed}`)

// A clean consumer: its own directory, its own package.json, the tarball as its only dependency.
const consumer = mkdtempSync(join(tmpdir(), "bunql-consumer-"))
writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify({ name: "bunql-pack-check", private: true, type: "module" }, null, 2)}\n`,
)
console.log("pack-check: npm install <tarball>")
run(["npm", "install", "--silent", "--no-audit", "--no-fund", tarball], consumer, "npm install")

const installed = join(consumer, "node_modules", "@bunql", "db")
for (const needed of ["scripts/sqlite.ts", "scripts/native/walsum.c", "src/sqlite/lib.ts"]) {
  if (!existsSync(join(installed, needed))) {
    console.error(`pack-check: the tarball is missing ${needed}`)
    process.exit(1)
  }
}

// The advertised command, run from where a consumer would actually run it. `npm run` cannot reach
// a dependency's scripts, so the path is the contract and the README says so.
console.log("pack-check: bun run node_modules/@bunql/db/scripts/sqlite.ts")
// `--quiet` makes the only line it prints the path, which is what a caller wants to capture.
const built = run(
  [process.execPath, "run", join(installed, "scripts", "sqlite.ts"), "--quiet"],
  consumer,
  "sqlite:build",
)
const artefact = built.trim().split("\n").pop() as string
if (!existsSync(artefact)) {
  console.error(`pack-check: sqlite:build printed ${artefact} but no such file`)
  process.exit(1)
}
console.log(`pack-check: built ${artefact}`)

// The smoke test: the installed package, on the library it just built, doing the thing it is for.
const smoke = join(consumer, "smoke.ts")
writeFileSync(
  smoke,
  `import { sqlite } from "@bunql/db/sqlite"
import { BunQL } from "@bunql/db"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const lib = sqlite()
const missing = ["preupdate", "session", "walsum"].filter((name) => !lib.features[name])
if (missing.length > 0) throw new Error("the built library lacks " + missing.join(", "))
if (!lib.path.includes("vendor")) throw new Error("not the vendored library: " + lib.path)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-smoke-"))
const bq = await BunQL.open({ dir })
const db = await bq.create("acme")
await db.sql\`create table todos(id integer primary key, title text)\`.run()
await db.sql\`insert into todos(title) values (\${"packed"})\`.run()
const rows = db.sync.sql\`select title from todos\`.all()
if (JSON.stringify(rows) !== '[{"title":"packed"}]') {
  throw new Error("unexpected rows: " + JSON.stringify(rows))
}
await bq.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log("smoke ok on " + lib.path)
`,
)
console.log("pack-check: smoke")
console.log(run([process.execPath, "run", smoke], consumer, "smoke").trim())

if (KEEP) {
  console.log(`pack-check: kept ${consumer}`)
} else {
  rmSync(stage, { recursive: true, force: true })
  rmSync(consumer, { recursive: true, force: true })
}
console.log("pack-check: ok")
