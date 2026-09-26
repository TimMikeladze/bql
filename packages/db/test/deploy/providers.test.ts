import { expect, test } from "bun:test"
import { authenticateProvider } from "../../src/deploy/providers.ts"
import type { DeploymentConfig } from "../../src/deploy/config.ts"
import { NativeCommandError, type NativeCommand } from "../../src/deploy/runner.ts"

const config: DeploymentConfig = { version: 1, provider: "cloudflare", name: "example", deploymentId: "preview-test", environment: "preview", region: "wnam" }
test("native provider login is reused and account choice is explicit", async () => {
  const calls: NativeCommand[] = []
  const runner = async (command: NativeCommand) => {
    calls.push(command)
    return { stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "one", name: "First" }, { id: "two", name: "Second" }] }), stderr: "", exitCode: 0 }
  }
  await expect(authenticateProvider(config, "/tmp", runner)).rejects.toThrow("--scope")
  expect(await authenticateProvider({ ...config, scope: "two" }, "/tmp", runner)).toEqual({ cli: "wrangler", scope: "two" })
  expect(calls.every(c => c.executable === "wrangler" && c.args.join(" ") === "whoami --json")).toBe(true)
})

test("Vercel uses the existing team and Fly uses the installed CLI", async () => {
  const vercel = await authenticateProvider({ ...config, provider: "vercel" }, "/tmp", async () => ({ stdout: JSON.stringify({ username: "user", team: { id: "team-id", slug: "team" } }), stderr: "", exitCode: 0 }))
  expect(vercel).toEqual({ cli: "vercel", scope: "team-id" })
  const fly = await authenticateProvider({ ...config, provider: "fly" }, "/tmp", async command => {
    expect(command.args).toEqual(["auth", "whoami", "--json"])
    return { stdout: '{"email":"user@example.test"}', stderr: "", exitCode: 0 }
  })
  expect(fly).toEqual({ cli: "fly" })
})

test("missing authentication reports the corresponding login command without provider output", async () => {
  for (const [provider, login] of [["vercel", "vercel login"], ["cloudflare", "wrangler login"], ["fly", "fly auth login"]] as const) {
    await expect(authenticateProvider({ ...config, provider }, "/tmp", async () => { throw new NativeCommandError("private provider output", 1) })).rejects.toThrow(login)
  }
  await expect(authenticateProvider(config, "/tmp", async () => ({ stdout: '{"loggedIn":false}', stderr: "", exitCode: 0 }))).rejects.toThrow("wrangler login")
})
