// Deployment examples remain the source of truth. Package copies are checked before shipping.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
export const deploymentTemplates = {
  "vercel/Dockerfile.vercel": "deploy/vercel/Dockerfile.vercel",
  "vercel/Dockerfile.vercel.dockerignore": "deploy/vercel/Dockerfile.vercel.dockerignore",
  "vercel/server.ts": "deploy/vercel/server.ts",
  "vercel/blob-store.ts": "deploy/vercel/blob-store.ts",
  "vercel/vercel.json": "deploy/vercel/vercel.json",
  "vercel/package.json": "deploy/vercel/package.json",
  "vercel/bun.lock": "deploy/vercel/bun.lock",
  "cloudflare/Dockerfile": "deploy/cloudflare/Dockerfile",
  "cloudflare/Dockerfile.dockerignore": "deploy/cloudflare/Dockerfile.dockerignore",
  "cloudflare/server.ts": "deploy/cloudflare/server.ts",
  "cloudflare/src/routing.ts": "deploy/cloudflare/src/routing.ts",
  "cloudflare/src/index.ts": "deploy/cloudflare/src/index.ts",
  "cloudflare/wrangler.jsonc": "deploy/cloudflare/wrangler.jsonc",
  "cloudflare/package.json": "deploy/cloudflare/package.json",
  "cloudflare/bun.lock": "deploy/cloudflare/bun.lock",
  "fly/Dockerfile": "Dockerfile",
  "fly/fly.toml": "fly.toml",
  "dockerignore": ".dockerignore",
} as const

if (import.meta.main) {
  const check = Bun.argv.includes("--check")
  for (const [target, source] of Object.entries(deploymentTemplates)) {
    const bytes = await readFile(resolve(root, source))
    const output = resolve(root, "packages/db/deploy-templates", target)
    if (check) {
      if (!bytes.equals(await readFile(output))) throw new Error(`Deployment template is stale: ${target}; run bun run deploy:templates`)
    } else {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, bytes)
    }
  }
  console.log(`Deployment templates ${check ? "verified" : "updated"}: ${Object.keys(deploymentTemplates).length}`)
}
