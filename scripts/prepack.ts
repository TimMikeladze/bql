#!/usr/bin/env bun
/**
 * Point the manifest at `dist/` for publishing, and put it back afterwards.
 *
 * The checked-in manifest points at `src/` so the repo runs straight from
 * TypeScript and a `file:` dependency in a sibling checkout type-checks
 * without a build. What gets published has to point at `dist/`, because
 * `files: ["dist"]` is the only thing in the tarball.
 *
 * `prepack` rewrites, `postpack` restores from the backup — so a normal
 * `npm publish` leaves the working tree exactly as it found it. If a publish
 * dies between the two, `package.json.orig` is still on disk and the fix is
 * `bun scripts/prepack.ts --restore`.
 */
import { rm } from "node:fs/promises";

const MANIFEST = "package.json";
const BACKUP = "package.json.orig";

function toDist(path: string, kind: "js" | "dts"): string {
  const stripped = path.replace(/^\.\/src\//, "").replace(/\.ts$/, "");
  return kind === "js" ? `./dist/${stripped}.js` : `./dist/${stripped}.d.ts`;
}

const isSource = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("./src/");

/**
 * npm's manifest normalizer silently DROPS a `bin` entry whose path starts
 * with `./` — the package publishes fine and installs with no binary at all.
 * Bun reads the tarball's manifest directly and is unaffected, so this only
 * ever shows up for an npm, pnpm or yarn consumer.
 */
const binPath = (path: string) => path.replace(/^\.\//, "");

export function distManifest(
  pkg: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...pkg };
  if (isSource(pkg.module)) out.module = toDist(pkg.module, "js");
  if (isSource(pkg.types)) out.types = toDist(pkg.types, "dts");

  if (isSource(pkg.bin)) out.bin = binPath(toDist(pkg.bin, "js"));
  else if (pkg.bin !== null && typeof pkg.bin === "object") {
    const bins: Record<string, unknown> = {};
    for (const [name, target] of Object.entries(
      pkg.bin as Record<string, unknown>,
    ))
      bins[name] = isSource(target) ? binPath(toDist(target, "js")) : target;
    out.bin = bins;
  }

  const exported = pkg.exports;
  if (exported !== null && typeof exported === "object") {
    const rewritten: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      exported as Record<string, unknown>,
    )) {
      if (isSource(value)) {
        rewritten[key] = toDist(value, "js");
        continue;
      }
      if (value !== null && typeof value === "object") {
        const entry = value as {
          import?: { types?: unknown; default?: unknown };
        };
        if (entry.import !== undefined) {
          rewritten[key] = {
            import: {
              types: isSource(entry.import.types)
                ? toDist(entry.import.types, "dts")
                : entry.import.types,
              default: isSource(entry.import.default)
                ? toDist(entry.import.default, "js")
                : entry.import.default,
            },
          };
          continue;
        }
      }
      rewritten[key] = value;
    }
    out.exports = rewritten;
  }
  return out;
}

if (import.meta.main) {
  if (process.argv.includes("--restore")) {
    const backup = Bun.file(BACKUP);
    if (await backup.exists()) {
      await Bun.write(MANIFEST, await backup.text());
      await rm(BACKUP, { force: true });
      console.log("restored package.json");
    }
  } else {
    const original = await Bun.file(MANIFEST).text();
    await Bun.write(BACKUP, original);
    const pkg = JSON.parse(original) as Record<string, unknown>;
    await Bun.write(
      MANIFEST,
      `${JSON.stringify(distManifest(pkg), null, 2)}\n`,
    );
    console.log("package.json now points at dist/");
  }
}
