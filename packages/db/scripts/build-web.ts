// Builds `bql.sh/web` for a `<script type="module">`: one minified ES module, `dist/web.js`, with
// the client inside it. `prepack` runs this, so the published tarball carries the file a CDN
// serves (`https://cdn.jsdelivr.net/npm/bql.sh/packages/db/dist/web.js`); the repo ignores it.
//
//   bun run db build:web

import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const result = await Bun.build({
  entrypoints: [resolve(ROOT, "src/web/index.ts")],
  outdir: resolve(ROOT, "dist"),
  naming: "web.js",
  target: "browser",
  format: "esm",
  minify: true,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
const text = await Bun.file(resolve(ROOT, "dist/web.js")).text()
// A browser cannot load either, and a bundle that names one fails only for whoever loads it.
const runtimeImport = text.match(/\b(?:from|import)\s*\(?\s*["'](?:node|bun):[^"']+["']/)
if (runtimeImport) {
  console.error(`build:web: dist/web.js imports ${runtimeImport[0]}`)
  process.exit(1)
}
const gzipped = Bun.gzipSync(new TextEncoder().encode(text)).byteLength
console.log(`build:web: dist/web.js ${(text.length / 1024).toFixed(1)} KiB, ${(gzipped / 1024).toFixed(1)} KiB gzipped`)
