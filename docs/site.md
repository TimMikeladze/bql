# The site

A static landing page and a reference page, generated from the repository's own READMEs by `site/`,
a private Bun workspace (`bql-site`). It follows the landing-page skill's frame, written in the
voice of the maintainer's global writing rules rather than the READMEs' own register.

## Rebuild (2026-10-23)

The page was rebuilt around what a new reader has to do, in the order they do it.

- **Hero.** H1 *A SQLite database server for Bun*. The lede says what it does: serves SQLite over
  HTTP, WebSockets and libsql's protocol, streams commits to replicas and S3, pushes live query
  diffs, and ships `bql.sh/bus`. The page does not lead with database-per-tenant; that is one use. The split demo is `client.ts` and its
  captured live-query diffs.
- **Why bql.sh.** SQLite is a library with no server; bql.sh adds one. Three columns: still SQLite,
  in process or served, as many databases as you need. Each names a command or option.
- **How it compares.** bql.sh against plain SQLite (`bun:sqlite`) and SQLite + Litestream, as a
  table resolved from the root README's *How it compares*. Litestream facts checked against
  litestream.io on 2026-10-23 (v0.5: S3 streaming, `restore -txid`/`-timestamp`, experimental
  read-only VFS replicas, sidecar process). On a phone the table stacks into labelled rows.
- **Getting started** is its own chapter, in procedure order: install and build the engine, run it
  in your process, start a server, mint a browser token, deploy. Every step's artefact is a run from
  the root README's Getting started, made against the published package in an empty directory.
- **The database**, **the bus**, then the ecosystem band, build today, guides. No benchmarks section.
- The page is for people using bql.sh. Nothing about how the site is built, what was left out or
  what is missing appears on it: no figures row of repo counts, no limits section, no build notes.
- Copy rules: one fact per sentence, the option in inline code, no em dashes, no slogans, no
  bold-led bullet lists, no decorative numbering.

## Layout (2026-10-23, second pass)

- **Notebook cells.** Code and the run that executed it are one frame: the file, then an Output
  strip with the captured lines. Used in the hero and in Getting started.
- **Getting started is a stepper.** An ordered list; the step's text stays sticky on the left while
  its cell scrolls on the right. Numbers appear only here, because the order matters.
- **Database and bus are explorers.** A feature list on the left, one panel on the right. Links
  target panels by id and CSS shows the targeted one (the first by default), so every feature is
  deep-linkable with no script. Without `:has()` or without CSS every panel shows in order. On a
  phone the list becomes a row of chips above the panel.
- Sections alternate paper and band backgrounds, so no two banded sections touch.

## Colour (2026-10-23)

The chrome is no longer greyscale. Each area of the page has one hue, set as `--h` by an `h-*` class
next to `hue`: hero 215, why 185, compare 300, getting started and the start band 150, showcase
268, database 245, bus 60. From it `.hue` derives `--tint-bg`, `--tint-ink`, `--tint-line` and
`--tint-soft`, with a light set under `[data-theme="light"]` and the `prefers-color-scheme`
fallback. Tinted bands are full-surface backgrounds; inside an area the hue colours inline code,
step numbers, the selected explorer item and tab, frame borders and bars, and guide cards.

Colour also carries meaning: in the comparison, Yes is green, No is muted, and the bql.sh column
sits on its own tint. Syntax colouring covers keywords, strings, numbers, comments, function calls,
types, shell commands and flags. The ecosystem marks use their brand colours, falling back to ink
when a mark is too dark or too light for the paper.

## What ships

- **`/`** the landing page, **`/reference`** the three READMEs in full behind a contents column.
- `index.md`, `reference.md`, `llms.txt`, `AGENTS.md`, `sitemap.xml`, `robots.txt`, `og.png`
  (1200×630), `favicon.svg`, `vercel.json` (`cleanUrls`).

## How it stays honest

- Examples live in the READMEs. `terminal(cmd)` and `snippet(line)` resolve against their fenced
  blocks at build time; zero or two matches throws.
- A README run block's `# ` lines are the captured output and render as output.
- Origin `https://bql.sh`; one `url(path)` helper derives every absolute URL, with clean URLs.
- Self-contained: one inline stylesheet, system fonts, brand marks inlined from `simple-icons`
  (CC0), the theme boot script (key `bql-theme`) and copy-to-clipboard.
- Code frames wrap and grow to fit. Only the tilted guide-card previews crop.
- Output is committed in `site/public/`; a test re-renders and compares byte for byte.

## Pieces

| file | role |
| --- | --- |
| `site/src/content.ts` | the page model: copy, section order, references, links. No markup |
| `site/src/source.ts` | parses the READMEs into sections and fenced blocks; `terminal`/`snippet` resolution |
| `site/src/markdown.ts` | a small escaping Markdown renderer for prose and the reference page |
| `site/src/render.ts` | HTML, CSS, head metadata, sibling artefacts. No copy |
| `site/src/icons.ts` | glyphs, brand marks, the product mark |
| `site/src/build.ts` | writes `site/public/` |
| `site/scripts/og.ts` | renders the card in headless Chrome at 1200×630 to `public/og.png` |
| `site/test/site.test.ts` | the section-9 assertions |

Root scripts: `site:build`, `site:og`; `bun run test` and `bun run typecheck` include the workspace.
