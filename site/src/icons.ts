// Icons are markup, so they live here. Two sets, never mixed: stroked glyphs on a 24 grid for
// controls, and real brand marks (simple-icons, CC0) filled with currentColor. Plus the product
// mark, the one decorative element on the page.

import {
  siBun, siClickhouse, siCloudflare, siDiscord, siDocker, siDrizzle, siFlydotio, siGithub, siGithubactions, siGraphql,
  siOpenapiinitiative, siOpentelemetry, siPrometheus, siSqlite, siTurso, siVercel, siX,
} from "simple-icons"
// LinkedIn and Amazon S3 were dropped from later simple-icons releases; v9 still carries them.
import { siAmazons3, siLinkedin } from "si-legacy"
import type { GlyphName, IconName } from "./content.ts"

const BRANDS: Record<IconName, { path: string; hex: string }> = {
  github: siGithub, x: siX, linkedin: siLinkedin, discord: siDiscord,
  bun: siBun, sqlite: siSqlite, drizzle: siDrizzle, turso: siTurso, graphql: siGraphql,
  openapi: siOpenapiinitiative, s3: siAmazons3, cloudflare: siCloudflare, vercel: siVercel,
  prometheus: siPrometheus, opentelemetry: siOpentelemetry, docker: siDocker, fly: siFlydotio,
  clickhouse: siClickhouse, githubactions: siGithubactions,
}

/** The brand's own colour, and whether it is too dark (or too light) to read on that theme's paper. */
export function brandTone(name: IconName): { hex: string; tone: "dark" | "light" | "mid" } {
  const hex = BRANDS[name].hex
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const l = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  return { hex: `#${hex}`, tone: l < 0.12 ? "dark" : l > 0.6 ? "light" : "mid" }
}

export function brand(name: IconName, size = 18): string {
  const b = BRANDS[name]
  if (!b) throw new Error(`unknown icon: ${name}`)
  return `<svg class="brand" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="${b.path}"/></svg>`
}

const GLYPHS: Record<GlyphName, string> = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  terminal: '<path d="M5 7l4 5-4 5M12 17h7"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  replica: '<ellipse cx="9" cy="6" rx="5" ry="2"/><path d="M4 6v8c0 1.1 2.2 2 5 2M14 6v3"/><ellipse cx="15" cy="12" rx="5" ry="2"/><path d="M10 12v6c0 1.1 2.2 2 5 2s5-.9 5-2v-6"/>',
  shield: '<path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>',
  braces: '<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  check: '<path d="m2 12 5 5 9-10M12 16l1 1 9-10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  filecheck: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 15l2 2 4-4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 15l-3-3c1-4 4-8 10-9 1 0 2 1 2 2-1 6-5 9-9 10z"/><circle cx="15" cy="9" r="1"/>',
}

export function glyph(name: GlyphName, size = 16): string {
  return `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${GLYPHS[name]}</svg>`
}

/** Three stacked database platters with a message arrow through them: a server and a bus. */
const MARK_BODY =
  '<ellipse cx="16" cy="9" rx="8" ry="3"/><path d="M8 9v7c0 1.7 3.6 3 8 3s8-1.3 8-3V9"/><path d="M8 16v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'

export function productMark(size = 44): string {
  return `<span class="mark" style="width:${size}px;height:${size}px" aria-hidden="true"><svg width="${Math.round(size * 0.62)}" height="${Math.round(size * 0.62)}" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MARK_BODY}</svg></span>`
}

/** The favicon: the same mark on a near-black tile, as a standalone SVG document. */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f1f1f"/><g fill="none" stroke="#fafafa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(3.2 2.4) scale(.8)">${MARK_BODY}</g></svg>`
}

/**
 * The hero object: three database platters stacked in perspective, dark metal with a perforated
 * top and a cyan rim light underneath. Pure SVG, so it themes through currentColor-free fills.
 */
export function heroObject(): string {
  const platter = (y: number, i: number) => `<g transform="translate(0 ${y})">
<path d="M40 150v44c0 31 72 56 160 56s160-25 160-56v-44" fill="url(#hs${i})" stroke="url(#hr)" stroke-width="1.2"/>
<ellipse cx="200" cy="150" rx="160" ry="56" fill="url(#ht)" stroke="url(#hr)" stroke-width="1.2"/>
<ellipse cx="200" cy="150" rx="160" ry="56" fill="url(#hp)" opacity=".55"/>
<ellipse cx="200" cy="150" rx="118" ry="40" fill="none" stroke="oklch(100% 0 0 / .06)"/>
</g>`
  return `<svg class="hero-object" viewBox="0 0 400 470" role="img" aria-label="Three stacked database platters">
<defs>
<linearGradient id="ht" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b3d44"/><stop offset=".55" stop-color="#17181c"/><stop offset="1" stop-color="#0c0d10"/></linearGradient>
<linearGradient id="hs0" x1="0" x2="1"><stop offset="0" stop-color="#1b1c21"/><stop offset=".35" stop-color="#2c2e35"/><stop offset=".7" stop-color="#121317"/><stop offset="1" stop-color="#08090b"/></linearGradient>
<linearGradient id="hs1" x1="0" x2="1"><stop offset="0" stop-color="#18191e"/><stop offset=".35" stop-color="#292b32"/><stop offset=".7" stop-color="#101114"/><stop offset="1" stop-color="#07080a"/></linearGradient>
<linearGradient id="hs2" x1="0" x2="1"><stop offset="0" stop-color="#15161a"/><stop offset=".35" stop-color="#25272e"/><stop offset=".7" stop-color="#0e0f12"/><stop offset="1" stop-color="#060709"/></linearGradient>
<linearGradient id="hr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".22"/><stop offset="1" stop-color="#ffffff" stop-opacity=".04"/></linearGradient>
<pattern id="hp" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1" fill="#000" fill-opacity=".55"/></pattern>
<radialGradient id="hg" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="oklch(78% 0.13 205)" stop-opacity=".55"/><stop offset="1" stop-color="oklch(78% 0.13 205)" stop-opacity="0"/></radialGradient>
</defs>
<ellipse cx="200" cy="420" rx="170" ry="34" fill="url(#hg)"/>
${platter(150, 2)}${platter(75, 1)}${platter(0, 0)}
<path d="M58 395c40 22 244 22 284 0" fill="none" stroke="oklch(80% 0.12 205)" stroke-opacity=".7" stroke-width="1.5"/>
</svg>`
}
