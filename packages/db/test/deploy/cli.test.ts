import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDeployCommand, readR2Credentials } from "../../src/deploy/cli.ts"
import { parseArgs } from "../../src/cli.ts"
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
test("deployment CLI init, plan and status are offline and preserve existing Fly files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-deploy-cli-")); dirs.push(dir)
  await writeFile(join(dir, "fly.toml"), "existing configuration")
  const output: unknown[] = []
  const options = { cwd: dir, env: { BQL_CONFIG_DIR: join(dir, "config") }, print: (value: unknown) => { output.push(value) } }
  expect(await runDeployCommand(parseArgs(["db", "list"]), options)).toBe(false)
  for (const args of [["init", "--provider", "fly"], ["plan", "--json"], ["status", "--json"]]) expect(await runDeployCommand(parseArgs(["deploy", ...args]), options)).toBe(true)
  expect(output).toHaveLength(3)
  expect(await readFile(join(dir, "fly.toml"), "utf8")).toBe("existing configuration")
  await expect(runDeployCommand(parseArgs(["deploy", "init", "--provider", "vercel"]), options)).rejects.toThrow("different deployment")
  await expect(runDeployCommand(parseArgs(["deploy", "plan", "--bogus"]), options)).rejects.toThrow("Unknown deploy option")
})
test("R2 credentials are read literally from private files without shell expansion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-r2-env-")); dirs.push(dir)
  const file = join(dir, "r2.env")
  await writeFile(file, '# private\nBQL_S3_ACCESS_KEY_ID="access"\nBQL_S3_SECRET_ACCESS_KEY=secret\n', { mode: 0o600 })
  expect(await readR2Credentials(file)).toEqual({ accessKeyId: "access", secretAccessKey: "secret" })
  await writeFile(file, 'BQL_S3_ACCESS_KEY_ID=access\nBQL_S3_SECRET_ACCESS_KEY=$(touch danger)\n')
  await expect(readR2Credentials(file)).rejects.toThrow("Invalid R2 credentials")
})
