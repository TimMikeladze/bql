// The page model: the copy, the section order, which README block each section shows, and the link
// table. No markup; render.ts owns that. Examples are references into the READMEs (see source.ts),
// never text written here.

import type { Where } from "./source.ts"

export type IconName =
  | "github" | "x" | "linkedin" | "discord"
  | "bun" | "sqlite" | "drizzle" | "turso" | "graphql" | "openapi" | "s3" | "cloudflare" | "vercel"
  | "prometheus" | "opentelemetry" | "docker" | "fly" | "clickhouse" | "githubactions"

/** Stroked glyphs drawn in icons.ts; naming one that does not exist fails the type-check. */
export type GlyphName =
  | "copy" | "sun" | "moon" | "monitor" | "book" | "arrow" | "terminal" | "file" | "hash"
  | "globe" | "activity" | "replica" | "shield" | "cloud" | "branch" | "search" | "key" | "layers"
  | "plug" | "braces" | "send" | "inbox" | "check" | "clock" | "upload" | "filecheck" | "download"
  | "server" | "rocket"

/** One artefact: a captured run, a code block, or a table from a README. */
export type Frame =
  | { kind: "terminal"; cmd: string; where: Where }
  | { kind: "snippet"; line: string; label: string; where: Where }
  | { kind: "table"; header: string; where: Where }

export type Demo =
  | Frame
  /** Two artefacts side by side, usually the code and what it printed. A table in a pair stacks. */
  | { kind: "pair"; items: [Frame, Frame] }
  | { kind: "variants"; items: { line: string; label: string; caption: string; where: Where }[] }
  /** A notebook cell: a code block with the run that executed it attached underneath. */
  | { kind: "cell"; code: { line: string; label: string; where: Where }; run: { cmd: string; where: Where } }

export type Chapter = "start" | "db" | "bus"

export interface Capability {
  id: string
  chapter: Chapter
  title: string
  /** Inline Markdown, 1 to 3 sentences, at least one `code`. */
  body: string
  icon: GlyphName
  demo: Demo
}

export interface Link {
  label: string
  /** "repo" follows `repo` below. */
  href: string
  icon: IconName | "text"
  where: ("header" | "footer")[]
}

const G = "https://github.com/TimMikeladze/bql/blob/main"
const root: Where = { doc: "root" }
const db: Where = { doc: "db" }
const bus: Where = { doc: "bus" }

export const site = {
  name: "bql.sh",
  origin: "https://bql.sh",
  repo: "https://github.com/TimMikeladze/bql",
  npm: "https://www.npmjs.com/package/bql.sh",
  themeKey: "bql-theme",
  title: "bql.sh: a SQLite database server for Bun",
  tagline: "a SQLite database server for Bun",
  description:
    "bql.sh is a SQLite database server for Bun, with replicas, S3 backup, branches, live queries and search, plus a durable message bus.",
  license: "MIT",
  year: 2026,

  h1: "A SQLite database server for Bun",
  lede:
    "`bql.sh` serves SQLite over HTTP, WebSockets and libsql's protocol. It streams every commit to replicas and S3, pushes live query diffs to clients, and ships `bql.sh/bus`, a message bus on the same engine. Built on [Bun](https://bun.sh) by [linesofcode](https://x.com/linesofcode).",

  install: {
    humans: { cmd: "bun add bql.sh", where: { doc: "root", section: "bql.sh" } as Where },
    agents: "curl https://bql.sh/llms.txt",
    note: "MIT, Bun 1.4+",
  },

  // The hero demo: a live query and the diffs it printed, from the README's Getting started.
  hero: {
    kind: "cell",
    code: { line: "const live = db.live`select id, title from todos where done = 0`.key(\"id\")", label: "client.ts", where: root },
    run: { cmd: "BQL_ADMIN_KEY=<the admin key> bun client.ts", where: root },
  } satisfies Demo,

  overview: {
    title: "SQLite, plus the server",
    muted: "it never had",
    body: "SQLite is fast and runs anywhere, but it's a library: no network access, no replicas, no backups and no way to subscribe to a query. bql.sh adds those and leaves every database a SQLite file.",
    items: [
      { icon: "globe", title: "Network access", body: "HTTP, WebSockets and libsql's Hrana protocol, so any process, browser or machine can query a database." },
      { icon: "activity", title: "Live queries", body: "`db.live` sends the rows a commit added or removed. It runs off SQLite's `preupdate` hook, not triggers." },
      { icon: "replica", title: "Replicas", body: "WAL frames stream to replicas over a WebSocket. A replica serves reads and forwards writes to the primary." },
      { icon: "shield", title: "Failover", body: "`bql promote` fences the old primary by epoch. With `[cluster]` on, Raft promotes a replica on its own." },
      { icon: "cloud", title: "Backups to S3", body: "Every commit ships to S3, R2 or Tigris in the background. `bql restore` rebuilds any txid or timestamp." },
      { icon: "branch", title: "Branches", body: "`bql db branch` forks a database as a reflink copy and records its parent, so a branch per pull request costs a directory." },
      { icon: "search", title: "Search", body: "`bql.sh/search` builds sqlite-vec, FTS5 and R*Tree queries, with hybrid ranking in one statement." },
      { icon: "key", title: "Scoped tokens", body: "Tokens scoped to databases, tables and `ro` or `rw`, safe to hand to a browser." },
      { icon: "layers", title: "Embedded or served", body: "`Bql.open()` runs the engine in your process. `bq.serve()` adds HTTP later and your code stays the same." },
    ] as { icon: GlyphName; title: string; body: string }[],
  },

  live: {
    title: "Watch a query change",
    body: "`db.live` runs a query once, then sends the rows each commit added or removed. This is `client.ts` from the README and what it printed.",
  },

  compare: {
    title: "How it compares",
    muted: "to SQLite and Litestream",
    body: "Plain SQLite is enough when one process owns the file. [Litestream](https://litestream.io) adds continuous backup to that setup without changing your code. bql.sh is for when other processes, browsers or machines need the database, or you want replicas and live queries.",
    table: { header: "SQLite + Litestream", where: root },
  },

  showcase: {
    title: "One db,",
    muted: "every way in",
    body: "`createClient()` over HTTP, `Bql.open()` in your process, `@libsql/client` over Hrana, an ORM, or the `bun:ffi` driver on its own.",
    tabs: [
      { label: "Client", icon: "globe", file: "client.ts", line: "const client = createClient({ url: \"http://localhost:4321\", token })   // token, or the admin key", where: db },
      { label: "Embedded", icon: "layers", file: "embedded.ts", line: "const bq = await Bql.open({ dir: \"./data\" })", where: { doc: "db", section: "Embedded" } },
      { label: "libsql", icon: "plug", file: "libsql.ts", line: "const primary = createClient({ url: \"http://127.0.0.1:4501/v1/db/acme/\", authToken: KEY })", where: db },
      { label: "Drizzle", icon: "braces", file: "drizzle.ts", line: "const db = drizzle({ url: \"http://localhost:4321\", token, db: \"acme\" }, { schema: { todos } })", where: db },
      { label: "Kysely", icon: "braces", file: "kysely.ts", line: "dialect: new BqlDialect({ url: \"http://localhost:4321\", token, db: \"acme\" }),", where: db },
      { label: "Driver", icon: "terminal", file: "driver.ts", line: "const db = Database.open(\"app.db\")", where: db },
    ] as { label: string; icon: GlyphName; file: string; line: string; where: Where }[],
  },

  chapters: {
    start: {
      id: "start", pkg: "bun add bql.sh", title: "Getting started", muted: "in five steps", href: "/reference#root-getting-started",
      body: "From an empty directory to a deployed server. Each output below was captured against the published `bql.sh` package.",
    },
    db: {
      id: "database", pkg: "bql.sh", title: "The database", muted: "past SQL", href: "/reference#db",
      body: "Replication, backups, branches and search, each with the code that runs it and what it printed.",
    },
    bus: {
      id: "bus", pkg: "bql.sh/bus", title: "A message bus", muted: "on the same engine", href: "/reference#bus",
      body: "`bql.sh/bus` keeps its messages in a bql.sh database, so it replicates and backs up the same way your data does.",
    },
  } satisfies Record<Chapter, { id: string; pkg: string; title: string; muted: string; href: string; body: string }>,

  capabilities: [
    // ---- getting started, in the order you do it ----
    {
      id: "install",
      icon: "download",
      chapter: "start",
      title: "Install",
      body: "Add `bql.sh`, then build the libsqlite3 its driver loads. The driver needs the preupdate hook and the session extension, so the package compiles its own SQLite once, in about 15 seconds, with any C compiler.",
      demo: { kind: "terminal", cmd: "bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts", where: root },
    },
    {
      id: "embedded",
      icon: "layers",
      chapter: "start",
      title: "Run it in your process",
      body: "`Bql.open()` is the whole engine with no server in front. Every write returns the `txid` it committed in.",
      demo: {
        kind: "cell",
        code: { line: "const bq = await Bql.open({ dir: \"./data\" })", label: "app.ts", where: root },
        run: { cmd: "bun app.ts", where: root },
      },
    },
    {
      id: "serve",
      icon: "server",
      chapter: "start",
      title: "Start a server",
      body: "`bql serve` prints an admin key the first time it starts and saves it to `keys.json`. The CLI and the client use it as `BQL_ADMIN_KEY`.",
      demo: { kind: "terminal", cmd: "bunx bql serve --dir ./srv --port 4321", where: root },
    },
    {
      id: "token",
      icon: "key",
      chapter: "start",
      title: "Give the browser a token",
      body: "Never ship the admin key to a browser. `admin.mintToken` makes a token scoped to databases, tables and `ro` or `rw`, and anything outside it answers `NOT_AUTHORIZED`.",
      demo: {
        kind: "cell",
        code: { line: "const { token } = await admin.mintToken({ dbs: [\"acme\"], scope: \"ro\", ttlMs: 3_600_000 })", label: "token.ts", where: root },
        run: { cmd: "BQL_ADMIN_KEY=<the admin key> bun token.ts", where: root },
      },
    },
    {
      id: "deploy",
      icon: "rocket",
      chapter: "start",
      title: "Deploy it",
      body: "`bql deploy` provisions a server on Fly, Vercel or Cloudflare through the provider CLI you're already logged in to, then saves the connection so `bql db list` talks to it. Vercel and Cloudflare are experimental and keep data in Blob or R2.",
      demo: {
        kind: "pair",
        items: [
          { kind: "terminal", cmd: "bql deploy init --provider vercel --scope my-team", where: root },
          { kind: "table", header: "Compute", where: root },
        ],
      },
    },

    // ---- the database ----
    {
      id: "replicas",
      icon: "replica",
      chapter: "db",
      title: "Replicas",
      body: "Start a second server with `--replica-of`. It follows every database on the primary, serves reads locally and forwards writes, answering with the primary's txid.",
      demo: { kind: "terminal", cmd: "curl -sD- -H \"authorization: Bearer $KEY\" -H 'content-type: application/json' \\", where: db },
    },
    {
      id: "failover",
      icon: "shield",
      chapter: "db",
      title: "Failover",
      body: "`bql promote acme` moves a database to a replica and fences the old primary by epoch. With `[cluster]` on, Raft does it when the primary's lease runs out. Write with `ack: \"replica\"` and a failover loses no acknowledged write.",
      demo: { kind: "terminal", cmd: "bql promote acme --url http://127.0.0.1:4502", where: db },
    },
    {
      id: "backup",
      icon: "cloud",
      chapter: "db",
      title: "Backups to S3",
      body: "Pass `--s3` and every commit ships to the bucket in the background; a slow bucket never slows a write. `bql restore` rebuilds a database at any txid or timestamp on a node that has never seen it.",
      demo: { kind: "terminal", cmd: "bql backup status acme", where: { doc: "db", section: "Back it up to a bucket" } },
    },
    {
      id: "branches",
      icon: "branch",
      chapter: "db",
      title: "A database per pull request",
      body: "`bql db branch` forks a database and records its parent. The `bql-branch` GitHub Action creates one when a pull request opens and deletes it when it closes.",
      demo: {
        kind: "pair",
        items: [
          { kind: "terminal", cmd: "bql db branch pr-42 --from main", where: { doc: "db", section: "Branches" } },
          { kind: "snippet", line: "uses: TimMikeladze/bql/.github/actions/bql-branch@main", label: "db-branch.yml", where: root },
        ],
      },
    },
    {
      id: "search",
      icon: "search",
      chapter: "db",
      title: "Vector, full-text and geo search",
      body: "`bql.sh/search` builds sqlite-vec, FTS5 and R*Tree queries out of plain SQL. `hybridSearch` fuses bm25 and vector rank in one statement, and it all runs on a primary, a replica or in your process.",
      demo: { kind: "snippet", line: "tokenizer: \"porter unicode61\"", label: "search.ts", where: db },
    },
    {
      id: "orms",
      icon: "plug",
      chapter: "db",
      title: "Your ORM already works",
      body: "The server speaks libsql's Hrana protocol, so `@libsql/client` connects as is. `bql.sh/kysely` and `bql.sh/drizzle` run transactions and migrations on bql.sh's own routes.",
      demo: {
        kind: "variants",
        items: [
          { line: "const replica = createClient({ url: \"http://127.0.0.1:4502/v1/db/acme/\", authToken: KEY })", label: "libsql.ts", caption: "@libsql/client over Hrana", where: db },
          { line: "dialect: new BqlDialect({ url: \"http://localhost:4321\", token, db: \"acme\" }),", label: "kysely.ts", caption: "bql.sh/kysely, BqlDialect", where: db },
          { line: "const db = drizzle({ url: \"http://localhost:4321\", token, db: \"acme\" }, { schema: { todos } })", label: "drizzle.ts", caption: "bql.sh/drizzle, drizzle()", where: db },
        ],
      },
    },
    {
      id: "rest",
      icon: "braces",
      chapter: "db",
      title: "REST, OpenAPI and GraphQL",
      body: "Every database gets a REST API and an OpenAPI 3.1 document generated from its own tables, and GraphQL once the optional `graphql` peer is installed. Requests go through the same token checks, row cap and write forwarding as SQL.",
      demo: { kind: "snippet", line: "GET    /v1/db/acme/openapi.json       that database's OpenAPI 3.1 document", label: "routes.http", where: db },
    },
    {
      id: "outbox",
      icon: "send",
      chapter: "db",
      title: "Row changes onto the bus",
      body: "An `[[outbox.rules]]` entry publishes every committed row change to a bus subject. It reads the durable log and moves its cursor only after the bus acknowledged, so a crash neither loses nor repeats a change.",
      demo: {
        kind: "pair",
        items: [
          { kind: "snippet", line: "subject = \"db.{db}.{table}\"    # the default", label: "bql.toml", where: db },
          { kind: "terminal", cmd: "bql bus subscribe cdc 'db.app-1.>'", where: db },
        ],
      },
    },

    // ---- the bus ----
    {
      id: "queue",
      icon: "inbox",
      chapter: "bus",
      title: "Queue, pub/sub and request/reply",
      body: "Publish to a subject, and each subscription reads it with its own cursor, leases, retries and a dead-letter subject. `bql bus consume --exec` turns any script into a consumer: the message arrives on stdin.",
      demo: {
        kind: "pair",
        items: [
          { kind: "terminal", cmd: "bql bus publish work.resize '{\"src\":\"a.png\"}'", where: { doc: "bus", section: "bql.sh/bus" } },
          { kind: "snippet", line: "await new BusConsumer({", label: "consumer.ts", where: bus },
        ],
      },
    },
    {
      id: "exactly-once",
      icon: "check",
      chapter: "bus",
      title: "Exactly-once, three ways",
      body: "Delivery is at-least-once by default. `api.emit` publishes in the same commit as the ack, and `api.effect` records an outside call so a redelivery replays the result instead of repeating the call.",
      demo: {
        kind: "pair",
        items: [
          { kind: "table", header: "Tier", where: bus },
          { kind: "snippet", line: "api.emit({ subject: \"thumbnails.ready\", body: { id: message.body.id } });", label: "handler.ts", where: bus },
        ],
      },
    },
    {
      id: "schedules",
      icon: "clock",
      chapter: "bus",
      title: "Cron schedules",
      body: "`bql bus schedule add` publishes an ordinary message on each fire, once per slot, in any IANA time zone. `catchUp` decides what happens to slots missed while the bus was down.",
      demo: {
        kind: "pair",
        items: [
          { kind: "terminal", cmd: "bql bus schedule add nightly '30 2 * * *' reports.nightly '{\"kind\":\"daily\"}' --tz America/New_York", where: bus },
          { kind: "snippet", line: "await bus.putSchedule({ name: \"nightly\"", label: "schedule.ts", where: bus },
        ],
      },
    },
    {
      id: "sinks",
      icon: "upload",
      chapter: "bus",
      title: "Sinks to webhooks, S3 and ClickHouse",
      body: "`bql bus sink` writes a subscription in batches and acks only once the destination took the batch. With the outbox in front, committed rows reach a warehouse with no code.",
      demo: {
        kind: "pair",
        items: [
          { kind: "snippet", line: "bql bus sink clickhouse --subscription olap", label: "sinks.sh", where: bus },
          { kind: "snippet", line: "writer: webhookSink({", label: "sink.ts", where: bus },
        ],
      },
    },
    {
      id: "schemas",
      icon: "filecheck",
      chapter: "bus",
      title: "Schemas on subjects",
      body: "Register a JSON Schema with `--compat backward` and bind it to a subject pattern in `warn` mode, then `enforce`. A version that breaks the declared compatibility is refused with the failing pointer.",
      demo: { kind: "terminal", cmd: "bql bus schema register order ./order.json --compat backward", where: bus },
    },
  ] satisfies Capability[],

  ecosystem: {
    title: "Speaks to what you already run",
    lede: "Drizzle, Kysely and `@libsql/client` connect over Hrana. Backups go to S3, R2 or Tigris. Sinks write to webhooks and ClickHouse, and `bql deploy` targets Fly, Vercel and Cloudflare.",
    marks: [
      { icon: "bun", label: "Bun", href: "https://bun.sh" },
      { icon: "sqlite", label: "SQLite", href: "https://sqlite.org" },
      { icon: "drizzle", label: "Drizzle", href: "https://orm.drizzle.team" },
      { icon: "turso", label: "@libsql/client", href: "https://github.com/tursodatabase/libsql-client-ts" },
      { icon: "graphql", label: "GraphQL", href: "https://graphql.org" },
      { icon: "openapi", label: "OpenAPI 3.1", href: "https://www.openapis.org" },
      { icon: "s3", label: "Amazon S3", href: "https://aws.amazon.com/s3/" },
      { icon: "cloudflare", label: "Cloudflare", href: "https://www.cloudflare.com/developer-platform/r2/" },
      { icon: "vercel", label: "Vercel", href: "https://vercel.com" },
      { icon: "fly", label: "Fly.io", href: "https://fly.io" },
      { icon: "clickhouse", label: "ClickHouse", href: "https://clickhouse.com" },
      { icon: "githubactions", label: "GitHub Actions", href: "https://github.com/features/actions" },
      { icon: "prometheus", label: "Prometheus", href: "https://prometheus.io" },
      { icon: "opentelemetry", label: "OpenTelemetry", href: "https://opentelemetry.io" },
    ] as { icon: IconName; label: string; href: string }[],
  },

  cta: {
    title: "Start a server",
    muted: "in one command",
    cmd: "bunx bql serve --dir ./srv --port 4321",
    where: root,
  },

  credit:
    "bql.sh is built by [linesofcode](https://x.com/linesofcode), who also wrote [dagr](https://github.com/TimMikeladze/dagr), a workflow engine on one SQLite journal that sends remote steps over `bql.sh/bus`.",

  nav: [
    { label: "Getting started", href: "/#start" },
    { label: "Compare", href: "/#compare" },
    { label: "Database", href: "/#database" },
    { label: "Bus", href: "/#bus" },
    { label: "Reference", href: "/reference" },
    { label: "npm", href: "https://www.npmjs.com/package/bql.sh" },
  ],

  links: [
    { label: "TimMikeladze/bql on GitHub", href: "repo", icon: "github", where: ["header", "footer"] },
    { label: "linesofcode on X", href: "https://x.com/linesofcode", icon: "x", where: ["header", "footer"] },
    { label: "linesofcode on LinkedIn", href: "https://www.linkedin.com/in/tim-mikeladze", icon: "linkedin", where: ["header", "footer"] },
    { label: "linesofcode on Discord", href: "https://discord.com/users/linesofcode", icon: "discord", where: ["footer"] },
  ] as Link[],

  footer: [
    { title: "bql.sh", links: [
      { label: "Home", href: "/" },
      { label: "Reference", href: "/reference" },
      { label: "llms.txt", href: "/llms.txt" },
      { label: "AGENTS.md", href: "/AGENTS.md" },
    ] },
    { title: "Database", links: [
      { label: "README", href: "https://github.com/TimMikeladze/bql/tree/main/packages/db" },
      { label: "API", href: `${G}/packages/db/docs/api.md` },
      { label: "Search", href: `${G}/packages/db/docs/x1-search.md` },
      { label: "Branches", href: `${G}/packages/db/docs/x2-branching.md` },
    ] },
    { title: "Bus", links: [
      { label: "README", href: "https://github.com/TimMikeladze/bql/tree/main/packages/bus" },
      { label: "Exactly-once", href: `${G}/packages/bus/docs/exactly-once.md` },
      { label: "Schedules", href: `${G}/packages/bus/docs/x5-schedules.md` },
      { label: "Operations", href: `${G}/packages/bus/docs/operations.md` },
    ] },
    { title: "Learn", links: [
      { label: "Design", href: `${G}/packages/db/docs/design.md` },
      { label: "Outbox", href: `${G}/packages/db/docs/x6-outbox.md` },
      { label: "Cloud deployments", href: `${G}/packages/db/docs/cloud-deployments.md` },
      { label: "Performance", href: `${G}/packages/db/docs/performance.md` },
    ] },
    { title: "Community", links: [
      { label: "GitHub", href: "repo" },
      { label: "Issues", href: "https://github.com/TimMikeladze/bql/issues" },
      { label: "npm", href: "https://www.npmjs.com/package/bql.sh" },
      { label: "X", href: "https://x.com/linesofcode" },
    ] },
    { title: "Legal", links: [
      { label: "MIT License", href: `${G}/LICENSE` },
    ] },
  ] as { title: string; links: { label: string; href: string; released?: string }[] }[],
} as const

export type Site = typeof site
