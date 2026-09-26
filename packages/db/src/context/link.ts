import { appendFile, mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { atomicJson, readJson } from "./store.ts"
import { validateLink, type ProjectLink } from "./model.ts"
export type FoundLink = ProjectLink & { directory: string }
export async function findLink(cwd: string): Promise<FoundLink | null> {
  let directory = resolve(cwd)
  while (true) {
    const value = await readJson(join(directory, ".bql", "project.json"))
    if (value !== undefined) {
      validateLink(value)
      return { ...value, directory }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}
export async function writeLink(
  directory: string,
  link: ProjectLink,
): Promise<void> {
  validateLink(link)
  await mkdir(join(directory, ".bql"), { recursive: true })
  const ignore = join(directory, ".gitignore")
  let existing = ""
  try {
    existing = await readFile(ignore, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
  if (
    !existing
      .split(/\r?\n/)
      .some((l) => [".bql/", "/.bql/", ".bql"].includes(l.trim()))
  )
    await appendFile(
      ignore,
      `${existing && !existing.endsWith("\n") ? "\n" : ""}.bql/\n`,
    )
  await atomicJson(join(directory, ".bql", "project.json"), link)
}
export async function unlinkProject(cwd: string): Promise<void> {
  const found = await findLink(cwd)
  if (!found) throw new Error("No linked BQL project; run bql link first")
  await rm(join(found.directory, ".bql", "project.json"))
}
