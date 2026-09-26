// The source documents and the resolution rules that keep the page honest: every example on the
// page is a fenced block (or table) in one of these READMEs, found by a reference that must match
// exactly one of them. A reference that matches none — or two — throws, and the build fails.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export const ROOT = join(import.meta.dir, "..", "..")

export type DocId = "root" | "db" | "bus"

export interface SourceDoc {
  id: DocId
  /** Path from the repository root. */
  path: string
  /** Heading shown in the reference page's contents column. */
  title: string
  text: string
}

export const DOCS: ReadonlyArray<Omit<SourceDoc, "text">> = [
  { id: "root", path: "README.md", title: "bql.sh" },
  { id: "db", path: "packages/db/README.md", title: "bql.sh" },
  { id: "bus", path: "packages/bus/README.md", title: "bql.sh/bus" },
]

export interface Block {
  doc: DocId
  lang: string
  code: string
  /** The heading this block sits under (its text), "" before the first heading. */
  section: string
}

export interface Table {
  doc: DocId
  section: string
  header: string[]
  rows: string[][]
}

export interface Parsed {
  docs: SourceDoc[]
  blocks: Block[]
  tables: Table[]
}

export function loadDocs(root = ROOT): SourceDoc[] {
  return DOCS.map((d) => ({ ...d, text: readFileSync(join(root, d.path), "utf8") }))
}

export function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  const cells: string[] = []
  let cur = ""
  let inCode = false
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (ch === "`") inCode = !inCode
    if (ch === "\\" && inner[i + 1] === "|") {
      cur += "|"
      i++
      continue
    }
    if (ch === "|" && !inCode) {
      cells.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

export const isTableRule = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)

export function parse(docs: SourceDoc[]): Parsed {
  const blocks: Block[] = []
  const tables: Table[] = []
  for (const doc of docs) {
    const lines = doc.text.split("\n")
    let section = ""
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const fence = /^```(\S*)\s*$/.exec(line)
      if (fence) {
        const body: string[] = []
        i++
        while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
        blocks.push({ doc: doc.id, lang: fence[1] ?? "", code: body.join("\n"), section })
        continue
      }
      const h = /^#{1,6}\s+(.*)$/.exec(line)
      if (h) section = h[1]!.trim()
      if (line.trim().startsWith("|") && isTableRule(lines[i + 1] ?? "")) {
        const header = splitRow(line)
        const rows: string[][] = []
        i += 2
        while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!))
        i--
        tables.push({ doc: doc.id, section, header, rows })
      }
    }
  }
  return { docs, blocks, tables }
}

let cached: Parsed | undefined
export const source = (): Parsed => (cached ??= parse(loadDocs()))

export interface Where {
  doc: DocId
  /** Restrict to blocks under this heading, when the same command appears twice. */
  section?: string
}

/** Strip a `$ ` prompt and a trailing `   # comment` from a command line. */
export const commandOf = (line: string) =>
  line
    .trim()
    .replace(/^\$\s+/, "")
    .replace(/\s{2,}#.*$/, "")
    .trim()

function only<T>(found: T[], what: string): T {
  if (found.length === 0) throw new Error(`reference did not resolve: ${what}`)
  if (found.length > 1) throw new Error(`reference is ambiguous (${found.length} blocks): ${what}`)
  return found[0]!
}

const inScope = (b: { doc: DocId; section: string }, w: Where) =>
  b.doc === w.doc && (w.section === undefined || b.section === w.section)

/** The one fenced block containing a line that *is* this command. */
export function resolveTerminal(cmd: string, w: Where, p: Parsed = source()): Block {
  return only(
    p.blocks.filter((b) => inScope(b, w) && b.code.split("\n").some((l) => commandOf(l) === cmd)),
    `terminal(${JSON.stringify(cmd)}) in ${w.doc}${w.section ? ` § ${w.section}` : ""}`,
  )
}

/** The one fenced block containing this text on some line. */
export function resolveSnippet(line: string, w: Where, p: Parsed = source()): Block {
  return only(
    p.blocks.filter((b) => inScope(b, w) && b.code.split("\n").some((l) => l.includes(line))),
    `snippet(${JSON.stringify(line)}) in ${w.doc}${w.section ? ` § ${w.section}` : ""}`,
  )
}

/** The one table whose header row contains this cell. */
export function resolveTable(headerCell: string, w: Where, p: Parsed = source()): Table {
  return only(
    p.tables.filter((t) => inScope(t, w) && t.header.includes(headerCell)),
    `table(${JSON.stringify(headerCell)}) in ${w.doc}`,
  )
}

/** A figure read out of one doc by regex; it must match exactly once. */
export function resolveFigure(re: RegExp, doc: DocId, p: Parsed = source()): string {
  const text = p.docs.find((d) => d.id === doc)!.text
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  const all = [...text.matchAll(g)]
  const m = only(all, `figure ${re} in ${doc}`)
  if (m[1] === undefined) throw new Error(`figure ${re} has no capture group`)
  return m[1]
}

// ---- repo counts --------------------------------------------------------------------------

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "vendor" || name.startsWith(".")) continue
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, out)
    else out.push(relative(ROOT, p))
  }
}

export type RepoCount = "testFiles" | "runtimeDependencies" | "packages"

export function repoCount(what: RepoCount, root = ROOT): number {
  const pkgs = ["packages/db", "packages/bus"]
  if (what === "packages") return pkgs.length
  if (what === "runtimeDependencies") {
    return pkgs.reduce((n, p) => {
      const pj = JSON.parse(readFileSync(join(root, p, "package.json"), "utf8"))
      return n + Object.keys(pj.dependencies ?? {}).length
    }, 0)
  }
  const files: string[] = []
  for (const p of pkgs) walk(join(root, p), files)
  return files.filter((f) => /\.test\.ts$/.test(f)).length
}

/** The one published version: `bql.sh` ships both halves, so there is one number to state. */
export function version(root = ROOT): string {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string
}
