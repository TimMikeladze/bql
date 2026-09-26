import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { validateDeployment, type DeploymentConfig } from "./config.ts"

const packageRoot = resolve(import.meta.dir, "../../../..")

/** Only package-owned source/templates are staged. The user's project and secrets are never copied. */
export async function stageDeployment(config: DeploymentConfig, directory: string): Promise<void> {
  validateDeployment(config)
  try { await lstat(directory); throw new Error("Deployment staging directory already exists") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  await mkdir(directory, { mode: 0o700 })
  try {
    const templates = join(packageRoot, "packages/db/deploy-templates")
    const provider = join(templates, config.provider)
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string }
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "bql-deployment", version: manifest.version, private: true, type: "module" }, null, 2) + "\n")
    await mkdir(join(directory, "packages/db"), { recursive: true })
    await cp(join(packageRoot, "packages/db/src"), join(directory, "packages/db/src"), { recursive: true, dereference: false })
    await cp(join(packageRoot, "packages/db/scripts"), join(directory, "packages/db/scripts"), { recursive: true, dereference: false })
    await cp(join(templates, "dockerignore"), join(directory, ".dockerignore"))
    if (config.provider === "fly") {
      await cp(join(provider, "Dockerfile"), join(directory, "Dockerfile"))
      const example = await readFile(join(provider, "fly.toml"), "utf8")
      const toml = example.replace(/^app = .*$/m, `app = "${config.name}"`).replace(/^primary_region = .*$/m, `primary_region = "${config.region}"`)
      await writeFile(join(directory, "fly.toml"), toml)
      return
    }
    await mkdir(join(directory, "deploy"), { recursive: true })
    await cp(provider, join(directory, "deploy", config.provider), { recursive: true })
    if (config.provider === "vercel") {
      for (const file of ["Dockerfile.vercel", "Dockerfile.vercel.dockerignore"]) await cp(join(provider, file), join(directory, file))
      const json = JSON.parse(await readFile(join(provider, "vercel.json"), "utf8"))
      json.regions = [config.region]
      await writeFile(join(directory, "vercel.json"), JSON.stringify(json, null, 2) + "\n")
    } else {
      await cp(join(provider, "Dockerfile"), join(directory, "Dockerfile"))
      const json = JSON.parse(await readFile(join(provider, "wrangler.jsonc"), "utf8"))
      json.name = config.name
      json.main = "deploy/cloudflare/src/index.ts"
      json.containers[0].image = "./Dockerfile"
      json.containers[0].image_build_context = "."
      json.vars.BQL_DEPLOYMENT_ENV = config.environment
      json.vars.BQL_DATA_DEPLOYMENT_ID = config.deploymentId
      json.vars.BQL_S3_BUCKET = config.name
      // Apply replaces this with the account selected by Wrangler before provisioning.
      if (config.scope && /^[a-f0-9]{32}$/.test(config.scope)) {
        json.account_id = config.scope
        json.vars.BQL_S3_ENDPOINT = `https://${config.scope}.r2.cloudflarestorage.com`
      }
      await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify(json, null, 2) + "\n")
    }
  } catch (error) {
    // This directory was exclusively created above. It contains no provider-created resources.
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
