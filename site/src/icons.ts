// Icons are markup, so they live here. Two sets, never mixed: stroked glyphs on a 24 grid for
// controls, and real brand marks (simple-icons, CC0) filled with currentColor. Plus the product
// mark, the one decorative element on the page.

import {
  siBun, siCloudflare, siDiscord, siDocker, siDrizzle, siFlydotio, siGithub, siGraphql, siMinio,
  siOpenapiinitiative, siOpentelemetry, siPrometheus, siSqlite, siTurso, siX,
} from "simple-icons"
// LinkedIn and Amazon S3 were dropped from later simple-icons releases; v9 still carries them.
import { siAmazons3, siLinkedin } from "si-legacy"
import type { IconName } from "./content.ts"

const BRANDS: Record<IconName, { path: string }> = {
  github: siGithub, x: siX, linkedin: siLinkedin, discord: siDiscord,
  bun: siBun, sqlite: siSqlite, drizzle: siDrizzle, turso: siTurso, graphql: siGraphql,
  openapi: siOpenapiinitiative, s3: siAmazons3, cloudflare: siCloudflare, minio: siMinio,
  prometheus: siPrometheus, opentelemetry: siOpentelemetry, docker: siDocker, fly: siFlydotio,
}

export function brand(name: IconName, size = 18): string {
  const b = BRANDS[name]
  if (!b) throw new Error(`unknown icon: ${name}`)
  return `<svg class="brand" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="${b.path}"/></svg>`
}

export type GlyphName = "copy" | "sun" | "moon" | "monitor" | "book" | "arrow" | "terminal" | "file" | "hash"

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
