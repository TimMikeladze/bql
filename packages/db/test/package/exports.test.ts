// The guard that keeps `package.json` exports and the docs from drifting apart: every subpath the
// package publishes has to resolve through the package name, and every `bql/…` import written in
// the README or in `docs/` has to be one of them. `docs/h3-openapi.md`, `docs/h4-dataapi.md` and
// `docs/h5-graphql.md` shipped importing `bql/core`, `bql/openapi`, `bql/dataapi` and
// `bql/graphql` for a while before the package exported any of them.

import { beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { selfLink } from "../../../../scripts/self-link.ts"
import { VERSION } from "../../src/server/surfaces.ts"

// The published manifest is the REPOSITORY's: one package, `bql.sh`, whose exports reach into both
// source trees. This file lives in the database's suite because that is where the surfaces it checks
// are, not because the database is a package of its own any more.
const root = join(import.meta.dir, "..", "..", "..", "..")

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string
  version: string
  exports: Record<string, string>
}
const exports = manifest.exports

/**
 * `bql.sh`, `bql.sh/client`, … — what an import specifier for each export entry looks like.
 *
 * Read from `name` rather than written out, so that renaming the package is one edit in
 * `package.json` and this file keeps checking the docs against whatever it is now.
 */
function specifierOf(key: string): string {
  return key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`
}

/** `manifest.name` as a regular expression: the scope's `@` and `/` are both meaningful here. */
const NAME_PATTERN = manifest.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Resolving `bql.sh/…` from inside the repository needs the root linked into its own
// `node_modules`; Bun self-links workspace members and the root manifest is not one. Done here
// rather than in an install hook, so the published package carries no lifecycle script.
beforeAll(() => {
  selfLink()
})

describe("package exports", () => {
  for (const [key, target] of Object.entries(exports)) {
    test(`${specifierOf(key)} resolves and loads`, async () => {
      if (key === "./package.json") {
        expect(target).toBe("./package.json")
        return
      }
      expect(target).toMatch(/^\.\/packages\/(db|bus)\/src\/.+\.ts$/)
      expect(Bun.file(join(root, target)).size).toBeGreaterThan(0)
      const loaded = (await import(specifierOf(key))) as Record<string, unknown>
      expect(Object.keys(loaded).length).toBeGreaterThan(0)
    })
  }

  test("every bql.sh/… import in the docs is a published subpath", () => {
    const published = new Set(Object.keys(exports).map(specifierOf))
    // Every place a `bql.sh/…` import is written down: the three READMEs and both docs trees.
    const docsIn = (dir: string) =>
      readdirSync(join(root, dir))
        .filter((name) => name.endsWith(".md"))
        .map((name) => join(root, dir, name))
    const files = [
      join(root, "README.md"),
      join(root, "packages/db/README.md"),
      join(root, "packages/bus/README.md"),
      ...docsIn("docs"),
      ...docsIn("packages/db/docs"),
      ...docsIn("packages/bus/docs"),
    ]
    const missing: string[] = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      const imports = new RegExp(`from "(${NAME_PATTERN}(?:/[a-z0-9-]+){0,2})"`, "g")
      for (const match of text.matchAll(imports)) {
        const specifier = match[1] as string
        if (!published.has(specifier)) missing.push(`${file.slice(root.length + 1)}: ${specifier}`)
      }
    }
    expect(missing).toEqual([])
  })

  // `GET /v1/openapi.json` publishes an `info.version`, and a document that claims a version the
  // package does not have is a small lie that a generated client carries everywhere.
  test("the version the OpenAPI documents publish is the package's", () => {
    expect(VERSION).toBe(manifest.version)
  })
})
