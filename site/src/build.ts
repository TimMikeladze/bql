// Writes the whole artefact set into site/public/. Deterministic: same READMEs, same bytes.
// og.png is not written here — it is a screenshot (scripts/og.ts) and is committed.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  faviconSvg, renderAgents, renderIndex, renderIndexMd, renderLlms, renderReference, renderReferenceMd,
  renderRobots, renderSitemap, renderVercel, resolveModel,
} from "./render.ts"

export const OUT = join(import.meta.dir, "..", "public")

export function artefacts(): Record<string, string> {
  const m = resolveModel()
  return {
    "index.html": renderIndex(m),
    "reference.html": renderReference().html,
    "index.md": renderIndexMd(m),
    "reference.md": renderReferenceMd(),
    "llms.txt": renderLlms(m),
    "AGENTS.md": renderAgents(m),
    "sitemap.xml": renderSitemap(),
    "robots.txt": renderRobots(),
    "favicon.svg": faviconSvg(),
    "vercel.json": renderVercel(),
  }
}

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true })
  for (const [name, body] of Object.entries(artefacts())) writeFileSync(join(OUT, name), body)
  console.log(`site: wrote ${Object.keys(artefacts()).length} files to site/public`)
}
