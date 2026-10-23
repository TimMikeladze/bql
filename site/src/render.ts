// The renderer: resolves the model's references against the READMEs, then emits the landing page,
// the reference page, their Markdown twins and the agent/SEO artefacts. No copy lives here —
// markup, styles, icons and the two small scripts do.

import { site, type Capability, type Chapter, type Demo, type Frame, type IconName } from "./content.ts"
import { brand, brandTone, faviconSvg, glyph, heroObject, productMark } from "./icons.ts"
import { esc, highlight, inline, renderDoc, renderTable, slug, type LinkContext } from "./markdown.ts"
import {
  DOCS, resolveSnippet, resolveTable, resolveTerminal, source, version,
  type Block, type Parsed, type Table,
} from "./source.ts"

// ---- URLs ---------------------------------------------------------------------------------

/** Every absolute URL comes through here: clean URLs, trailing slash on the home page only. */
export function url(path: string): string {
  const p = path === "" || path === "/" || path === "/index.html" ? "/" : path.replace(/\.html$/, "")
  return site.origin + p
}

export const repoHref = (href: string) => (href === "repo" ? site.repo : href)
const isExternal = (href: string) => /^https?:/.test(repoHref(href))

// ---- resolution ---------------------------------------------------------------------------

export type ResolvedFrame =
  | { kind: "terminal"; cmd: string; block: Block }
  | { kind: "snippet"; label: string; block: Block }
  | { kind: "table"; table: Table }

export type ResolvedDemo =
  | ResolvedFrame
  | { kind: "pair"; items: [ResolvedFrame, ResolvedFrame] }
  | { kind: "variants"; items: { label: string; caption: string; block: Block }[] }
  | { kind: "cell"; label: string; code: Block; cmd: string; run: Block }

function resolveFrame(d: Frame, p: Parsed): ResolvedFrame {
  switch (d.kind) {
    case "terminal":
      return { kind: "terminal", cmd: d.cmd, block: resolveTerminal(d.cmd, d.where, p) }
    case "snippet":
      return { kind: "snippet", label: d.label, block: resolveSnippet(d.line, d.where, p) }
    case "table":
      return { kind: "table", table: resolveTable(d.header, d.where, p) }
  }
}

export function resolveDemo(d: Demo, p: Parsed = source()): ResolvedDemo {
  switch (d.kind) {
    case "terminal":
    case "snippet":
    case "table":
      return resolveFrame(d, p)
    case "pair":
      return { kind: "pair", items: [resolveFrame(d.items[0], p), resolveFrame(d.items[1], p)] }
    case "variants":
      return {
        kind: "variants",
        items: d.items.map((i) => ({ label: i.label, caption: i.caption, block: resolveSnippet(i.line, i.where, p) })),
      }
    case "cell":
      return {
        kind: "cell",
        label: d.code.label,
        code: resolveSnippet(d.code.line, d.code.where, p),
        cmd: d.run.cmd,
        run: resolveTerminal(d.run.cmd, d.run.where, p),
      }
  }
}

export function resolveModel(p: Parsed = source()) {
  return {
    humans: resolveTerminal(site.install.humans.cmd, site.install.humans.where, p),
    hero: resolveDemo(site.hero, p) as Extract<ResolvedDemo, { kind: "cell" }>,
    compare: resolveTable(site.compare.table.header, site.compare.table.where, p),
    tabs: site.showcase.tabs.map((t) => ({ ...t, block: resolveSnippet(t.line, t.where, p) })),
    capabilities: site.capabilities.map((c) => ({ cap: c as Capability, demo: resolveDemo(c.demo, p) })),
    cta: resolveTerminal(site.cta.cmd, site.cta.where, p),
    version: version(),
  }
}
export type Model = ReturnType<typeof resolveModel>

// ---- reference anchors --------------------------------------------------------------------

const DOC_PREFIX: Record<string, string> = { "README.md": "root", "packages/db/README.md": "db", "packages/bus/README.md": "bus" }

export function linkContext(docPath?: string, forReference = false): LinkContext {
  const doc = docPath ? DOCS.find((d) => d.path === docPath) : undefined
  return {
    repo: site.repo,
    doc: doc ? { id: doc.id, path: doc.path } : undefined,
    anchorFor: (path, hash) => {
      const prefix = DOC_PREFIX[path]
      if (!prefix) return undefined
      const id = hash ? `${prefix}-${hash}` : prefix
      return forReference ? `#${id}` : `/reference#${id}`
    },
  }
}

// ---- styles -------------------------------------------------------------------------------

export const TOKENS_DARK = {
  paper: 9, band: 12, raise: 15.5, ink: 98.5, body: 78, soft: 60,
}
export const TOKENS_LIGHT = {
  paper: 99, band: 97, raise: 100, ink: 14.5, body: 38, soft: 48,
}

const LIGHT_VARS = `color-scheme: light;
  --paper: oklch(${TOKENS_LIGHT.paper}% 0.004 265); --band: oklch(${TOKENS_LIGHT.band}% 0.005 265); --raise: oklch(${TOKENS_LIGHT.raise}% 0 0);
  --ink: oklch(${TOKENS_LIGHT.ink}% 0.01 265); --body: oklch(${TOKENS_LIGHT.body}% 0.01 265); --soft: oklch(${TOKENS_LIGHT.soft}% 0.01 265);
  --line: oklch(0% 0 0 / .12); --line-soft: oklch(0% 0 0 / .06);
  --accent: oklch(52% 0.13 215); --accent-soft: oklch(52% 0.13 215 / .09); --glow: oklch(75% 0.09 215 / .16); --grid: oklch(0% 0 0 / .045);
  --add: oklch(50% 0.16 150); --del: oklch(50% 0.19 25); --warn: oklch(55% 0.13 80);
  --t-k: oklch(48% 0.12 285); --t-s: oklch(48% 0.09 165); --t-c: oklch(58% 0.015 265); --t-n: oklch(52% 0.1 60);
  --t-f: oklch(45% 0.1 230); --t-t: oklch(50% 0.09 75); --t-p: oklch(50% 0.08 205);`

export const CSS = `
:root {
  color-scheme: dark;
  --paper: oklch(${TOKENS_DARK.paper}% 0.006 265);
  --band: oklch(${TOKENS_DARK.band}% 0.008 265);
  --raise: oklch(${TOKENS_DARK.raise}% 0.009 265);
  --ink: oklch(${TOKENS_DARK.ink}% 0.004 265);
  --body: oklch(${TOKENS_DARK.body}% 0.01 265);
  --soft: oklch(${TOKENS_DARK.soft}% 0.012 265);
  --line: oklch(100% 0 0 / .11);
  --line-soft: oklch(100% 0 0 / .06);
  --accent: oklch(80% 0.11 205); --accent-soft: oklch(80% 0.11 205 / .1); --glow: oklch(65% 0.11 220 / .16); --grid: oklch(100% 0 0 / .035);
  --add: oklch(72% 0.17 150);
  --del: oklch(68% 0.19 20);
  --warn: oklch(78% 0.15 85);
  --t-k: oklch(76% 0.09 290); --t-s: oklch(80% 0.08 165); --t-c: oklch(56% 0.015 265); --t-n: oklch(82% 0.08 70);
  --t-f: oklch(84% 0.07 225); --t-t: oklch(86% 0.07 85); --t-p: oklch(80% 0.06 205);
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "New York", ui-serif, Georgia, serif;
}
:root[data-theme="light"] { ${LIGHT_VARS} }
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]):not([data-theme="light"]) { ${LIGHT_VARS} }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-padding-top: 4.5rem; }
body { margin: 0; background: var(--paper); color: var(--body); font: 1rem/1.6 var(--sans); overflow-x: hidden; }
a { color: inherit; }
h1, h2, h3, h4 { color: var(--ink); margin: 0; }
p { margin: 0; }
code { font: .9em var(--mono); color: var(--ink); background: color-mix(in oklab, var(--raise), var(--ink) 6%); padding: .1em .32em; border-radius: .28rem; }
pre code { background: none; padding: 0; color: inherit; border-radius: 0; font-size: inherit; }
.prose a, .lede a, .explain a, .credit a { color: var(--ink); text-decoration: underline; text-underline-offset: .18em; text-decoration-color: var(--line); transition: text-decoration-color .14s ease; }
.prose a:hover, .lede a:hover, .explain a:hover, .credit a:hover { text-decoration-color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.skip { position: absolute; left: -999px; top: .5rem; z-index: 10; background: var(--ink); color: var(--paper); padding: .5rem .8rem; border-radius: .4rem; }
.skip:focus { left: .5rem; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.shell { width: min(1180px, calc(100% - 3rem)); margin-inline: auto; }
.brand, .glyph { flex: none; display: block; }
.ext { font-size: .75em; opacity: .5; margin-left: .15em; }

/* header */
.site-header { position: sticky; top: 0; z-index: 5; min-height: 3.75rem; display: flex; align-items: center;
  background: color-mix(in oklab, var(--paper) 72%, transparent); backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4);
  border-bottom: 1px solid var(--line-soft); }
.site-header .shell { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 1.5rem; }
.header-cta { padding: .45rem .95rem; font-size: .85rem; }
.wordmark { font-weight: 700; font-size: 1.05rem; color: var(--ink); text-decoration: none; letter-spacing: -.01em; }
.nav { display: flex; gap: 1.1rem; }
.nav a { font-size: .875rem; color: var(--soft); text-decoration: none; transition: color .14s ease; }
.nav a:hover, .nav a[aria-current="page"] { color: var(--ink); }
.icons { justify-self: end; display: flex; align-items: center; gap: .75rem; }
.icons a, .icon-btn { color: var(--soft); display: inline-flex; padding: .25rem; transition: color .14s ease; }
.icons a:hover, .icon-btn:hover { color: var(--ink); }
.icon-btn { background: none; border: 1px solid var(--line); border-radius: .6rem; padding: .4rem; cursor: pointer; }
.theme-toggle .glyph { display: none; }
:root:not([data-pref]) .theme-toggle .g-system, :root[data-pref="system"] .theme-toggle .g-system,
:root[data-pref="dark"] .theme-toggle .g-dark, :root[data-pref="light"] .theme-toggle .g-light { display: block; }

/* hero: copy on the left, the object on the right, a cool glow behind both */
.hero-wrap { position: relative; isolation: isolate; overflow: clip; }
.hero-wrap::before { content: ""; position: absolute; z-index: -1; inset: 0; pointer-events: none;
  background: radial-gradient(40% 55% at 72% 38%, var(--glow), transparent 70%), radial-gradient(60% 50% at 20% 0%, oklch(100% 0 0 / .035), transparent 70%); }
.hero { padding-block: clamp(4rem, 9vw, 7.5rem) clamp(3rem, 6vw, 5rem); }
.hero-grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 3rem; align-items: center; }
.badge { display: inline-flex; align-items: center; gap: .45rem; padding: .32rem .8rem; border-radius: 999px; font-size: .82rem; color: var(--ink); text-decoration: none;
  background: var(--raise); border: 1px solid var(--line); transition: border-color .14s ease; }
.badge:hover { border-color: color-mix(in oklab, var(--accent) 50%, transparent); }
.badge span { color: var(--soft); }
.hero h1 { margin-top: 1.6rem; font: 400 clamp(3rem, 6vw, 5rem)/1.02 var(--serif); letter-spacing: -.025em; max-width: 17ch; text-wrap: balance;
  background: linear-gradient(180deg, var(--ink) 40%, color-mix(in oklab, var(--ink) 72%, var(--paper))); -webkit-background-clip: text; background-clip: text; color: transparent; padding-bottom: .08em; }
.lede { margin-top: 1.4rem; font-size: clamp(1.02rem, 1.4vw, 1.15rem); line-height: 1.65; max-width: 54ch; color: var(--body); }
.acts { margin-top: 2rem; display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
.btn { display: inline-flex; align-items: center; gap: .5rem; padding: .7rem 1.25rem; border-radius: 999px; font: 550 .95rem/1 var(--sans); color: var(--ink); text-decoration: none;
  background: linear-gradient(180deg, color-mix(in oklab, var(--raise), var(--ink) 8%), var(--raise)); border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 oklch(100% 0 0 / .08); transition: border-color .14s ease; }
.btn:hover { border-color: color-mix(in oklab, var(--ink) 30%, transparent); }
.btn-ghost { padding: .7rem 1rem; font: 500 .95rem/1 var(--sans); color: var(--body); text-decoration: none; transition: color .14s ease; }
.btn-ghost:hover { color: var(--ink); }
.aud { margin-top: 2.2rem; display: flex; flex-direction: column; align-items: flex-start; }
.aud > input { position: absolute; opacity: 0; pointer-events: none; }
.aud-tabs { display: flex; font-size: .8rem; }
.aud-tabs label { cursor: pointer; color: var(--soft); padding: 0 .8rem; transition: color .14s ease; }
.aud-tabs label:first-child { padding-left: 0; }
.aud-tabs label + label { border-left: 1px solid var(--line); }
#aud-h:checked ~ .aud-tabs label[for="aud-h"], #aud-a:checked ~ .aud-tabs label[for="aud-a"] { color: var(--ink); }
#aud-h:focus-visible ~ .aud-tabs label[for="aud-h"], #aud-a:focus-visible ~ .aud-tabs label[for="aud-a"] { outline: 2px solid var(--accent); outline-offset: 3px; }
.aud-panel { display: none; margin-top: .8rem; flex-direction: column; align-items: flex-start; gap: .7rem; max-width: 100%; }
#aud-h:checked ~ .p-h, #aud-a:checked ~ .p-a { display: flex; }
.pill { display: inline-flex; align-items: center; gap: .6rem; max-width: 100%; border-radius: 999px; background: var(--band); border: 1px solid var(--line); padding: .5rem .55rem .5rem 1.05rem; color: var(--ink); }
.pill .prompt { color: var(--accent); font: .88rem/1.3 var(--mono); }
.pill code { font: .88rem/1.3 var(--mono); background: none; padding: 0; overflow-wrap: anywhere; text-align: left; }
.copy { background: none; border: 0; color: var(--soft); cursor: pointer; padding: .3rem; border-radius: 999px; display: inline-flex; transition: color .14s ease; }
.copy:hover { color: var(--ink); }
.agent-links { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; font-size: .85rem; }
.agent-links a, .agent-links button { color: var(--soft); background: none; border: 0; font: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: .18em; text-decoration-color: var(--line); padding: 0; }
.agent-links a:hover, .agent-links button:hover { color: var(--ink); }
.version { margin-top: 1rem; font-size: .8rem; color: var(--soft); font-family: var(--mono); }
.hero-art { display: grid; place-items: center; }
.hero-object { width: min(100%, 26rem); height: auto; filter: drop-shadow(0 40px 60px oklch(0% 0 0 / .5)); }
.mark { display: inline-grid; place-items: center; background: var(--raise); border: 1px solid var(--line); border-radius: .8rem; color: var(--accent); }

/* sections: space separates them, not bands */
.section { padding-block: clamp(4.5rem, 9vw, 8rem); scroll-margin-top: 4rem; }
.shead { max-width: 46rem; }
.shead.centre { margin-inline: auto; text-align: center; max-width: 54rem; }
.shead h2 { font: 500 clamp(2.1rem, 4.6vw, 3.4rem)/1.08 var(--sans); letter-spacing: -.04em; color: var(--ink); }
.shead h2 .mute { color: var(--soft); }
.shead .explain { margin-top: 1rem; font-size: 1.05rem; color: var(--body); max-width: 58ch; }
.shead.centre .explain { margin-inline: auto; }
.explain a { color: var(--ink); text-decoration: underline; text-underline-offset: .18em; text-decoration-color: var(--line); }
.explain a:hover { text-decoration-color: var(--accent); }
.demo { margin-top: 1.6rem; }

/* the glossy tile above a centred head */
.tile { width: 5.5rem; height: 5.5rem; margin: 0 auto 2.2rem; display: grid; place-items: center; border-radius: 1.4rem; color: var(--ink); position: relative;
  background: radial-gradient(120% 90% at 30% 10%, oklch(100% 0 0 / .14), transparent 55%), linear-gradient(160deg, color-mix(in oklab, var(--raise), var(--ink) 10%), var(--paper));
  border: 1px solid var(--line); box-shadow: inset 0 1px 0 oklch(100% 0 0 / .12), 0 24px 40px -12px oklch(0% 0 0 / .6); }
.tile::after { content: ""; position: absolute; left: 18%; right: 18%; bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); filter: blur(1px); opacity: .9; }
.tile::before { content: ""; position: absolute; inset: auto 10% -18px; height: 26px; background: var(--glow); filter: blur(14px); z-index: -1; }

/* logos strip */
.logos { padding-block: 2rem 4rem; text-align: center; }
.logos-h { font: 500 1.05rem/1.4 var(--sans); color: var(--body); letter-spacing: 0; }
.logos-p { margin: .4rem auto 0; max-width: 58ch; color: var(--soft); font-size: .92rem; }
.marks { margin-top: 2.2rem; display: flex; flex-wrap: wrap; justify-content: center; gap: 2.4rem; }
.marks a { color: var(--soft); transition: color .14s ease; }
.marks a:hover { color: var(--brand); }
:root:not([data-theme="light"]) .marks a.tone-dark:hover { color: var(--ink); }
:root[data-theme="light"] .marks a.tone-light:hover { color: var(--ink); }

/* overview: icon, title, two lines */
.grid9 { margin-top: 4rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3.2rem 3rem; }
.gi .glyph { color: var(--ink); }
.gi h3 { margin-top: .9rem; font: 500 1.15rem/1.3 var(--sans); letter-spacing: -.01em; }
.gi p { margin-top: .5rem; color: var(--soft); font-size: .95rem; line-height: 1.6; }

/* windows: product chrome around real code */
.window { border: 1px solid var(--line); border-radius: 1.1rem; overflow: hidden; background: linear-gradient(180deg, color-mix(in oklab, var(--band), var(--ink) 2%), var(--paper));
  box-shadow: inset 0 1px 0 oklch(100% 0 0 / .05); }
.win-bar { display: flex; align-items: center; gap: .7rem; padding: .7rem 1rem; border-bottom: 1px solid var(--line-soft); font: .8rem/1 var(--mono); color: var(--soft); }
.win-bar .copy { margin-left: auto; }
.win-title, .win-file { color: var(--body); display: inline-flex; align-items: center; gap: .45rem; }
.win-body { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); }
.win-foot { display: flex; gap: 1.4rem; padding: .9rem 1.2rem; border-top: 1px solid var(--line-soft); font-size: .8rem; }
.win-foot a { display: inline-flex; align-items: center; gap: .4rem; color: var(--soft); text-decoration: none; }
.win-foot a:hover { color: var(--ink); }
#live .window { margin-top: 3.5rem; }

pre.code-n { margin: 0; padding: 1.1rem 1.2rem 1.2rem .4rem; font: .8rem/1.75 var(--mono); color: var(--body); white-space: pre-wrap; overflow-wrap: anywhere; }
.code-n .ln { display: grid; grid-template-columns: 2.6rem minmax(0, 1fr); }
.code-n .n { color: color-mix(in oklab, var(--soft) 60%, transparent); text-align: right; padding-right: 1.1rem; user-select: none; }

.live { border-left: 1px solid var(--line-soft); padding: 1.2rem 1.3rem; background: color-mix(in oklab, var(--band) 75%, transparent); display: flex; flex-direction: column; gap: .9rem; min-width: 0; }
.live-h { display: flex; align-items: center; gap: .5rem; font: 500 .75rem/1 var(--sans); text-transform: uppercase; letter-spacing: .1em; color: var(--soft); }
.live-h .glyph { color: var(--accent); }
.live-sql { display: block; font: .78rem/1.5 var(--mono); padding: .6rem .75rem; border-radius: .6rem; border: 1px solid var(--line); background: var(--band); color: var(--body); white-space: pre-wrap; }
.events { list-style: none; margin: .2rem 0 0; padding: 0; display: flex; flex-direction: column; }
.ev { display: grid; grid-template-columns: 1.4rem minmax(0, 1fr); gap: .6rem; padding-bottom: 1.1rem; position: relative; }
.ev::before { content: ""; position: absolute; left: .45rem; top: 1.2rem; bottom: 0; width: 1px; background: var(--line); }
.ev:last-child::before { display: none; }
.ev-dot { width: .9rem; height: .9rem; margin-top: .2rem; border-radius: 50%; border: 1px solid var(--line); background: var(--raise); position: relative; }
.ev-dot::after { content: ""; position: absolute; inset: .22rem; border-radius: 50%; }
.ev-dot.added::after { background: var(--add); } .ev-dot.removed::after { background: var(--del); }
.ev-top { display: flex; align-items: center; gap: .6rem; }
.tag { font: 500 .72rem/1 var(--mono); padding: .3rem .5rem; border-radius: .4rem; }
.tag.added { color: var(--add); background: color-mix(in oklab, var(--add) 14%, transparent); }
.tag.removed { color: var(--del); background: color-mix(in oklab, var(--del) 14%, transparent); }
.ev-n { font: .72rem/1 var(--mono); color: var(--soft); }
.ev-row { margin-top: .55rem; display: flex; flex-wrap: wrap; gap: .35rem; }
.chip-kv { font: .76rem/1 var(--mono); color: var(--ink); padding: .38rem .5rem; border-radius: .45rem; border: 1px solid var(--line); background: var(--band); }
.chip-kv i { font-style: normal; color: var(--soft); margin-right: .4rem; }
.live-cap { margin-top: auto; font-size: .75rem; color: var(--soft); }
.live-cap code { font-size: .72rem; background: none; padding: 0; color: var(--soft); }

/* frames inside steps and cards */
.frame { border: 1px solid var(--line); border-radius: .8rem; overflow: hidden; background: var(--paper); min-width: 0; box-shadow: inset 0 1px 0 oklch(100% 0 0 / .04); }
.bar { display: flex; align-items: center; gap: .6rem; background: var(--band); border-bottom: 1px solid var(--line-soft); padding: .55rem .85rem; font: .78rem/1.3 var(--mono); color: var(--soft); min-width: 0; }
.bar .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: var(--body); }
.dots { display: flex; gap: .35rem; flex: none; }
.dots i { width: 10px; height: 10px; border-radius: 50%; background: var(--raise); border: 1px solid var(--line); }
.chip { margin-left: auto; flex: none; font: .68rem/1 var(--mono); color: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: .25rem .5rem; }
.frame pre { margin: 0; padding: 1rem 1.1rem; font: .8rem/1.7 var(--mono); color: var(--body); white-space: pre-wrap; overflow-wrap: anywhere; }
.t-k { color: var(--t-k); } .t-s { color: var(--t-s); } .t-c { color: var(--t-c); font-style: italic; } .t-n { color: var(--t-n); }
.t-f { color: var(--t-f); } .t-t { color: var(--t-t); } .t-p { color: var(--t-p); }
.prompt-line::before { content: "$ "; color: var(--accent); }
.out-line { color: var(--ink); }
.cont-line::before { content: "  "; }
.cell .run { border-top: 1px solid var(--line-soft); background: var(--band); }
.cell .run-bar { display: flex; align-items: center; gap: .6rem; padding: .55rem 1.1rem 0; font: .7rem/1.3 var(--mono); color: var(--soft); text-transform: uppercase; letter-spacing: .1em; }
.cell .run pre { padding-top: .5rem; }
.pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem; align-items: stretch; }
.pair.stacked { grid-template-columns: minmax(0, 1fr); gap: 1.6rem; }
.pair > .frame { display: flex; flex-direction: column; }
.pair > .frame pre { flex: 1; }
.variants { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
.variants figure { margin: 0; min-width: 0; }
.variants figcaption { margin-top: .5rem; font: .75rem/1.4 var(--mono); color: var(--soft); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th { text-align: left; font: .72rem/1.4 var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--soft); padding: .6rem .8rem .6rem 0; border-bottom: 1px solid var(--line-soft); }
td { padding: .7rem .8rem .7rem 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
td:first-child { font-family: var(--mono); font-size: .85rem; color: var(--ink); }

/* getting started */
.steps { list-style: none; margin: 3.5rem 0 0; padding: 0; }
.step { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 8fr); gap: 3rem; padding-block: 2.6rem; border-top: 1px solid var(--line-soft); scroll-margin-top: 4.5rem; }
.step-text { position: sticky; top: 5.5rem; align-self: start; }
.step-n { display: inline-grid; place-items: center; width: 1.8rem; height: 1.8rem; border-radius: .55rem; font: 600 .8rem/1 var(--mono); color: var(--accent); background: var(--accent-soft); border: 1px solid color-mix(in oklab, var(--accent) 25%, transparent); }
.step h3 { margin-top: 1rem; font: 500 1.35rem/1.25 var(--sans); letter-spacing: -.02em; }
.step .explain { margin-top: .55rem; color: var(--soft); font-size: .95rem; }
.step-demo { min-width: 0; }

/* code tabs: an icon row of labels over one window */
.tabs { margin-top: 3rem; }
.tabs > input { position: absolute; opacity: 0; pointer-events: none; }
.tabrow { display: flex; flex-wrap: wrap; justify-content: center; gap: .9rem; margin-bottom: 2rem; }
.tabrow label { cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: .6rem; font-size: .85rem; color: var(--soft); transition: color .14s ease; }
.tab-ico { width: 3.6rem; height: 3.6rem; display: grid; place-items: center; border-radius: 1rem; border: 1px solid var(--line); background: var(--band); transition: border-color .14s ease, background .14s ease; }
.tabrow label:hover { color: var(--ink); }
.tabpanel { display: none; max-width: 62rem; margin-inline: auto; }

/* feature cards: the artefact on top, then what it is */
.cards { margin-top: 3.5rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; }
.card { border-radius: 1.25rem; border: 1px solid var(--line-soft); background: linear-gradient(180deg, oklch(100% 0 0 / .025), transparent 40%); box-shadow: inset 0 1px 0 oklch(100% 0 0 / .06);
  display: flex; flex-direction: column; min-width: 0; scroll-margin-top: 5rem; }
.card.wide { grid-column: 1 / -1; }
.card-art { padding: 1.4rem 1.4rem 0; min-width: 0; display: flex; flex-direction: column; gap: .9rem; }
.card-art .frame { border-color: var(--line-soft); background: var(--paper); box-shadow: none; }
.card-art .bar { background: var(--band); }
.card-art .table-wrap { padding: .2rem .4rem; }
.card-art .pair { grid-template-columns: minmax(0, 1fr); }
.card.wide .card-art .pair { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.card-art .variants { grid-template-columns: minmax(0, 1fr); }
.card-body { padding: 1.6rem 2rem 2rem; margin-top: auto; }
.card-body .glyph { color: var(--ink); }
.card-body h3 { margin-top: .9rem; font: 500 1.3rem/1.25 var(--sans); letter-spacing: -.02em; }
.card-body .explain { margin-top: .55rem; color: var(--soft); font-size: .95rem; max-width: 56ch; }
.more { margin-top: 1.1rem; display: inline-flex; align-items: center; gap: .4rem; font-size: .9rem; color: var(--ink); text-decoration: none; }
.more .glyph { transition: transform .14s ease; }
.more:hover .glyph { transform: translateX(2px); }

/* comparison: rows are prose, the last column is the product */
.compare { margin-top: 3rem; }
.compare table { font-size: .92rem; }
.compare th:not(:first-child), .compare td:not(:first-child) { width: 27%; }
.compare tbody th { text-align: left; font: 500 .92rem/1.5 var(--sans); color: var(--body); text-transform: none; letter-spacing: 0; padding: .8rem .8rem .8rem 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.compare td, .compare thead th { padding-inline: .9rem; }
.compare td { font-family: var(--sans); font-size: .92rem; color: var(--body); }
.compare td:last-child, .compare th:last-child { color: var(--ink); background: color-mix(in oklab, var(--accent) 6%, transparent); }
.compare th:last-child { color: var(--accent); border-radius: .6rem .6rem 0 0; }
.compare .yes { color: var(--ink); font-weight: 600; }
.compare .no { color: var(--soft); }

/* the closing call: serif head, actions, the command, then a giant faded wordmark */
.cta { text-align: center; padding-bottom: 0; overflow: clip; }
.cta h2 { font: 400 clamp(2.6rem, 6vw, 4.6rem)/1.02 var(--serif); letter-spacing: -.025em; color: var(--ink); }
.cta h2 .mute { color: var(--soft); }
.cta .acts { justify-content: center; }
.cta .pill { margin-top: 1.4rem; }
.wordmark-xl { margin-top: 4rem; font: 800 clamp(7rem, 26vw, 22rem)/.78 var(--sans); letter-spacing: -.07em; text-align: center; color: transparent; user-select: none;
  background: linear-gradient(180deg, color-mix(in oklab, var(--ink) 9%, transparent), transparent 85%); -webkit-background-clip: text; background-clip: text; }

/* footer */
.site-footer { border-top: 1px solid var(--line-soft); padding-block: 4rem 2rem; font-size: .875rem; }
.credit { color: var(--soft); max-width: 60ch; }
.cols { margin-top: 3rem; display: grid; grid-template-columns: repeat(6, 1fr); row-gap: 3rem; column-gap: 1.5rem; }
.cols h3 { font-size: .9rem; font-weight: 500; }
.cols ul { list-style: none; margin: .5rem 0 0; padding: 0; }
.cols li a { color: var(--soft); text-decoration: none; line-height: 2; font-size: .875rem; transition: color .14s ease; }
.cols li a:hover { color: var(--ink); }
.newpill { font-size: .65rem; background: var(--raise); border: 1px solid var(--line); border-radius: 999px; padding: .05rem .4rem; margin-left: .35rem; color: var(--ink); }
.foot-icons { margin-top: 2.5rem; display: flex; gap: .9rem; }
.foot-icons a { color: var(--soft); transition: color .14s ease; }
.foot-icons a:hover { color: var(--ink); }
.bottom { margin-top: 2.5rem; display: flex; align-items: center; gap: .7rem; font-size: .8rem; color: var(--soft); flex-wrap: wrap; }
.bottom .mark { border-radius: .35rem; }
.seg { margin-left: auto; display: inline-flex; background: var(--raise); border: 1px solid var(--line); border-radius: 999px; padding: 2px; }
.seg button { width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 999px; background: none; color: var(--soft); cursor: pointer; padding: 0; }
:root:not([data-pref]) .seg [data-theme-set="system"], :root[data-pref="system"] .seg [data-theme-set="system"],
:root[data-pref="dark"] .seg [data-theme-set="dark"], :root[data-pref="light"] .seg [data-theme-set="light"] { background: var(--ink); color: var(--paper); }

/* reference */
.ref { display: grid; grid-template-columns: 15rem minmax(0, 1fr); gap: 3rem; padding-block: 3rem 5rem; }
.toc { position: sticky; top: 4.5rem; align-self: start; max-height: calc(100vh - 5.5rem); overflow-y: auto; font-size: .82rem; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc li a { display: block; color: var(--soft); text-decoration: none; padding: .18rem 0; }
.toc li a:hover { color: var(--ink); }
.toc .l1 { margin-top: .9rem; } .toc .l1 a { color: var(--ink); font-weight: 600; }
.toc .l3 a { padding-left: .9rem; }
.prose { max-width: 76ch; min-width: 0; }
.prose h1 { font-size: 2.2rem; letter-spacing: -.035em; margin: 3.5rem 0 1rem; scroll-margin-top: 4.5rem; }
.prose h1:first-child { margin-top: 0; }
.prose h2 { font-size: 1.4rem; letter-spacing: -.02em; margin: 2.6rem 0 .7rem; scroll-margin-top: 4.5rem; }
.prose h3, .prose h4 { font-size: 1.1rem; margin: 2rem 0 .6rem; scroll-margin-top: 4.5rem; }
.prose p, .prose ul, .prose ol, .prose .table-wrap { margin: 0 0 1rem; }
.prose li { margin: .25rem 0; }
.prose pre.code { margin: 0 0 1.2rem; padding: 1rem 1.1rem; border: 1px solid var(--line); border-radius: .7rem; background: var(--band); font: .8rem/1.6 var(--mono); overflow-x: auto; }

@media (max-width: 1000px) {
  .cols { grid-template-columns: repeat(3, 1fr); }
  .hero-grid { grid-template-columns: minmax(0, 1fr); }
  .hero-art { order: -1; }
  .hero-object { width: min(70%, 18rem); }
  .grid9 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .win-body { grid-template-columns: minmax(0, 1fr); }
  .live { border-left: 0; border-top: 1px solid var(--line-soft); }
  .step { grid-template-columns: minmax(0, 1fr); gap: 1.2rem; }
  .step-text { position: static; }
  .cards { grid-template-columns: minmax(0, 1fr); }
  .card.wide .card-art .pair, .variants { grid-template-columns: minmax(0, 1fr); }
  .site-header .nav { display: none; }
}
@media (max-width: 720px) {
  .shell { width: calc(100% - 2rem); }
  .hero h1 { font-size: 2.9rem; }
  .grid9 { grid-template-columns: minmax(0, 1fr); gap: 2.4rem; }
  .pair { grid-template-columns: minmax(0, 1fr); }
  .cols { grid-template-columns: repeat(2, 1fr); }
  .ref { grid-template-columns: minmax(0, 1fr); }
  .toc { position: static; max-height: 18rem; border: 1px solid var(--line); border-radius: .6rem; padding: .5rem 1rem 1rem; }
  .card-body { padding: 1.4rem 1.4rem 1.6rem; }
  .card-art { padding: 1rem 1rem 0; }
  .tab-ico { width: 3rem; height: 3rem; }
  .tabrow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem .5rem; }
  .site-header .header-cta { display: none; }
  .compare thead { display: none; }
  .compare table, .compare tbody, .compare tr, .compare th, .compare td { display: block; width: auto; }
  .compare tr { padding-block: .9rem; border-bottom: 1px solid var(--line-soft); }
  .compare tbody th { border: 0; padding: 0 0 .4rem; color: var(--ink); font-weight: 600; }
  .compare td, .compare td:not(:first-child) { width: auto; border: 0; padding: .2rem 0; display: grid; grid-template-columns: 8.5rem minmax(0, 1fr); gap: .8rem; background: none; }
  .compare td::before { content: attr(data-label); color: var(--soft); font: .75rem/1.6 var(--mono); }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
  .more:hover .glyph { transform: none; }
}
`

/** Radio-driven tabs need one rule set per tab; generated from the model's tab count. */
export const TAB_CSS = site.showcase.tabs
  .map((_, i) => `#tab-${i}:checked ~ .tabrow label[for="tab-${i}"]{color:var(--ink)}#tab-${i}:checked ~ .tabrow label[for="tab-${i}"] .tab-ico{background:var(--raise);border-color:color-mix(in oklab,var(--accent) 45%,transparent);color:var(--accent)}#tab-${i}:checked ~ .p-${i}{display:block}#tab-${i}:focus-visible ~ .tabrow label[for="tab-${i}"] .tab-ico{outline:2px solid var(--accent);outline-offset:3px}`)
  .join("\n")

// ---- scripts ------------------------------------------------------------------------------

/** The theme boot script: inline in <head>, before the stylesheet, under 30 lines. */
export const BOOT = `(function () {
  var k = ${JSON.stringify(site.themeKey)}, d = document.documentElement;
  var light = window.matchMedia ? matchMedia("(prefers-color-scheme: light)") : null;
  function pref() { try { return localStorage.getItem(k) || "system"; } catch (e) { return "system"; } }
  function apply() {
    var p = pref();
    d.setAttribute("data-pref", p);
    d.setAttribute("data-theme", p === "system" ? (light && light.matches ? "light" : "dark") : p);
  }
  apply();
  if (light) light.addEventListener("change", apply);
  window.__theme = { key: k, pref: pref, apply: apply };
})();`

/** Controls: theme toggle and switch, copy buttons. Everything works to read without it. */
export const CONTROLS = `(function () {
  var order = ["system", "dark", "light"], t = window.__theme;
  function set(p) { try { localStorage.setItem(t.key, p); } catch (e) {} t.apply(); label(); }
  function label() {
    var p = t.pref();
    document.querySelectorAll("[data-theme-cycle]").forEach(function (b) { b.setAttribute("aria-label", "Theme: " + p + ". Click to change"); });
    document.querySelectorAll("[data-theme-set]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-set") === p)); });
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    if (b.hasAttribute("data-theme-cycle")) set(order[(order.indexOf(t.pref()) + 1) % 3]);
    else if (b.hasAttribute("data-theme-set")) set(b.getAttribute("data-theme-set"));
    else if (b.hasAttribute("data-copy")) navigator.clipboard.writeText(b.getAttribute("data-copy"));
    else if (b.hasAttribute("data-copy-page")) fetch(b.getAttribute("data-copy-page")).then(function (r) { return r.text(); }).then(function (s) { navigator.clipboard.writeText(s); });
  });
  label();
})();`

// ---- pieces -------------------------------------------------------------------------------

const extMark = '<span class="ext" aria-hidden="true">↗</span>'

function header(current: "home" | "reference"): string {
  const nav = site.nav
    .map((n) => {
      const ext = isExternal(n.href)
      const cur = (current === "reference" && n.href === "/reference") ? ' aria-current="page"' : ""
      return `<a href="${esc(n.href)}"${cur}${ext ? ' rel="noopener"' : ""}>${esc(n.label)}${ext ? extMark : ""}</a>`
    })
    .join("")
  const icons = site.links
    .filter((l) => l.where.includes("header") && l.icon !== "text")
    .map((l) => `<a href="${esc(repoHref(l.href))}" rel="noopener">${brand(l.icon as IconName)}<span class="sr">${esc(l.label)}</span></a>`)
    .join("")
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="shell">
<a class="wordmark" href="/">${esc(site.name)}</a>
<nav class="nav" aria-label="Site">${nav}</nav>
<div class="icons">${icons}<button type="button" class="icon-btn theme-toggle" data-theme-cycle aria-label="Theme: system. Click to change">${glyph("monitor").replace('class="glyph"', 'class="glyph g-system"')}${glyph("moon").replace('class="glyph"', 'class="glyph g-dark"')}${glyph("sun").replace('class="glyph"', 'class="glyph g-light"')}</button><a class="btn header-cta" href="/#start">Get started</a></div>
</div></header>`
}

function footer(): string {
  const cols = site.footer
    .map(
      (c) =>
        `<div><h3>${esc(c.title)}</h3><ul>${c.links
          .map((l) => {
            const h = repoHref(l.href)
            const ext = isExternal(h)
            return `<li><a href="${esc(h)}"${ext ? ' rel="noopener"' : ""}>${esc(l.label)}${ext ? extMark : ""}</a>${l.released ? '<span class="newpill">New</span>' : ""}</li>`
          })
          .join("")}</ul></div>`,
    )
    .join("")
  const icons = site.links
    .filter((l) => l.where.includes("footer") && l.icon !== "text")
    .map((l) => `<a href="${esc(repoHref(l.href))}" rel="noopener">${brand(l.icon as IconName)}<span class="sr">${esc(l.label)}</span></a>`)
    .join("")
  const seg = (["system", "light", "dark"] as const)
    .map((p) => `<button type="button" data-theme-set="${p}" aria-label="Use ${p} theme">${glyph(p === "system" ? "monitor" : p === "light" ? "sun" : "moon", 14)}</button>`)
    .join("")
  return `<footer class="site-footer"><div class="shell">
<p class="credit">${inline(site.credit)}</p>
<nav class="cols" aria-label="Footer">${cols}</nav>
<div class="foot-icons">${icons}</div>
<div class="bottom">${productMark(20)}<span>© ${site.year} linesofcode</span><div class="seg" role="group" aria-label="Theme">${seg}</div></div>
</div></footer>`
}

function copyBtn(text: string, what: string): string {
  return `<button type="button" class="copy" data-copy="${esc(text)}" aria-label="Copy ${esc(what)}">${glyph("copy", 15)}</button>`
}

/**
 * A README run block as a terminal: `# ` lines are what the command printed, every other line is a
 * command and gets a prompt, unless it continues the previous one after a trailing backslash.
 */
function runLines(code: string): string {
  let cont = false
  return code
    .split("\n")
    .map((l) => {
      const out = /^#( |$)/.test(l) && !cont
      const html = out
        ? `<span class="out-line">${esc(l.replace(/^# ?/, ""))}</span>`
        : l.trim() === "" ? "" : `<span class="${cont ? "cont-line" : "prompt-line"}">${highlight(l, "sh")}</span>`
      cont = !out && /\\\s*$/.test(l)
      return html
    })
    .join("\n")
}

function terminalFrame(cmd: string, block: Block): string {
  return `<div class="frame"><div class="bar">${glyph("terminal", 14)}<span class="label">$ ${esc(cmd)}</span><span class="chip">captured output</span></div><pre><code>${runLines(block.code)}</code></pre></div>`
}

function codeFrame(label: string, block: Block, dots = true): string {
  return `<div class="frame"><div class="bar">${dots ? '<span class="dots"><i></i><i></i><i></i></span>' : glyph("file", 14)}<span class="label">${esc(label)}</span></div><pre><code>${highlight(block.code, block.lang)}</code></pre></div>`
}

function frameHtml(d: ResolvedFrame): string {
  switch (d.kind) {
    case "terminal":
      return terminalFrame(d.cmd, d.block)
    case "snippet":
      return codeFrame(d.label, d.block)
    case "table":
      return renderTable(d.table.header, d.table.rows)
  }
}

function demoHtml(d: ResolvedDemo): string {
  switch (d.kind) {
    case "terminal":
    case "snippet":
    case "table":
      return frameHtml(d)
    case "pair": {
      const stacked = d.items.some((i) => i.kind === "table")
      return `<div class="pair${stacked ? " stacked" : ""}">${d.items.map(frameHtml).join("")}</div>`
    }
    case "variants":
      return `<div class="variants">${d.items
        .map((i) => `<figure>${codeFrame(i.label, i.block)}<figcaption>${esc(i.caption)}</figcaption></figure>`)
        .join("")}</div>`
    case "cell":
      return cellHtml(d)
  }
}

/** The comparison as a table that stacks into labelled rows on a phone instead of scrolling. */
function compareTable(t: Table): string {
  const label = (c: string) => esc(c.replace(/`/g, ""))
  const th = t.header.map((c) => `<th scope="col">${inline(c)}</th>`).join("")
  const tr = t.rows
    .map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${inline(c)}</th>` : `<td data-label="${label(t.header[i]!)}"><span${c === "Yes" ? ' class="yes"' : c === "No" ? ' class="no"' : ""}>${inline(c)}</span></td>`)).join("")}</tr>`)
    .join("")
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

function cellHtml(d: Extract<ResolvedDemo, { kind: "cell" }>): string {
  return `<div class="frame cell"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="label">${esc(d.label)}</span>${copyBtn(d.code.code, d.label)}</div><pre><code>${highlight(d.code.code, d.code.lang)}</code></pre>
<div class="run"><div class="run-bar">${glyph("terminal", 13)}<span>Output</span></div><pre><code>${runLines(d.run.code)}</code></pre></div></div>`
}

function pageHead(opts: { title: string; description: string; path: string; md: string }): string {
  const u = url(opts.path)
  const og = url("/og.png")
  const ld = {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: site.name,
    description: site.description,
    url: url("/"),
    codeRepository: site.repo,
    applicationCategory: "DeveloperApplication",
    programmingLanguage: "TypeScript",
    runtimePlatform: "Bun",
    softwareVersion: version(),
    license: `https://opensource.org/licenses/${site.license}`,
    author: { "@type": "Person", name: "linesofcode", url: "https://x.com/linesofcode" },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  }
  const favicon = "data:image/svg+xml," + encodeURIComponent(faviconSvg())
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${u}">
<link rel="alternate" type="text/markdown" href="${url(opts.md)}">
<meta name="theme-color" content="#161616" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fcfcfc" media="(prefers-color-scheme: light)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${u}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="${esc(`${site.name}: ${site.h1}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.description)}">
<meta name="twitter:image" content="${og}">
<link rel="icon" href="${favicon}">
<script>${BOOT}</script>
<style>${CSS}${TAB_CSS}</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`
}

function page(h: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
${h}
</head>
<body>
${body}
<script>${CONTROLS}</script>
</body>
</html>
`
}

// ---- landing ------------------------------------------------------------------------------

/** Code with line numbers. Each line is highlighted on its own, so a number always sits beside it. */
function numbered(code: string, lang: string): string {
  return code
    .split("\n")
    .map((l, i) => `<span class="ln"><span class="n" aria-hidden="true">${i + 1}</span><span class="c">${highlight(l, lang) || " "}</span></span>`)
    .join("")
}

/** A section head: the title in ink, its tail muted, then one or two sentences. */
function head(id: string, title: string, muted: string, body: string, cls = ""): string {
  return `<div class="shead${cls}"><h2 id="${id}-h">${esc(title)} <span class="mute">${esc(muted)}</span></h2>${body ? `<p class="explain">${inline(body, linkContext())}</p>` : ""}</div>`
}

/** The live query panel: the code on the left, its captured diffs drawn as an event timeline. */
function livePanel(d: Extract<ResolvedDemo, { kind: "cell" }>): string {
  const sql = /db\.live`([^`]*)`/.exec(d.code.code)?.[1] ?? ""
  const events = d.run.code
    .split("\n")
    .filter((l) => /^# diff /.test(l))
    .map((l) => JSON.parse(l.replace(/^# diff /, "")) as { added: Record<string, unknown>[]; removed: Record<string, unknown>[] })
  const chips = (row: Record<string, unknown>) =>
    Object.entries(row).map(([k, v]) => `<span class="chip-kv"><i>${esc(k)}</i>${esc(JSON.stringify(v))}</span>`).join("")
  const rows = events
    .flatMap((e, i) => [
      ...e.added.map((r) => ({ kind: "added", r, i })),
      ...e.removed.map((r) => ({ kind: "removed", r, i })),
    ])
    .map(({ kind, r, i }) => `<li class="ev"><span class="ev-dot ${kind}" aria-hidden="true"></span><div><div class="ev-top"><span class="tag ${kind}">${kind}</span><span class="ev-n">diff ${i + 1}</span></div><div class="ev-row">${chips(r)}</div></div></li>`)
    .join("")
  const cmd = d.cmd
  return `<div class="window">
<div class="win-bar"><span class="dots"><i></i><i></i><i></i></span><span class="win-title">${esc(d.label)}</span>${copyBtn(d.code.code, d.label)}</div>
<div class="win-body">
<pre class="code-n"><code>${numbered(d.code.code, d.code.lang)}</code></pre>
<aside class="live">
<p class="live-h">${glyph("activity", 14)}<span>Live query</span></p>
<code class="live-sql">${esc(sql)}</code>
<ol class="events">${rows}</ol>
<p class="live-cap">Captured from <code>${esc(cmd)}</code></p>
</aside>
</div>
</div>`
}

/** A feature card: its artefact on top, then the glyph, title, explanation and a reference link. */
function card(cap: Capability, demo: ResolvedDemo, href: string, wide = false): string {
  return `<article class="card${wide ? " wide" : ""}" id="${cap.id}" aria-labelledby="${cap.id}-h">
<div class="card-art">${demoHtml(demo)}</div>
<div class="card-body">${glyph(cap.icon, 20)}<h3 id="${cap.id}-h">${esc(cap.title)}</h3><p class="explain">${inline(cap.body, linkContext())}</p><a class="more" href="${esc(href)}">Reference ${glyph("arrow", 14)}</a></div>
</article>`
}

export function renderIndex(m: Model = resolveModel()): string {
  const hero = `<div class="hero-wrap"><section class="hero" aria-labelledby="top-h"><div class="shell hero-grid">
<div class="hero-copy">
<a class="badge" href="${esc(site.npm)}" rel="noopener">v${esc(m.version)} on npm <span aria-hidden="true">›</span></a>
<h1 id="top-h">${esc(site.h1)}</h1>
<p class="lede">${inline(site.lede)}</p>
<div class="acts"><a class="btn" href="#start">Get started</a><a class="btn-ghost" href="/reference">Documentation</a></div>
<div class="aud">
<input type="radio" name="aud" id="aud-h" checked><input type="radio" name="aud" id="aud-a">
<div class="aud-tabs"><label for="aud-h">For humans</label><label for="aud-a">For agents</label></div>
<div class="aud-panel p-h" data-panel="humans"><div class="pill"><span class="prompt" aria-hidden="true">$</span><code>${esc(site.install.humans.cmd)}</code>${copyBtn(site.install.humans.cmd, "install command")}</div></div>
<div class="aud-panel p-a" data-panel="agents"><div class="pill"><span class="prompt" aria-hidden="true">$</span><code>${esc(site.install.agents)}</code>${copyBtn(site.install.agents, "agent command")}</div>
<div class="agent-links"><a href="/llms.txt">llms.txt</a><a href="/AGENTS.md">AGENTS.md</a><button type="button" data-copy-page="/index.md">Copy page as Markdown</button></div></div>
</div>
<p class="version">Currently v${esc(m.version)} · ${esc(site.install.note)}</p>
</div>
<div class="hero-art">${heroObject()}</div>
</div></section></div>`

  const logos = `<section class="section logos" id="ecosystem" aria-labelledby="ecosystem-h"><div class="shell">
<h2 id="ecosystem-h" class="logos-h">${esc(site.ecosystem.title)}</h2>
<p class="logos-p">${inline(site.ecosystem.lede)}</p>
<div class="marks">${site.ecosystem.marks.map((k) => {
    const b = brandTone(k.icon)
    return `<a class="tone-${b.tone}" style="--brand:${b.hex}" href="${esc(k.href)}" rel="noopener" aria-label="${esc(k.label)}" title="${esc(k.label)}">${brand(k.icon, 32)}</a>`
  }).join("")}</div>
</div></section>`

  const overview = `<section class="section" id="why" aria-labelledby="why-h"><div class="shell">
${head("why", site.overview.title, site.overview.muted, site.overview.body)}
<div class="grid9">${site.overview.items.map((x) => `<div class="gi">${glyph(x.icon, 20)}<h3>${esc(x.title)}</h3><p>${inline(x.body)}</p></div>`).join("")}</div>
</div></section>`

  const live = `<section class="section" id="live" aria-labelledby="live-h"><div class="shell">
<div class="tile" aria-hidden="true">${glyph("activity", 34)}</div>
${head("live", site.live.title, "", site.live.body, " centre")}
${livePanel(m.hero)}
</div></section>`

  const caps = (c: Chapter) => m.capabilities.filter((x) => x.cap.chapter === c)
  const ch = site.chapters

  const start = `<section class="section" id="start" aria-labelledby="start-h"><div class="shell">
${head("start", ch.start.title, ch.start.muted, ch.start.body)}
<ol class="steps">${caps("start")
    .map(({ cap, demo }, i) => `<li class="step" id="${cap.id}" aria-labelledby="${cap.id}-h"><div class="step-text"><span class="step-n" aria-hidden="true">${i + 1}</span><h3 id="${cap.id}-h">${esc(cap.title)}</h3><p class="explain">${inline(cap.body, linkContext())}</p></div><div class="step-demo">${demoHtml(demo)}</div></li>`)
    .join("\n")}</ol>
</div></section>`

  const tabInputs = m.tabs.map((_, i) => `<input type="radio" name="tab" id="tab-${i}"${i === 0 ? " checked" : ""}>`).join("")
  const showcase = `<section class="section" id="showcase" aria-labelledby="showcase-h"><div class="shell">
${head("showcase", site.showcase.title, site.showcase.muted, site.showcase.body, " centre")}
<div class="tabs">${tabInputs}
<div class="tabrow" role="presentation">${m.tabs.map((t, i) => `<label for="tab-${i}"><span class="tab-ico">${glyph(t.icon, 22)}</span><span>${esc(t.label)}</span></label>`).join("")}</div>
${m.tabs
  .map(
    (t, i) =>
      `<div class="tabpanel p-${i}"><div class="window"><div class="win-bar"><span class="win-file">${glyph("file", 13)}${esc(t.file)}</span>${copyBtn(t.block.code, t.file)}</div><pre class="code-n"><code>${numbered(t.block.code, t.block.lang)}</code></pre><div class="win-foot"><a href="${esc(site.repo)}" rel="noopener">${glyph("arrow", 13)}View on GitHub</a><a href="/reference#db">${glyph("book", 13)}Read the reference</a></div></div></div>`,
  )
  .join("")}
</div>
</div></section>`

  const cards = (c: Chapter, href: string) => {
    const list = caps(c)
    return `<div class="cards">${list.map(({ cap, demo }, i) => card(cap, demo, href, list.length % 2 === 1 && i === list.length - 1)).join("\n")}</div>`
  }

  const database = `<section class="section" id="${ch.db.id}" aria-labelledby="${ch.db.id}-h"><div class="shell">
${head(ch.db.id, ch.db.title, ch.db.muted, ch.db.body)}
${cards("db", ch.db.href)}
</div></section>`

  const bus = `<section class="section" id="${ch.bus.id}" aria-labelledby="${ch.bus.id}-h"><div class="shell">
<div class="tile" aria-hidden="true">${glyph("inbox", 34)}</div>
${head(ch.bus.id, ch.bus.title, ch.bus.muted, ch.bus.body, " centre")}
${cards("bus", ch.bus.href)}
</div></section>`

  const compare = `<section class="section" id="compare" aria-labelledby="compare-h"><div class="shell">
${head("compare", site.compare.title, site.compare.muted, site.compare.body)}
<div class="demo compare">${compareTable(m.compare)}</div>
</div></section>`

  const cta = `<section class="section cta" id="today" aria-labelledby="today-h"><div class="shell">
<h2 id="today-h">${esc(site.cta.title)} <span class="mute">${esc(site.cta.muted)}</span></h2>
<div class="acts"><a class="btn" href="#start">Get started</a><a class="btn-ghost" href="/reference">Documentation</a></div>
<div class="pill"><span class="prompt" aria-hidden="true">$</span><code>${esc(site.cta.cmd)}</code>${copyBtn(site.cta.cmd, "server command")}</div>
</div>
<div class="wordmark-xl" aria-hidden="true">${esc(site.name)}</div>
</section>`

  const body = `${header("home")}
<main id="main">
${hero}
${logos}
${overview}
${live}
${start}
${showcase}
${database}
${bus}
${compare}
${cta}
</main>
${footer()}`
  return page(pageHead({ title: site.title, description: site.description, path: "/", md: "/index.md" }), body)
}

// ---- reference ----------------------------------------------------------------------------

export function renderReference(p: Parsed = source()): { html: string; ids: string[] } {
  const parts = p.docs.map((d) => {
    // Each README's own H1 becomes the section title; its H2s nest under it.
    const r = renderDoc(d.text, linkContext(d.path, true), d.id)
    const first = r.headings[0]
    // Give each document a stable top anchor named after its id.
    const html = first ? r.html.replace(`id="${first.id}"`, `id="${d.id}"`) : r.html
    const headings = first ? [{ ...first, id: d.id }, ...r.headings.slice(1)] : r.headings
    return { d, html, headings }
  })
  const toc = parts
    .flatMap(({ d, headings }) =>
      headings
        .filter((h) => h.level <= 3)
        .map((h, i) => `<li class="l${i === 0 ? 1 : h.level}"><a href="#${h.id}">${i === 0 ? esc(DOCS.find((x) => x.id === d.id)!.title) : inline(h.text)}</a></li>`),
    )
    .join("")
  const body = `${header("reference")}
<main id="main" class="shell ref">
<nav class="toc" aria-label="Contents"><ul>${toc}</ul></nav>
<article class="prose">${parts.map((x) => `<div class="doc" data-doc="${x.d.id}">${x.html}</div>`).join("\n")}</article>
</main>
${footer()}`
  const description = "The bql.sh reference: the repository README and the full bql.sh and bql.sh/bus documentation on one page."
  const html = page(pageHead({ title: `Reference · ${site.name}`, description, path: "/reference", md: "/reference.md" }), body)
  return { html, ids: parts.flatMap((x) => x.headings.map((h) => h.id)) }
}

// ---- Markdown twins and agent files ------------------------------------------------------

const fence = (b: Block) => "```" + b.lang + "\n" + b.code + "\n```"
const plain = (md: string) => md

function tableMd(t: Table): string {
  return [`| ${t.header.join(" | ")} |`, `| ${t.header.map(() => "---").join(" | ")} |`, ...t.rows.map((r) => `| ${r.join(" | ")} |`)].join("\n")
}

function frameMd(d: ResolvedFrame): string {
  return d.kind === "table" ? tableMd(d.table) : fence(d.block)
}

function demoMd(d: ResolvedDemo): string {
  switch (d.kind) {
    case "terminal":
    case "snippet":
    case "table":
      return frameMd(d)
    case "pair":
      return d.items.map(frameMd).join("\n\n")
    case "variants":
      return d.items.map((i) => `${i.caption}:\n\n${fence(i.block)}`).join("\n\n")
    case "cell":
      return `${fence(d.code)}\n\n${fence(d.run)}`
  }
}

export function renderIndexMd(m: Model = resolveModel()): string {
  const chapter = (c: Chapter) => [
    `## ${site.chapters[c].title} ${site.chapters[c].muted}`,
    "",
    ...m.capabilities
      .filter((x) => x.cap.chapter === c)
      .flatMap(({ cap, demo }) => [`### ${cap.title}`, "", cap.body, "", demoMd(demo), ""]),
  ]
  const out: string[] = [
    `# ${site.h1}`,
    "",
    plain(site.lede),
    "",
    `Currently \`bql.sh\` v${m.version} · ${site.install.note}.`,
    "",
    "```sh\n" + site.install.humans.cmd + "\n```",
    "",
    `## ${site.overview.title} ${site.overview.muted}`,
    "",
    site.overview.body,
    "",
    ...site.overview.items.flatMap((x) => [`### ${x.title}`, "", x.body, ""]),
    `## ${site.live.title}`,
    "",
    site.live.body,
    "",
    demoMd(m.hero),
    "",
    ...chapter("start"),
    `## ${site.showcase.title} ${site.showcase.muted}`,
    "",
    site.showcase.body,
    "",
    ...m.tabs.flatMap((t) => [`### ${t.label}`, "", fence(t.block), ""]),
    ...chapter("db"),
    ...chapter("bus"),
    `## ${site.ecosystem.title}`,
    "",
    site.ecosystem.lede,
    "",
    `Reference: ${url("/reference")} · Repository: ${site.repo}`,
    "",
  ]
  return out.join("\n")
}

export function renderReferenceMd(p: Parsed = source()): string {
  return p.docs.map((d) => `<!-- ${d.path} -->\n\n${d.text.trim()}\n`).join("\n---\n\n")
}

export function renderLlms(m: Model = resolveModel()): string {
  return [
    `# ${site.name}`,
    "",
    `> ${site.description}`,
    "",
    plain(site.lede),
    "",
    `Currently \`bql.sh\` v${m.version}, ${site.install.note}. Install with \`${site.install.humans.cmd}\`.`,
    "",
    ...m.capabilities.flatMap(({ cap, demo }) => [`## ${cap.title}`, "", cap.body, "", demoMd(demo), ""]),
    "## Links",
    "",
    `- [Reference](${url("/reference")}): the full README of each package`,
    `- [Reference as Markdown](${url("/reference.md")})`,
    `- [This page as Markdown](${url("/index.md")})`,
    `- [AGENTS.md](${url("/AGENTS.md")})`,
    `- [Repository](${site.repo})`,
    "",
  ].join("\n")
}

export function renderAgents(m: Model = resolveModel()): string {
  const by = (id: string) => m.capabilities.find((x) => x.cap.id === id)!.demo
  const consumer = resolveSnippet("await new BusConsumer({", { doc: "bus" })
  return [
    `# Using ${site.name} from an agent`,
    "",
    `${site.name} is one npm package. \`bql.sh\` is a SQLite database server for Bun with one database per tenant; its CLI is \`bql\`. \`bql.sh/bus\` is a message bus on the same engine; its CLI is \`bql bus\`. Bun 1.4 or newer. Currently v${m.version}.`,
    "",
    "## Install",
    "",
    "Install the package, then build the libsqlite3 the driver loads. The build needs a C compiler and runs once per machine.",
    "",
    fence(m.humans),
    "",
    demoMd(by("install")),
    "",
    "## Embedded",
    "",
    "`Bql.open()` runs the engine in-process. No server, no key.",
    "",
    demoMd(by("embedded")),
    "",
    "## Server and client",
    "",
    "`bql serve` prints the admin key once on first start and saves it to `<dir>/keys.json`. Pass it as `BQL_ADMIN_KEY`.",
    "",
    demoMd(by("serve")),
    "",
    demoMd(m.hero),
    "",
    "## Scoped tokens",
    "",
    "Give browsers and untrusted callers a minted token, never the admin key.",
    "",
    demoMd(by("token")),
    "",
    "## Bus consumer",
    "",
    fence(consumer),
    "",
    "## Options",
    "",
    "| option | where | effect |",
    "| --- | --- | --- |",
    "| `ack` | db write, per request or node | `fsync` (default), `local`, `replica`, `quorum` |",
    "| `consistency` | db client | `ryw` (default) sends `BQL-Min-Txid` so reads never go backwards |",
    "| `intMode` | db client | `bigint` or `string`; the default refuses to round past 2^53 |",
    "| `--replica-of` | `bql serve` | follow a primary and forward writes to it |",
    "| `--s3` | `bql serve` | ship the log and snapshots to a bucket |",
    "| `ackWaitMs`, `maxAttempts` | bus subscription | lease length, retries before dead-letter |",
    "| `ordered` | bus subscription | per-key FIFO; off by default |",
    "| `[[outbox.rules]]` | `bql.toml` | publish committed row changes to a bus subject; needs `[replication] logicalChanges` |",
    "| `handlerTimeoutMs` | `BusConsumer` | stop a handler that hangs while holding its lease |",
    "",
    "## Mistakes that break it",
    "",
    "- Skipping the engine build, or pointing at a system libsqlite3. `bun run sqlite:build` in your own project finds no such script; use the by-path command above. Apple's `/usr/lib/libsqlite3.dylib` loads but changes `cache_size`, and WAL tests fail on it.",
    "- `await` inside a `consumeTransactional` handler. It must be synchronous, or another statement interleaves into the ack transaction.",
    "- Dropping the trailing slash from a `@libsql/client` URL (`/v1/db/acme/`). The client resolves `v2/pipeline` relative to it.",
    "",
    `Full reference: ${url("/reference")} (Markdown: ${url("/reference.md")}).`,
    "",
  ].join("\n")
}

export const PAGES = ["/", "/reference", "/index.md", "/reference.md", "/llms.txt", "/AGENTS.md"] as const

export function renderSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => `  <url><loc>${url(p)}</loc></url>`).join("\n")}
</urlset>
`
}

export const renderRobots = () => `User-agent: *\nAllow: /\n\nSitemap: ${url("/sitemap.xml")}\n`

export const renderVercel = () => JSON.stringify({ cleanUrls: true, trailingSlash: false }, null, 2) + "\n"

export { faviconSvg, slug }
