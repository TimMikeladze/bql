import { validateDeployment, type DeploymentConfig } from "./config.ts"
import { NativeCommandError, runNative, type NativeRunner } from "./runner.ts"

export interface ProviderSession { cli: "vercel" | "wrangler" | "fly"; scope?: string }

/** Authentication stays with the installed provider CLI. No credential scraping or new login flow. */
export async function authenticateProvider(config: DeploymentConfig, cwd: string, runner: NativeRunner = runNative): Promise<ProviderSession> {
  validateDeployment(config)
  const cli = config.provider === "cloudflare" ? "wrangler" : config.provider
  const login = cli === "fly" ? "fly auth login" : `${cli} login`
  let identity: Record<string, unknown>
  try {
    const result = await runner({ executable: cli, args: cli === "fly" ? ["auth", "whoami", "--json"] : ["whoami", "--json"], cwd, timeoutMs: 30_000 })
    identity = JSON.parse(result.stdout)
    if (!identity || typeof identity !== "object") throw new Error("Invalid identity")
  } catch (error) {
    if (error instanceof NativeCommandError && error.exitCode === undefined) throw error
    throw new Error(`Could not verify ${cli} authentication; run ${login} and retry`)
  }
  if (cli === "wrangler") {
    if (identity.loggedIn !== true) throw new Error(`Not authenticated; run ${login}`)
    const accounts = Array.isArray(identity.accounts) ? identity.accounts as { id: string; name: string }[] : []
    const selected = config.scope ? accounts.filter(a => a.id === config.scope || a.name === config.scope) : accounts
    if (selected.length !== 1 || typeof selected[0]?.id !== "string") throw new Error("Select a Cloudflare account using --scope ACCOUNT_ID during deploy init")
    return { cli, scope: selected[0].id }
  }
  if (cli === "vercel") {
    if (typeof identity.username !== "string" || !identity.username) throw new Error(`Not authenticated; run ${login}`)
    const team = identity.team as { id?: string } | undefined
    const scope = config.scope ?? (typeof team?.id === "string" ? team.id : undefined)
    return { cli, ...(scope ? { scope } : {}) }
  }
  if (typeof identity.email !== "string" || !identity.email) throw new Error(`Not authenticated; run ${login}`)
  return { cli, ...(config.scope ? { scope: config.scope } : {}) }
}
