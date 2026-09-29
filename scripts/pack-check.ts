// The gate L7 exists for: prove the **published tarball** can build its own SQLite and run.
//
// Invariant: nothing here touches the working tree. `npm pack` produces a tarball, the tarball is
// installed into a fresh temp directory as a dependency, and every command after that runs there —
// so a file the repo has and the package does not is a failure rather than an invisible pass. That
// is exactly what `package.json` `files` got wrong before L7: it excluded `scripts/`, so
// `sqlite:build` — advertised in `package.json` and in the README — was not in the published
// package at all, and a clone with a locally built `vendor/` hid it completely.
//
//   bun run pack:check                       pack, install, build, smoke both halves
//   bun run pack:check --keep                leave the temp directory behind for inspection
//
// One package now, so one gate: the tarball has to carry the database's `scripts/` (for
// `sqlite:build`), the bus's built dashboard (the CLI serves it), and every advertised entry
// point of both. `SKIP_COMPILED=1` drops the bus's compiled-binary leg, which is the slow one.
//
// It is deliberately not a `bun test`: it shells out to `npm` and compiles SQLite, which is a
// minute of CPU and a network fetch, and neither belongs in a suite that runs on every save.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const KEEP = Bun.argv.includes("--keep")
const ROOT = resolve(import.meta.dir, "..")
const DB = "packages/db"
const BUS = "packages/bus"

function run(cmd: string[], cwd: string, label: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const out = new TextDecoder().decode(result.stdout)
  const err = new TextDecoder().decode(result.stderr)
  if (!result.success) {
    console.error(`${label} failed (exit ${result.exitCode})`)
    console.error(`  in ${cwd}: ${cmd.join(" ")}`)
    if (out.trim()) console.error(out.trim())
    if (err.trim()) console.error(err.trim())
    process.exit(1)
  }
  return out
}

run([process.execPath, "run", "scripts/deploy-templates.ts", "--check"], ROOT, "deployment template consistency")
console.log("pack-check: npm pack")
// `--pack-destination` keeps the tarball out of the working tree, which is the point.
const stage = mkdtempSync(join(tmpdir(), "bql-pack-"))
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
const consumer = mkdtempSync(join(tmpdir(), "bql-consumer-"))
writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify({ name: "bql-pack-check", private: true, type: "module" }, null, 2)}\n`,
)
console.log("pack-check: npm install <tarball>")
run(["npm", "install", "--silent", "--no-audit", "--no-fund", tarball], consumer, "npm install")

const installed = join(consumer, "node_modules", "bql.sh")
for (const needed of [
  `${DB}/scripts/sqlite.ts`,
  `${DB}/scripts/native/walsum.c`,
  `${DB}/scripts/native/ext.c`,
  `${DB}/src/sqlite/lib.ts`,
  `${DB}/deploy-templates/vercel/blob-store.ts`,
  `${DB}/deploy-templates/vercel/Dockerfile.vercel.dockerignore`,
  `${DB}/deploy-templates/cloudflare/bun.lock`,
  `${DB}/deploy-templates/cloudflare/src/index.ts`,
  `${DB}/deploy-templates/fly/fly.toml`,
  `${BUS}/src/index.ts`,
  // The bus CLI serves `dist/dashboard`; a tarball without it 404s only for whoever installed it.
  `${BUS}/dist/dashboard/index.html`,
]) {
  if (!existsSync(join(installed, needed))) {
    console.error(`pack-check: the tarball is missing ${needed}`)
    process.exit(1)
  }
}

console.log("pack-check: stage all three provider templates from the installed package")
run([process.execPath, "-e", `
  const { initDeployment } = await import(${JSON.stringify(join(installed, DB, "src/deploy/config.ts"))});
  const { stageDeployment } = await import(${JSON.stringify(join(installed, DB, "src/deploy/templates.ts"))});
  const { mkdir } = await import("node:fs/promises");
  for (const provider of ["vercel", "cloudflare", "fly"]) {
    const dir = ${JSON.stringify(consumer)} + "/deployment-" + provider;
    await mkdir(dir);
    const config = await initDeployment(provider, dir);
    await stageDeployment(config, dir + "/app");
  }
`], consumer, "installed deployment templates")

// The advertised command, run from where a consumer would actually run it. `npm run` cannot reach
// a dependency's scripts, so the path is the contract and the README says so.
console.log(`pack-check: bun run node_modules/bql.sh/${DB}/scripts/sqlite.ts`)
// `--quiet` makes the only line it prints the path, which is what a caller wants to capture.
const built = run(
  [process.execPath, "run", join(installed, DB, "scripts", "sqlite.ts"), "--quiet"],
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
  `import { sqlite } from "bql.sh/sqlite"
import { Bql } from "bql.sh"
import { resolveContext, redactContext } from "bql.sh/context"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const lib = sqlite()
const missing = ["preupdate", "session", "walsum", "vec", "geo"].filter((name) => !lib.features[name])
if (missing.length > 0) throw new Error("the built library lacks " + missing.join(", "))
if (!lib.path.includes("vendor")) throw new Error("not the vendored library: " + lib.path)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-smoke-"))
const connection = await resolveContext({ cwd: dir, configDir: path.join(dir, "config"), env: {} })
if (connection.url !== "http://127.0.0.1:4321" || redactContext(connection).authenticated) throw new Error("context export did not resolve clean defaults")
const bq = await Bql.open({ dir })
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

// Offline native boundaries plus a real server: the installed deploy workflow must
// create its profile and use it through the installed CLI, without provider billing.
const deploySmoke = join(consumer, "deploy-smoke.ts")
writeFileSync(deploySmoke, `
import { readDeployment, planDeployment } from ${JSON.stringify(join(installed, DB, "src/deploy/config.ts"))}
import { applyDeployment } from ${JSON.stringify(join(installed, DB, "src/deploy/apply.ts"))}
import { loadConfig } from ${JSON.stringify(join(installed, DB, "src/server/config.ts"))}
import { startServer } from ${JSON.stringify(join(installed, DB, "src/server/app.ts"))}
const cwd = ${JSON.stringify(join(consumer, "deployment-fly"))}
const configDir = cwd + "/private-config"
let server
try {
  const config = await readDeployment(cwd)
  const result = await applyDeployment(planDeployment(config), {
    configDir,
    runner: async () => ({ stdout: '{"email":"pack@example.test"}', stderr: '', exitCode: 0 }),
    driver: async ({ journal }) => {
      server = await startServer(loadConfig({ env: {}, overrides: {
        server: { host: "127.0.0.1", port: 0, workers: 1 }, data: { dir: cwd + "/data" },
        auth: { adminKey: journal.secrets.BQL_ADMIN_KEY, jwtKey: journal.secrets.BQL_JWT_ED25519 },
      } }))
      await journal.recordResource("app", config.name)
      return server.url
    },
  })
  for (const args of [["deploy", "plan"], ["db", "create", "packed"], ["exec", "packed", "--sql", "select 42 as answer"]]) {
    const flags = args[0] === "deploy" ? [] : ["--org", result.profile.org, "--project", result.profile.project, "--endpoint", result.profile.endpoint, "--config-dir", configDir]
    const child = Bun.spawn([process.execPath, ${JSON.stringify(join(installed, DB, "src/cli.ts"))}, ...args, ...flags], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code || (args[0] === "exec" && !stdout.includes("42"))) throw new Error("Installed deployment CLI smoke failed: " + stderr)
  }
  console.log("installed deployment profile and SQL smoke passed")
} finally { await server?.close() }
`)
console.log(run([process.execPath, "run", deploySmoke], consumer, "deployment workflow smoke").trim())

// The other half of the package. Same install, same tarball: a bus that publishes, claims and
// acks a message from the installed copy alone.
const busSmoke = join(consumer, "bus-smoke.ts")
writeFileSync(
  busSmoke,
  `import { BusStore, createServer, generateKey } from "bql.sh/bus"
import { BusClient } from "bql.sh/bus/client"

const signingKey = generateKey()
const adminToken = generateKey()
const store = new BusStore(":memory:")
const server = createServer({ store, signingKey, adminToken, port: 0, hostname: "127.0.0.1" })
const client = new BusClient({ url: \`http://127.0.0.1:\${server.port}\`, token: adminToken })
await client.subscribe({ name: "work", pattern: "work.>" })
const published = await client.publish({ subject: "work.hello", body: { from: "a clean install" } })
const [envelope] = await client.claim("work", "consumer-1", 1)
if (envelope?.message.seq !== published.seq) throw new Error("the claim did not return the message")
await client.ack(envelope.delivery, "consumer-1")
await server.shutdown()
store.close()
console.log("bus smoke ok")
`,
)
console.log("pack-check: bus smoke")
console.log(run([process.execPath, "run", busSmoke], consumer, "bus smoke").trim())

// `bql` and `bql bus`, run the way a consumer gets them — through node_modules/.bin.
for (const [binary, args, expect] of [
  ["bql", ["--help"], "bql"],
  ["bql", ["bus", "help"], "bql bus"],
] as const) {
  const out = run([join(consumer, "node_modules", ".bin", binary), ...args], consumer, binary)
  if (!out.includes(expect)) {
    console.error(`pack-check: ${binary} ran but did not mention ${expect}`)
    process.exit(1)
  }
  console.log(`pack-check: ${binary} runs`)
}

// The compiled binary is the other artefact people receive, and it breaks differently: `--compile`
// is fussy about assets read from disk and dynamic imports of computed paths, neither of which the
// npm path exercises.
if (!process.env.SKIP_COMPILED) {
  console.log("pack-check: compiled binary")
  run([process.execPath, "run", "scripts/compiled-e2e.ts"], join(ROOT, BUS), "compiled-e2e")
}

if (KEEP) {
  console.log(`pack-check: kept ${consumer}`)
} else {
  rmSync(stage, { recursive: true, force: true })
  rmSync(consumer, { recursive: true, force: true })
}
console.log("pack-check: ok")
