import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { initDeployment } from "../../src/deploy/config.ts"
import { stageDeployment } from "../../src/deploy/templates.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
test("packaged templates stage independent deployable applications for all providers", async () => {
  for (const provider of ["vercel", "cloudflare", "fly"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "bql-template-")); dirs.push(dir)
    const config = await initDeployment(provider, dir, { name: "isolated-app" })
    const app = join(dir, "app")
    await stageDeployment(config, app)
    expect(await Bun.file(join(app, "packages/db/src/cloud/runtime.ts")).exists()).toBe(true)
    expect((await Bun.file(join(app, "package.json")).json()).workspaces).toBeUndefined()
    expect(await Bun.file(join(app, ".env")).exists()).toBe(false)
    if (provider === "vercel") {
      const json = await Bun.file(join(app, "vercel.json")).json()
      expect(json.services.database.entrypoint).toBe("Dockerfile.vercel")
      expect(json.regions).toEqual([config.region])
    } else if (provider === "cloudflare") {
      const json = await Bun.file(join(app, "wrangler.jsonc")).json()
      expect(json.name).toBe(config.name)
      expect(json.vars.BQL_DATA_DEPLOYMENT_ID).toBe(config.deploymentId)
      expect(json.vars.BQL_S3_BUCKET).toBe(config.name)
      expect(json.main).toBe("deploy/cloudflare/src/index.ts")
      expect(json.containers[0].image_build_context).toBe(".")
    } else {
      const toml = Bun.TOML.parse(await readFile(join(app, "fly.toml"), "utf8")) as Record<string, unknown>
      expect(toml.app).toBe(config.name)
      expect(toml.primary_region).toBe(config.region)
      expect(await readFile(join(app, "Dockerfile"), "utf8")).toContain('"/data"')
    }
    await writeFile(join(app, "user-file"), "preserve")
    await expect(stageDeployment(config, app)).rejects.toThrow("already exists")
    expect(await readFile(join(app, "user-file"), "utf8")).toBe("preserve")
  }
})

test("packaged provider files match the tested source examples", async () => {
  const { deploymentTemplates } = await import("../../../../scripts/deploy-templates.ts")
  const root = resolve(import.meta.dir, "../../../..")
  for (const [target, source] of Object.entries(deploymentTemplates)) {
    expect(await readFile(join(root, "packages/db/deploy-templates", target), "utf8")).toBe(await readFile(join(root, source), "utf8"))
  }
})
