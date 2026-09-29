// The page model: composition, copy, section order, which captured example each section shows,
// and the link table. No markup — the renderer owns that. Examples are *references* into the
// READMEs (see source.ts), never text written here.

import type { DocId, RepoCount, Where } from "./source.ts"

export type IconName =
  | "github" | "x" | "linkedin" | "discord"
  | "bun" | "sqlite" | "drizzle" | "turso" | "graphql" | "openapi" | "s3" | "cloudflare"
  | "minio" | "prometheus" | "opentelemetry" | "docker" | "fly" | "clickhouse" | "githubactions"

/** One artefact: a captured run, a code block, or a table from a README. */
export type Frame =
  | { kind: "terminal"; cmd: string; where: Where }
  | { kind: "snippet"; line: string; label: string; where: Where }
  | { kind: "table"; header: string; where: Where }

export type Demo =
  | Frame
  /** Two artefacts side by side — the code and what it prints. A table in a pair stacks. */
  | { kind: "pair"; items: [Frame, Frame] }
  | { kind: "variants"; items: { line: string; label: string; caption: string; where: Where }[] }

export type Chapter = "db" | "bus"

export interface Capability {
  id: string
  chapter: Chapter
  title: string
  /** Inline Markdown, 1–2 sentences, at least one `code`. */
  body: string
  demo: Demo
}

export type FigureSource =
  | { kind: "count"; count: RepoCount }
  | { kind: "regex"; doc: DocId; re: RegExp; unit?: string }

export interface Figure {
  label: string
  from: FigureSource
}

export interface Link {
  label: string
  /** "repo" follows `repo` below. */
  href: string
  icon: IconName | "text"
  where: ("header" | "footer")[]
}

const G = "https://github.com/TimMikeladze/bql/blob/main"

export const site = {
  name: "bql.sh",
  origin: "https://bql.sh", // where it is deployed, and the package name
  repo: "https://github.com/TimMikeladze/bql",
  npm: "https://www.npmjs.com/package/bql.sh",
  themeKey: "bql-theme",
  title: "bql.sh — SQLite as a database server, and a durable message bus",
  tagline: "SQLite as a server, and a bus",
  description:
    "bql.sh serves thousands of SQLite databases from one Bun process, with replicas, S3 backup, realtime and search, beside a durable message bus.",
  license: "MIT",
  year: 2026,

  h1: "SQLite as a server, and a durable bus",
  lede:
    "`bql.sh` serves thousands of SQLite databases from one process. `bql.sh/bus` runs the work against them. Built on [Bun](https://bun.sh), zero runtime dependencies, by [linesofcode](https://x.com/linesofcode).",

  install: {
    humans: { cmd: "bun add bql.sh", where: { doc: "root" } as Where },
    agents: "curl https://bql.sh/llms.txt",
    note: "on npm, Bun 1.4+",
  },

  split: {
    left: { cmd: "bql bus publish work.resize '{\"src\":\"a.png\"}'", where: { doc: "bus", section: "bql.sh/bus" } as Where, label: "terminal" },
    right: { line: "await new BusConsumer({", where: { doc: "bus" } as Where, label: "consumer.ts" },
  },

  figures: [
    { label: "test files", from: { kind: "count", count: "testFiles" } },
    { label: "runtime dependencies", from: { kind: "count", count: "runtimeDependencies" } },
    { label: "writes/s, 64 clients", from: { kind: "regex", doc: "db", re: /~(\d+k) writes\/s at 64/ } },
    { label: "point read over HTTP", from: { kind: "regex", doc: "db", re: /a point read is\s+(\d+ µs)/, unit: "" } },
  ] satisfies Figure[],

  ecosystem: {
    title: "Reached by what you already run",
    lede: "Drizzle, Kysely and `@libsql/client` on top. S3, R2 or MinIO underneath. ClickHouse and webhooks downstream.",
    marks: [
      { icon: "bun", label: "Bun", href: "https://bun.sh" },
      { icon: "sqlite", label: "SQLite", href: "https://sqlite.org" },
      { icon: "drizzle", label: "Drizzle", href: "https://orm.drizzle.team" },
      { icon: "turso", label: "@libsql/client", href: "https://github.com/tursodatabase/libsql-client-ts" },
      { icon: "graphql", label: "GraphQL", href: "https://graphql.org" },
      { icon: "openapi", label: "OpenAPI 3.1", href: "https://www.openapis.org" },
      { icon: "s3", label: "Amazon S3", href: "https://aws.amazon.com/s3/" },
      { icon: "cloudflare", label: "Cloudflare R2", href: "https://www.cloudflare.com/developer-platform/r2/" },
      { icon: "minio", label: "MinIO", href: "https://min.io" },
      { icon: "clickhouse", label: "ClickHouse", href: "https://clickhouse.com" },
      { icon: "githubactions", label: "GitHub Actions", href: "https://github.com/features/actions" },
      { icon: "prometheus", label: "Prometheus", href: "https://prometheus.io" },
      { icon: "opentelemetry", label: "OpenTelemetry", href: "https://opentelemetry.io" },
      { icon: "fly", label: "Fly.io", href: "https://fly.io" },
    ] as { icon: IconName; label: string; href: string }[],
  },

  principles: [
    { title: "Zero runtime dependencies", body: "No `dependencies` field. The OTLP exporter and the schema validator are written, not installed." },
    { title: "The write path never waits", body: "A write checks a lease held in memory. Raft and S3 run beside the commit, never in front." },
    { title: "Refuse rather than guess", body: "Promotion answers `BEHIND`. An unknown schema keyword fails. Past 2^53 is never rounded." },
  ],

  showcase: {
    title: "One engine, four ways in",
    body: "A tagged template over HTTP, a synchronous call in your process, a raw `bun:ffi` driver — or a bus handler inside the transaction that acks it.",
    supports: ["bun", "drizzle", "turso", "graphql", "openapi"] as IconName[],
    tabs: [
      { label: "Client", file: "client.ts", line: "const client = createClient({ url: \"http://localhost:4321\", token })   // token, or the admin key", where: { doc: "db" } as Where },
      { label: "Embedded", file: "embedded.ts", line: "const bq = await Bql.open({ dir: \"./data\" })", where: { doc: "db" } as Where },
      { label: "Driver", file: "driver.ts", line: "const db = Database.open(\"app.db\")", where: { doc: "db" } as Where },
      { label: "Transactional ack", file: "bus.ts", line: "bus.consumeTransactional({", where: { doc: "bus" } as Where },
    ],
  },

  chapters: {
    db: { id: "database", pkg: "bql.sh", title: "The database", href: "/reference#db" },
    bus: { id: "bus", pkg: "bql.sh/bus", title: "The bus", href: "/reference#bus" },
  } satisfies Record<Chapter, { id: string; pkg: string; title: string; href: string }>,

  capabilities: [
    {
      id: "realtime",
      chapter: "db",
      title: "Realtime from SQLite's hooks",
      body: "`db.live` diffs a query; `/changes` streams every commit as SSE. Driven by `preupdate`, not triggers.",
      demo: {
        kind: "pair",
        items: [
          { kind: "snippet", line: "live.on(\"diff\", (e) => patch(e.added, e.removed, e.updated))", label: "live.ts", where: { doc: "root" } },
          { kind: "terminal", cmd: "curl -N \"localhost:4321/v1/db/acme/changes?include=row&token=$TOKEN\"", where: { doc: "db" } },
        ],
      },
    },
    {
      id: "txid",
      chapter: "db",
      title: "Every write returns a txid",
      body: "The client sends the highest it has seen as `BQL-Min-Txid`, so a read never goes backwards.",
      demo: { kind: "terminal", cmd: "curl -sX POST localhost:4321/v1/db -H \"authorization: Bearer $KEY\" \\", where: { doc: "db" } },
    },
    {
      id: "search",
      chapter: "db",
      title: "Vector, full-text, hybrid, geo",
      body: "`bql.sh/search` builds it out of SQL, so it runs on a primary, a replica or in-process alike.",
      demo: { kind: "snippet", line: "tokenizer: \"porter unicode61\"", label: "search.ts", where: { doc: "db" } },
    },
    {
      id: "replicas",
      chapter: "db",
      title: "Replicas that forward writes",
      body: "Start a node with `--replica-of`. It reads locally and answers a forwarded write with the primary's txid.",
      demo: {
        kind: "pair",
        items: [
          { kind: "terminal", cmd: "curl -sD- -H \"authorization: Bearer $KEY\" -H 'content-type: application/json' \\", where: { doc: "db" } },
          { kind: "snippet", line: "await replica.execute(\"insert into notes (body) values ('nope')\")", label: "libsql.ts", where: { doc: "db" } },
        ],
      },
    },
    {
      id: "promotion",
      chapter: "db",
      title: "Promotion that refuses to guess",
      body: "`bql promote` fences the old primary by epoch. `--force` overrides exactly three refusals.",
      demo: { kind: "terminal", cmd: "bql promote acme --url http://127.0.0.1:4502", where: { doc: "db" } },
    },
    {
      id: "branches",
      chapter: "db",
      title: "A database per pull request",
      body: "`bql db branch` is an O(1) fork that remembers its parent. The `bql-branch` action opens and closes one per PR.",
      demo: {
        kind: "pair",
        items: [
          { kind: "terminal", cmd: "bql db branch pr-42 --from main", where: { doc: "db", section: "Branches" } },
          { kind: "snippet", line: "uses: TimMikeladze/bql/.github/actions/bql-branch@main", label: "db-branch.yml", where: { doc: "root" } },
        ],
      },
    },
    {
      id: "backup",
      chapter: "db",
      title: "Backed up to any bucket",
      body: "Pass `--s3` and every log and snapshot ships continuously. A slow bucket reports `behind`; it never slows a commit.",
      demo: { kind: "terminal", cmd: "bql backup status acme", where: { doc: "db", section: "Back it up to a bucket" } },
    },
    {
      id: "outbox",
      chapter: "db",
      title: "Committed rows onto the bus",
      body: "An `[outbox]` rule publishes every row change from the durable log. A crash never loses one, a restart never repeats one.",
      demo: {
        kind: "pair",
        items: [
          { kind: "snippet", line: "subject = \"db.{db}.{table}\"", label: "bql.toml", where: { doc: "db" } },
          { kind: "terminal", cmd: "bql bus subscribe cdc 'db.app-1.>'", where: { doc: "db" } },
        ],
      },
    },
    {
      id: "orms",
      chapter: "db",
      title: "ORMs reach it unmodified",
      body: "It speaks libsql's Hrana. `bql.sh/kysely` and `bql.sh/drizzle` map transactions onto its own routes.",
      demo: {
        kind: "variants",
        items: [
          { line: "const primary = createClient({ url: \"http://127.0.0.1:4501/v1/db/acme/\", authToken: KEY })", label: "libsql.ts", caption: "@libsql/client — Hrana over HTTP", where: { doc: "db" } },
          { line: "dialect: new BqlDialect({ url: \"http://localhost:4321\", token, db: \"acme\" }),", label: "kysely.ts", caption: "bql.sh/kysely — BqlDialect", where: { doc: "db" } },
          { line: "const db = drizzle({ url: \"http://localhost:4321\", token, db: \"acme\" }, { schema: { todos } })", label: "drizzle.ts", caption: "bql.sh/drizzle — drizzle()", where: { doc: "db" } },
        ],
      },
    },
    {
      id: "subjects",
      chapter: "bus",
      title: "Subjects, fanned out on pull",
      body: "`*` matches one token, `>` the rest. Publishing is O(1) in subscriptions, and `deliverFrom: \"beginning\"` reads last week.",
      demo: { kind: "snippet", line: "orders.*.created         matches orders.eu.created", label: "subjects", where: { doc: "bus" } },
    },
    {
      id: "exactly-once",
      chapter: "bus",
      title: "Three tiers of exactly-once",
      body: "At-least-once by default. `api.emit` commits with the ack; `api.effect` records an outside call beside it.",
      demo: {
        kind: "pair",
        items: [
          { kind: "table", header: "Tier", where: { doc: "bus" } },
          { kind: "snippet", line: "api.emit({ subject: \"thumbnails.ready\", body: { id: message.body.id } });", label: "handler.ts", where: { doc: "bus" } },
        ],
      },
    },
    {
      id: "schedules",
      chapter: "bus",
      title: "Cron, as ordinary messages",
      body: "`bql bus schedule add` fires on the leader, one deduplicated publish per slot, DST-correct in any IANA zone.",
      demo: {
        kind: "pair",
        items: [
          { kind: "terminal", cmd: "bql bus schedule add nightly '30 2 * * *' reports.nightly '{\"kind\":\"daily\"}' --tz America/New_York", where: { doc: "bus" } },
          { kind: "snippet", line: "await bus.putSchedule({ name: \"nightly\"", label: "schedule.ts", where: { doc: "bus" } },
        ],
      },
    },
    {
      id: "sinks",
      chapter: "bus",
      title: "Sinks to webhooks, S3, ClickHouse",
      body: "`bql bus sink` acks a batch only once the destination took it. Paired with the outbox, that is rows to a warehouse with no code.",
      demo: {
        kind: "pair",
        items: [
          { kind: "snippet", line: "bql bus sink clickhouse --subscription olap", label: "sinks.sh", where: { doc: "bus" } },
          { kind: "snippet", line: "writer: webhookSink({", label: "sink.ts", where: { doc: "bus" } },
        ],
      },
    },
    {
      id: "schemas",
      chapter: "bus",
      title: "Schemas with computed compatibility",
      body: "Register with `--compat backward`, bind in `warn`, then `enforce`. A breaking version is a 409 naming the pointer.",
      demo: { kind: "terminal", cmd: "bql bus schema register order ./order.json --compat backward", where: { doc: "bus" } },
    },
    {
      id: "proven",
      chapter: "bus",
      title: "Proven with real processes",
      body: "`bun run test:e2e` SIGKILLs a consumer mid-message. No mocks.",
      demo: { kind: "snippet", line: "ok   killed worker-a while it held the slow message", label: "bun run test:e2e", where: { doc: "bus" } },
    },
  ] satisfies Capability[],

  measured: {
    title: "Measured, including where it loses",
    body: "`bun run bench` on an M5 Pro, as ratios against `bun:sqlite`. Writes in a transaction still lose slightly.",
    figures: [
      { label: "point read vs bun:sqlite", from: { kind: "regex", doc: "db", re: /\| point read by primary key \| ([\d.]+ – [\d.]+x) \|/ } },
      { label: "insert in a transaction", from: { kind: "regex", doc: "db", re: /\| insert inside a transaction \| ([\d.]+ – [\d.]+x) \|/ } },
      { label: "p50 commit → replica", from: { kind: "regex", doc: "db", re: /\| commit → applied on the replica \| (\d+ µs) \|/ } },
    ] satisfies Figure[],
    tables: [
      { header: "bql vs `bun:sqlite`", where: { doc: "db" } as Where },
      { header: "leg", where: { doc: "db" } as Where },
    ],
  },

  boundaries: [
    {
      title: "What holds",
      items: [
        "A restore reproduces the target txid checksum for checksum, or fails loudly.",
        "`ack: \"replica\"` makes failover lossless; the old primary is fenced by epoch.",
        "The bus survives SIGKILL mid-flight in `bun run soak`, nothing lost.",
      ],
    },
    {
      title: "What is a judgement",
      items: [
        "Default `ack: \"fsync\"` costs ~2.7x on one write against `ack: \"local\"`.",
        "Bus replication is asynchronous: failover RPO is tens of messages.",
        "Ordering is off by default; it costs throughput.",
      ],
    },
    {
      title: "What is not here yet",
      items: [
        "CI gates on Linux only; macOS and Windows legs stopped 2026-09-26.",
        "The bus still runs on `bun:sqlite`, not `bql.sh/sqlite`.",
        "Kysely's `.stream()` is not implemented.",
      ],
    },
  ],

  start: {
    install: { cmd: "bun add bql.sh", where: { doc: "db", section: "Install" } as Where },
    engine: { cmd: "bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts", where: { doc: "db", section: "Install" } as Where },
  },

  buildToday: {
    title: "Run a bus in one line",
    cmd: "bunx bql bus serve",
    where: { doc: "bus", section: "Install" } as Where,
  },

  guides: [
    { title: "Exactly-once, in three tiers", body: "What each tier guarantees and where the last stops.", href: `${G}/packages/bus/docs/exactly-once.md`, line: "bun run soak --fault post-ack", where: { doc: "bus" } as Where, file: "soak.sh" },
    { title: "The cluster and its leases", body: "Two primaries are impossible by the guard margin.", href: `${G}/packages/db/docs/c2-promotion.md`, line: "leaseGuardMs = 500     # the margin that makes two primaries impossible", where: { doc: "db" } as Where, file: "bql.toml" },
    { title: "WAL shipping, byte by byte", body: "Committed pages out of the -wal, self-verifying.", href: `${G}/packages/db/docs/m3-wal.md`, line: "const recorder = TxnRecorder.open({ dbPath: \"primary/main.db\" })", where: { doc: "db" } as Where, file: "wal.ts" },
  ],

  credit:
    "bql.sh is built by [linesofcode](https://x.com/linesofcode), who also builds [dagr](https://github.com/TimMikeladze/dagr), a workflow engine on one SQLite journal that uses this bus for remote steps.",

  nav: [
    { label: "Database", href: "/#database" },
    { label: "Bus", href: "/#bus" },
    { label: "Measured", href: "/#measured" },
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
      { label: "Why one package", href: `${G}/docs/monorepo.md` },
      { label: "Outbox", href: `${G}/packages/db/docs/x6-outbox.md` },
      { label: "Promotion", href: `${G}/packages/db/docs/c2-promotion.md` },
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
