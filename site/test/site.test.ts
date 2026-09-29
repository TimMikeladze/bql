import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { artefacts, OUT } from "../src/build.ts"
import { site } from "../src/content.ts"
import { esc, renderDoc } from "../src/markdown.ts"
import {
  BOOT, CSS, TOKENS_DARK, TOKENS_LIGHT, PAGES, linkContext, renderIndex, renderReference, resolveModel, url,
} from "../src/render.ts"
import { parse, repoCount, resolveFigure, resolveSnippet, resolveTerminal, source } from "../src/source.ts"

const m = resolveModel()
const index = renderIndex(m)
const ref = renderReference()
const read = (f: string) => readFileSync(join(OUT, f), "utf8")
const attr = (html: string, prop: string) =>
  new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`).exec(html)?.[1]

describe("references", () => {
  test("every reference resolves to exactly one block (resolveModel throws otherwise)", () => {
    expect(m.capabilities.length).toBeGreaterThanOrEqual(4)
  })
  test("a missing or ambiguous reference throws", () => {
    const p = parse([{ id: "db", path: "x", title: "x", text: "```sh\nfoo\n```\n\n```sh\nfoo\n```\n" }])
    expect(() => resolveTerminal("bar", { doc: "db" }, p)).toThrow(/did not resolve/)
    expect(() => resolveSnippet("foo", { doc: "db" }, p)).toThrow(/ambiguous/)
  })
  test("figures match their sources", () => {
    const figs = [...site.figures, ...site.measured.figures]
    const rendered = [...m.figures, ...m.measuredFigures]
    figs.forEach((f, i) => {
      const want = f.from.kind === "count" ? String(repoCount(f.from.count)) : resolveFigure(f.from.re, f.from.doc)
      expect(rendered[i]!.value).toBe(want)
      expect(index).toContain(`<b>${esc(want)}</b>`)
    })
  })
  test("showcase tabs and guides are resolved snippets", () => {
    for (const t of m.tabs) expect(index).toContain(esc(t.block.code.split("\n")[0]!))
    expect(m.guides).toHaveLength(3)
  })
})

describe("self-contained and themed", () => {
  for (const [name, html] of [["index", index], ["reference", ref.html]] as const) {
    test(`${name}: no remote assets, two inline scripts at most`, () => {
      // Canonical and alternate links point at the site's own origin; nothing else may be remote.
      expect(html).not.toMatch(/<link[^>]+href="https?:(?![^"]*bql\.sh)/)
      expect(html).not.toMatch(/src="http/)
      const scripts = [...html.matchAll(/<script(?![^>]*ld\+json)[^>]*>/g)]
      expect(scripts.length).toBe(2)
      expect(html.match(/<style>/g)?.length).toBe(1)
      expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<style>"))
    })
  }
  test("boot script is short and keyed; tokens and fallback present", () => {
    expect(BOOT.split("\n").length).toBeLessThan(30)
    expect(BOOT).toContain(JSON.stringify(site.themeKey))
    expect(CSS).toContain(':root[data-theme="light"]')
    expect(CSS).toContain(':root:not([data-theme="dark"]):not([data-theme="light"])')
    expect(index).toMatch(/<header[\s\S]*data-theme-cycle[\s\S]*<\/header>/)
    for (const p of ["system", "light", "dark"]) expect(index).toContain(`data-theme-set="${p}"`)
  })
  test("body and soft pass 4.5:1 in both schemes", () => {
    // Achromatic OKLCH: relative luminance is L³.
    const ratio = (a: number, b: number) => {
      const [x, y] = [(a / 100) ** 3, (b / 100) ** 3].sort((p, q) => q - p)
      return (x! + 0.05) / (y! + 0.05)
    }
    for (const t of [TOKENS_DARK, TOKENS_LIGHT]) {
      expect(ratio(t.body, t.paper)).toBeGreaterThan(4.5)
      expect(ratio(t.soft, t.paper)).toBeGreaterThan(4.5)
    }
  })
})

test("markup in a source doc is escaped", () => {
  const r = renderDoc("<script>alert(1)</script> and `<b>`\n\n```html\n<img src=x onerror=1>\n```", linkContext(), "t")
  expect(r.html).not.toContain("<script>")
  expect(r.html).not.toContain("<img")
  expect(r.html).toContain("&lt;script&gt;")
})

test("committed artefacts equal a fresh render", () => {
  for (const [name, body] of Object.entries(artefacts())) expect(read(name)).toBe(body)
})

test("every source section reaches the reference page; cross-page anchors land", () => {
  const text = ref.html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  for (const d of source().docs) {
    let inFence = false
    for (const line of d.text.split("\n")) {
      if (/^```/.test(line)) inFence = !inFence
      else if (!inFence && /^#{1,6} /.test(line)) expect(text).toContain(line.replace(/^#+\s+/, "").replace(/[`*]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"))
    }
  }
  for (const [, id] of index.matchAll(/href="\/reference#([^"]+)"/g)) expect(ref.ids).toContain(id!)
})

test("head metadata", () => {
  expect(index).toContain(`<title>${esc(site.title)}</title>`)
  expect(attr(index, "description")!.length).toBeLessThanOrEqual(160)
  expect(index).toContain(`<link rel="canonical" href="${site.origin}/">`)
  expect(ref.html).toContain(`<link rel="canonical" href="${site.origin}/reference">`)
  expect(index).not.toContain("index.html")
  for (const k of ["og:title", "og:description", "og:url", "og:type", "og:site_name", "og:image:alt", "twitter:card"]) expect(attr(index, k)).toBeTruthy()
  expect(attr(index, "og:image")).toBe(url("/og.png"))
  expect(attr(index, "og:image:width")).toBe("1200")
  expect(attr(index, "og:image:height")).toBe("630")
  expect(attr(index, "og:image:type")).toBe("image/png")
  expect(attr(index, "twitter:image")).toBe(url("/og.png"))
  const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(index)![1]!)
  expect(ld.name).toBe(site.name)
  expect(ld.softwareVersion).toBe(m.version)
})

test("every capability section has id, h2, 1–3 sentences with inline code", () => {
  for (const c of site.capabilities) {
    const sec = new RegExp(`<section[^>]*id="${c.id}" aria-labelledby="${c.id}-h">[\\s\\S]*?<h2 id="${c.id}-h">[\\s\\S]*?<p class="explain">([\\s\\S]*?)</p>`).exec(index)
    expect(sec).toBeTruthy()
    const sentences = sec![1]!.replace(/<code>.*?<\/code>/g, "x").split(/[.](\s|$)/).filter((s) => s.trim().length > 1)
    expect(sentences.length).toBeGreaterThanOrEqual(1)
    expect(sentences.length).toBeLessThanOrEqual(2) // terse by design: the artefact carries the rest
    expect(sec![1]).toContain("<code>")
  }
})

test("agent files exist and the sitemap names only built files", () => {
  for (const f of ["llms.txt", "AGENTS.md", "sitemap.xml", "robots.txt", "index.md", "favicon.svg"]) expect(existsSync(join(OUT, f))).toBe(true)
  for (const [, loc] of read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const p = new URL(loc!).pathname
    const file = p === "/" ? "index.html" : /\.\w+$/.test(p) ? p.slice(1) : `${p.slice(1)}.html`
    expect(existsSync(join(OUT, file))).toBe(true)
  }
  expect(PAGES.length).toBeGreaterThan(0)
  expect(read("robots.txt")).toContain(url("/sitemap.xml"))
})

test("og.png is a real 1200×630 PNG", () => {
  const b = readFileSync(join(OUT, "og.png"))
  expect(b.subarray(1, 4).toString()).toBe("PNG")
  expect(b.readUInt32BE(16)).toBe(1200)
  expect(b.readUInt32BE(20)).toBe(630)
})

test("links: header github, x, linkedin in order; footer adds discord", () => {
  const icons = /<div class="icons">([\s\S]*?)<\/div>/.exec(index)![1]!
  const names = [...icons.matchAll(/<span class="sr">([^<]+)<\/span>/g)].map((x) => x[1])
  expect(names).toEqual(["TimMikeladze/bql on GitHub", "linesofcode on X", "linesofcode on LinkedIn"])
  expect(icons).toContain('href="https://www.linkedin.com/in/tim-mikeladze"')
  const foot = /<div class="foot-icons">([\s\S]*?)<\/div>/.exec(index)![1]!
  expect([...foot.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual([
    site.repo, "https://x.com/linesofcode", "https://www.linkedin.com/in/tim-mikeladze", "https://discord.com/users/linesofcode",
  ])
  expect(/<nav class="nav"[\s\S]*?<\/nav>/.exec(index)![0]).not.toContain("class=\"brand\"")
})

test("hero is centred with both audience panels", () => {
  expect(CSS).toMatch(/\.hero \{[^}]*text-align: center/)
  expect(index).toContain('data-panel="humans"')
  expect(index).toContain('data-panel="agents"')
  expect(m.humans.code).toContain(site.install.humans.cmd)
  const agents = /data-panel="agents">([\s\S]*?)<\/div><\/div>/.exec(index)![1]!
  for (const [, h] of agents.matchAll(/href="\/([^"]+)"/g)) expect(existsSync(join(OUT, h!))).toBe(true)
})

test("New pills carry a release date within 90 days", () => {
  for (const c of site.footer) for (const l of c.links) if (l.released) {
    expect(Date.now() - Date.parse(l.released)).toBeLessThan(90 * 864e5)
  }
})

test("chapter rules open each group, and the nav anchors land on them", () => {
  for (const c of Object.values(site.chapters)) expect(index).toContain(`<div class="chapter" id="${c.id}">`)
  for (const [, id] of index.matchAll(/href="\/#([^"]+)"/g)) expect(index).toContain(`id="${id}"`)
  const order = site.capabilities.map((c) => index.indexOf(`id="${c.id}"`))
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(index.indexOf('id="database"')).toBeLessThan(index.indexOf(`id="${site.capabilities[0]!.id}"`))
})

test("pairs render both artefacts", () => {
  for (const { cap, demo } of m.capabilities) if (demo.kind === "pair") {
    const sec = new RegExp(`id="${cap.id}"[\\s\\S]*?</section>`).exec(index)![0]
    expect(sec).toContain('class="pair')
    for (const f of demo.items) expect(sec).toContain(f.kind === "terminal" ? `$ ${esc(f.cmd)}` : f.kind === "snippet" ? `>${esc(f.label)}<` : "<table")
  }
})
