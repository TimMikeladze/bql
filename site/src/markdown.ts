// A small Markdown renderer for the READMEs: headings, fenced code, tables, lists, paragraphs,
// images (as links), inline code, emphasis and links. Everything is escaped first — markup in a
// source doc is shown, never executed.

import { isTableRule, splitRow, type DocId } from "./source.ts"

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** GitHub-style heading slug. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-")
}

export interface LinkContext {
  /** Doc being rendered, to resolve relative links against. */
  doc?: { id: DocId; path: string }
  /** Maps a repo path (e.g. "packages/db/README.md") to a reference-page anchor prefix. */
  anchorFor?: (repoPath: string, hash: string) => string | undefined
  repo: string
}

function normalise(base: string, rel: string): string {
  const parts = base.split("/").slice(0, -1)
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop()
    else if (seg !== "." && seg !== "") parts.push(seg)
  }
  return parts.join("/")
}

export function resolveHref(href: string, ctx: LinkContext): string {
  if (/^(https?:|mailto:)/.test(href)) return href
  const [path = "", hash = ""] = href.split("#")
  if (!ctx.doc) return href
  if (path === "") return ctx.anchorFor?.(ctx.doc.path, hash) ?? `#${hash}`
  let target = normalise(ctx.doc.path, path)
  const asReadme = target.endsWith(".md") ? target : `${target}/README.md`
  const anchor = ctx.anchorFor?.(asReadme === "README.md/README.md" ? "README.md" : asReadme, hash)
  if (anchor) return anchor
  const kind = /\.[a-z0-9]+$/i.test(target) ? "blob" : "tree"
  return `${ctx.repo}/${kind}/main/${target}${hash ? `#${hash}` : ""}`
}

export function inline(md: string, ctx: LinkContext = { repo: "" }): string {
  const codes: string[] = []
  let s = md.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = esc(s)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, href: string) =>
    `<a href="${esc(resolveHref(href, ctx))}">${alt} (image)</a>`,
  )
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => {
    const h = resolveHref(href.replace(/&amp;/g, "&"), ctx)
    const ext = /^https?:/.test(h) ? ' rel="noopener"' : ""
    return `<a href="${esc(h)}"${ext}>${text}</a>`
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
  s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:]|$)/g, "$1<em>$2</em>")
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!)
}

// ---- syntax colouring --------------------------------------------------------------------

const KW = new Set(
  "import from export const let var await async function return if else for of in new throw type interface extends class true false null undefined as satisfies".split(" "),
)

/** A deliberately small highlighter: comments, strings, keywords, numbers. Output is escaped. */
export function highlight(code: string, lang: string): string {
  const shellish = /^(sh|bash|shell|toml|yaml|http|)$/.test(lang)
  const re = shellish
    ? /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|(\b\d[\d_.]*\b)/g
    : /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.n]*\b)|(\b[A-Za-z_]\w*\b)/g
  let out = ""
  let last = 0
  for (const m of code.matchAll(re)) {
    const i = m.index!
    // In shell, `#` only starts a comment at the start of a word.
    if (shellish && m[1] && i > 0 && !/\s/.test(code[i - 1]!)) continue
    out += esc(code.slice(last, i))
    const t = esc(m[0])
    if (m[1]) out += `<span class="t-c">${t}</span>`
    else if (m[2]) out += `<span class="t-s">${t}</span>`
    else if (m[3]) out += `<span class="t-n">${t}</span>`
    else if (m[4] && KW.has(m[4])) out += `<span class="t-k">${t}</span>`
    else out += t
    last = i + m[0].length
  }
  return out + esc(code.slice(last))
}

// ---- blocks -------------------------------------------------------------------------------

export interface Heading {
  level: number
  text: string
  id: string
}

export interface Rendered {
  html: string
  headings: Heading[]
}

/** Render a whole document. `idPrefix` namespaces heading ids so three READMEs can share a page. */
export function renderDoc(md: string, ctx: LinkContext, idPrefix: string, shift = 0): Rendered {
  const lines = md.split("\n")
  const out: string[] = []
  const headings: Heading[] = []
  const seen = new Map<string, number>()
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "), ctx)}</p>`)
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      const lang = fence[1] ?? ""
      out.push(`<pre class="code" data-lang="${esc(lang)}"><code>${highlight(body.join("\n"), lang)}</code></pre>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const level = Math.min(6, h[1]!.length + shift)
      const text = h[2]!.trim()
      const base = slug(text)
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      const id = `${idPrefix}-${n ? `${base}-${n}` : base}`
      headings.push({ level, text, id })
      out.push(`<h${level} id="${id}">${inline(text, ctx)}</h${level}>`)
      continue
    }
    if (line.trim().startsWith("|") && isTableRule(lines[i + 1] ?? "")) {
      flush()
      const header = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!))
      i--
      out.push(renderTable(header, rows, ctx))
      continue
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const ordered = /\d/.test(li[2]!)
      const items: string[] = []
      let cur = li[3]!
      i++
      for (; i < lines.length; i++) {
        const l = lines[i]!
        const next = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(l)
        if (next) {
          items.push(cur)
          cur = next[2]!
        } else if (l.trim() !== "" && /^\s+/.test(l)) cur += " " + l.trim()
        else break
      }
      items.push(cur)
      i--
      const tag = ordered ? "ol" : "ul"
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x, ctx)}</li>`).join("")}</${tag}>`)
      continue
    }
    if (line.trim() === "") flush()
    else para.push(line.trim())
  }
  flush()
  return { html: out.join("\n"), headings }
}

export function renderTable(header: string[], rows: string[][], ctx: LinkContext = { repo: "" }): string {
  const th = header.map((c) => `<th scope="col">${inline(c, ctx)}</th>`).join("")
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`).join("")
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`
}
