#!/usr/bin/env bun
/**
 * Link the repository into its own `node_modules` as `bql.sh`.
 *
 * One published package whose `exports` reach into `packages/db/src` and `packages/bus/src` — so
 * in-repo code that wants to prove a SUBPATH resolves (`test/package/exports.test.ts`, a doc
 * example run as-is) has to reach it by name, and Bun creates a self-link only for workspace
 * members, which the root manifest is not. npm does the same thing for a workspace package; this
 * does it for the root.
 *
 * Idempotent, and it never replaces a real directory — if something other than this symlink is
 * sitting there, that is a broken install to fix rather than something to overwrite.
 *
 * Not a lifecycle script. A `prepare` in the published manifest makes npm warn every consumer about
 * an install script it has to approve, for a link that means nothing outside this repository — so
 * the one test that needs it calls {@link selfLink} itself, and `bun run self-link` is here for
 * running a doc example by name.
 */
import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

/** Creates the link if it is missing. Returns true when it wrote one. */
export function selfLink(): boolean {
  const root = resolve(import.meta.dir, "..")
  const link = resolve(root, "node_modules", "bql.sh")

  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(link)
  } catch {
    // Nothing there yet, which is the ordinary case after a fresh install.
  }

  if (existing?.isSymbolicLink()) {
    if (resolve(root, "node_modules", readlinkSync(link)) === root) return false
    unlinkSync(link)
  } else if (existing) {
    throw new Error(`self-link: ${link} exists and is not a symlink — remove it and install again`)
  }

  symlinkSync("..", link, "dir")
  return true
}

if (import.meta.main) {
  console.log(selfLink() ? "self-link: node_modules/bql.sh → ." : "self-link: already linked")
}
