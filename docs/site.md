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

## Layout (2026-10-23, third pass, after resend.com)

- **Black page, space between sections.** No bands. Sections are separated by padding; the paper
  token went from 12.5% to 9% lightness.
- **Hero.** Copy on the left (a version badge, a serif H1, the lede, a solid-outline Get started
  pill beside a plain Documentation link, the humans/agents install switch), an SVG object on the
  right: three dark database platters with a perforated top and a cyan rim light. A soft glow sits
  behind it. The header centres its links and ends in a Get started pill.
- **Section heads** are large sans with a muted tail (`SQLite, plus the server` / `it never had`).
  Centred heads get a glossy glyph tile above them.
- **Overview grid.** Nine features as glyph, title, two lines.
- **Live query panel.** One window: `client.ts` with line numbers on the left, the captured diffs
  drawn as an event timeline on the right (`added`/`removed` tags, the row as key/value chips),
  parsed from the README run, plus the query text pulled out of the code.
- **Code tabs.** An icon row (Client, Embedded, libsql, Drizzle, Kysely, Driver) over one
  line-numbered window with a footer.
- **Feature cards.** Database and bus capabilities are two-up cards: the artefact on top, then the
  glyph, title, explanation and a Reference link. An odd last card spans both columns.
- **Closing.** A serif "Start a server in one command", the two actions, the command, and a giant
  faded `bql.sh` wordmark above the footer.
- Code never clips: frames wrap and grow.

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
