# The site

A static landing page and a reference page for the repository, generated from its own READMEs.
Built by `site/`, a private Bun workspace (`bql-site`), following the landing-page skill spec.

## Redesign (2026-09-28): terser, example-first

- Every capability explanation is one or two sentences; the artefact carries the rest.
- A capability may show a **pair** — the code and what it prints, side by side — instead of one frame.
- Capabilities sit under two chapter rules, `bql.sh` (the database) and `bql.sh/bus` (the bus).
- New sections for what landed since: search, branches, outbox, schedules, sinks.
- Install is `bun add bql.sh` (published); the start panels are that plus the by-path engine build.
- H2 and explanation sit side by side on desktop, so each section's prose costs one row, not three.

## What

- **`/`** — the landing page. Claim: *SQLite as a database server, and a bus*. A centred hero with a
  For humans / For agents switch, a split demo (a `bql bus publish` on the left, the `BusConsumer`
  that handles it on the right), repo-counted figures, the ecosystem band, three principles, a tabbed
  showcase of the client APIs, one section per capability, the measured tables, boundaries, build
  today, guides, mega-footer.
- **`/reference`** — the three READMEs (root, `packages/db`, `packages/bus`) rendered in full behind a
  sticky contents column.
- Alongside: `index.md`, `reference.md`, `llms.txt`, `AGENTS.md`, `sitemap.xml`, `robots.txt`,
  `og.png` (1200×630), `favicon.svg`, `vercel.json` (`cleanUrls`).

## Approach

- **Examples live in the READMEs, never in the generator.** `terminal(cmd)` and `snippet(line)`
  resolve against the fenced blocks of the three READMEs at build time; zero or two matches throws.
  Figures are regexes over those blocks, or counts over the repo (test files, runtime dependencies).
- No npm or GitHub figures yet: the package was just published and a download count would say
  nothing. Figures are repo counts and README benchmarks. The hero states the version.
- Origin `https://bql.dev` is a placeholder — nothing in the repo names a domain. One `url(path)`
  helper derives every absolute URL from it, with clean URLs.
- Self-contained output: one inline stylesheet, system fonts, brand marks inlined from
  `simple-icons` (CC0) at build time, one inline theme boot script (key `bql-theme`) plus
  copy-to-clipboard.
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
| `site/scripts/og.ts` | renders `og/card.html` in headless Chrome at 1200×630 to `public/og.png` |
| `site/test/site.test.ts` | the section-9 assertions |

Root scripts: `site:build`, `site:og`; `bun run test` and `bun run typecheck` include the workspace.

## Left off

- **Adjacent tools** — the only sibling is dagr, which has no install command in this repo to resolve.
- **Figures from npm/GitHub** — nothing published yet; repo counts and README benchmarks stand in.
- The build-today chip is `bunx bql bus serve` (no `create-*` scaffold exists).
