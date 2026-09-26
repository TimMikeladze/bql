// The page model: composition, copy, section order, which captured example each section shows,
// and the link table. No markup — the renderer owns that. Examples are *references* into the
// READMEs (see source.ts), never text written here.

import type { DocId, RepoCount, Where } from "./source.ts"

export type IconName =
  | "github" | "x" | "linkedin" | "discord"
  | "bun" | "sqlite" | "drizzle" | "turso" | "graphql" | "openapi" | "s3" | "cloudflare"
  | "minio" | "prometheus" | "opentelemetry" | "docker" | "fly"

export type Demo =
  | { kind: "terminal"; cmd: string; where: Where }
  | { kind: "snippet"; line: string; label: string; where: Where }
  | { kind: "table"; header: string; where: Where }
  | { kind: "variants"; items: { line: string; label: string; caption: string; where: Where }[] }

export interface Capability {
  id: string
  title: string
  /** Inline Markdown, 1–3 sentences, at least one `code`. */
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

export const site = {
  name: "bql.sh",
  origin: "https://bql.sh", // where it is deployed, and the package name
  repo: "https://github.com/TimMikeladze/bql",
  themeKey: "bql-theme",
  title: "bql.sh — SQLite as a database server, and a durable message bus",
  tagline: "SQLite as a multi-tenant server, and a bus",
  description:
    "bql.sh runs thousands of SQLite databases in one Bun process, with replicas, S3 backup and realtime, beside a durable message bus.",
  license: "MIT",
  year: 2026,

  h1: "SQLite as a database server, and a bus",
  lede:
    "One open source package. `bql.sh` serves thousands of SQLite databases from one process, and `bql.sh/bus` is a durable message bus with leases, retries and a dead-letter path. Built on [Bun](https://bun.sh) and [SQLite](https://sqlite.org) with zero runtime dependencies, by [linesofcode](https://x.com/linesofcode).",

  install: {
    humans: { cmd: "git clone https://github.com/TimMikeladze/bql && cd bql", where: { doc: "db", section: "Install" } as Where },
    agents: "curl https://bql.sh/llms.txt",
    note: "Not on npm yet",
  },

  split: {
    left: { cmd: "bql bus publish work.resize '{\"src\":\"a.png\"}'", where: { doc: "bus", section: "bql.sh/bus" } as Where, label: "terminal" },
    right: { line: "await new BusConsumer({", where: { doc: "bus" } as Where, label: "consumer.ts" },
  },

  figures: [
    { label: "test files across both halves", from: { kind: "count", count: "testFiles" } },
    { label: "runtime dependencies", from: { kind: "count", count: "runtimeDependencies" } },
    { label: "writes/s at 64 concurrent clients", from: { kind: "regex", doc: "db", re: /~(\d+k) writes\/s at 64/ } },
    { label: "point read over HTTP, one node", from: { kind: "regex", doc: "db", re: /a point read is\s+(\d+ µs)/, unit: "" } },
  ] satisfies Figure[],

  ecosystem: {
    title: "Reached by what you already run",
    lede:
      "Bun and SQLite underneath; Drizzle, Kysely and @libsql/client on top; REST, OpenAPI and GraphQL generated; backups to S3, R2 or MinIO; metrics for Prometheus and traces for OpenTelemetry; a Dockerfile and a fly.toml.",
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
      { icon: "prometheus", label: "Prometheus", href: "https://prometheus.io" },
      { icon: "opentelemetry", label: "OpenTelemetry", href: "https://opentelemetry.io" },
      { icon: "docker", label: "Docker", href: "https://www.docker.com" },
      { icon: "fly", label: "Fly.io", href: "https://fly.io" },
    ] as { icon: IconName; label: string; href: string }[],
  },

  principles: [
    { title: "Zero runtime dependencies", body: "Neither `package.json` has a `dependencies` field. The OTLP exporter and the JSON Schema validator are written, not installed." },
    { title: "The write path never waits", body: "A write checks a lease its own node holds, in memory. Raft and S3 shipping run beside the commit, never in front of it." },
    { title: "Refuse rather than guess", body: "Promotion answers `BEHIND` or `LEASE_HELD`. An unimplemented schema keyword fails registration. An integer past 2^53 is never rounded." },
  ],

  showcase: {
    title: "One engine, four ways in",
    body:
      "The same database answers a tagged template over HTTP, a synchronous call in your own process, and a raw `bun:ffi` driver. The bus runs its handler inside the SQLite transaction that acks it.",
    supports: ["bun", "drizzle", "turso", "graphql", "openapi"] as IconName[],
    tabs: [
      { label: "Client", file: "client.ts", line: "const client = createClient({ url: \"http://localhost:4321\", token })   // token, or the admin key", where: { doc: "db" } as Where },
      { label: "Embedded", file: "embedded.ts", line: "const bq = await Bql.open({ dir: \"./data\" })", where: { doc: "db" } as Where },
      { label: "Driver", file: "driver.ts", line: "const db = Database.open(\"app.db\")", where: { doc: "db" } as Where },
      { label: "Transactional ack", file: "bus.ts", line: "bus.consumeTransactional({", where: { doc: "bus" } as Where },
    ],
  },

  capabilities: [
    {
      id: "realtime",
      title: "Realtime from SQLite's own hooks",
      body: "Read `/changes` as SSE, or subscribe with `db.live` and `.key(\"id\")` for diffs. Every commit arrives as one `change` event, driven by the `preupdate`/`update` hooks rather than triggers.",
      demo: { kind: "terminal", cmd: "curl -N \"localhost:4321/v1/db/acme/changes?include=row&token=$TOKEN\"", where: { doc: "db" } },
    },
    {
      id: "txid",
      title: "Every write answers with a txid",
      body: "Each response names the transaction it landed in. The client's default `consistency: \"ryw\"` sends the highest one it has seen as `BQL-Min-Txid`, so a read never goes backwards.",
      demo: { kind: "terminal", cmd: "curl -sX POST localhost:4321/v1/db -H \"authorization: Bearer $KEY\" \\", where: { doc: "db" } },
    },
    {
      id: "replicas",
      title: "Replicas that forward writes",
      body: "Start a second node with `--replica-of` and a shared `--cluster-secret`. It serves reads locally and forwards writes to the primary, answering with the primary's txid already applied.",
      demo: { kind: "terminal", cmd: "curl -sD- -H \"authorization: Bearer $KEY\" -H 'content-type: application/json' \\", where: { doc: "db" } },
    },
    {
      id: "promotion",
      title: "Promotion that refuses to guess",
      body: "`bql promote` moves one database to a new primary and fences the old one by epoch. `--force` overrides exactly `STREAM_LIVE`, `LEASE_HELD` and `BEHIND`, and nothing else.",
      demo: { kind: "terminal", cmd: "bql promote acme --url http://127.0.0.1:4502", where: { doc: "db" } },
    },
    {
      id: "backup",
      title: "Backed up to any bucket",
      body: "Pass `--s3` and every database's log and snapshots ship continuously to S3, R2, Tigris or MinIO. A slow bucket makes the node report `behind`; it never slows a commit.",
      demo: { kind: "terminal", cmd: "bql backup status acme", where: { doc: "db", section: "Back it up to a bucket" } },
    },
    {
      id: "orms",
      title: "ORMs reach it unmodified",
      body: "It speaks libsql's Hrana, so `@libsql/client` connects as is. `bql.sh/kysely` and `bql.sh/drizzle` map transactions and batches onto bql.sh's own routes.",
      demo: {
        kind: "variants",
        items: [
          { line: "const primary = createClient({ url: \"http://127.0.0.1:4501/v1/db/acme/\", authToken: KEY })", label: "libsql.ts", caption: "@libsql/client, Hrana over HTTP", where: { doc: "db" } },
          { line: "dialect: new BqlDialect({ url: \"http://localhost:4321\", token, db: \"acme\" }),", label: "kysely.ts", caption: "bql.sh/kysely, BqlDialect", where: { doc: "db" } },
          { line: "const db = drizzle({ url: \"http://localhost:4321\", token, db: \"acme\" }, { schema: { todos } })", label: "drizzle.ts", caption: "bql.sh/drizzle, drizzle()", where: { doc: "db" } },
        ],
      },
    },
    {
      id: "subjects",
      title: "Subjects, fanned out on pull",
      body: "`*` matches one token and `>` the rest, the NATS convention. Fan-out happens when a consumer pulls, so publishing is O(1) in subscriptions and `deliverFrom: \"beginning\"` reads last week.",
      demo: { kind: "snippet", line: "orders.*.created         matches orders.eu.created", label: "subjects", where: { doc: "bus" } },
    },
    {
      id: "exactly-once",
      title: "Three tiers of exactly-once",
      body: "At-least-once by default. `ack(id, { publish: [...] })` commits the ack and its outputs together, and `api.effect` records an external call alongside the ack. The last tier's window is named, not hidden.",
      demo: { kind: "table", header: "Tier", where: { doc: "bus" } },
    },
    {
      id: "schemas",
      title: "Schemas with computed compatibility",
      body: "Register JSON Schema 2020-12 with `--compat backward`, bind it to a subject pattern in `warn` mode, then `enforce`. A version that breaks the declared mode is a 409 naming the pointer.",
      demo: { kind: "terminal", cmd: "bql bus schema register order ./order.json --compat backward", where: { doc: "bus" } },
    },
    {
      id: "proven",
      title: "Proven with real processes",
      body: "`bun run test:e2e` runs competing consumers, a SIGKILL mid-message, a poison message and a cross-process request. No mocks; `bun run soak --fault post-ack` crashes at chosen points.",
      demo: { kind: "snippet", line: "ok   killed worker-a while it held the slow message", label: "bun run test:e2e", where: { doc: "bus" } },
    },
  ] satisfies Capability[],

  measured: {
    title: "Measured, including where it loses",
    body: "`bun run bench` on an M5 Pro, as ratios against `bun:sqlite` because the ratio holds still. Writes inside a transaction are still slightly slower than `bun:sqlite`; the table says so.",
    figures: [
      { label: "point read vs bun:sqlite", from: { kind: "regex", doc: "db", re: /\| point read by primary key \| ([\d.]+ – [\d.]+x) \|/ } },
      { label: "insert in a transaction vs bun:sqlite", from: { kind: "regex", doc: "db", re: /\| insert inside a transaction \| ([\d.]+ – [\d.]+x) \|/ } },
      { label: "p50 commit → applied on a replica", from: { kind: "regex", doc: "db", re: /\| commit → applied on the replica \| (\d+ µs) \|/ } },
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
        "A restore replays through the replica's verifier: it reproduces the target txid checksum for checksum, or fails loudly.",
        "`ack: \"replica\"` makes a failover lossless; the old primary is fenced by epoch.",
        "The bus survives SIGTERM and SIGKILL mid-flight in `bun run soak`, with nothing lost.",
      ],
    },
    {
      title: "What is a judgement",
      items: [
        "The default `ack: \"fsync\"` costs about 2.7x on a single write against `ack: \"local\"`.",
        "Bus replication is asynchronous; its failover RPO is measured in tens of messages.",
        "Ordering is off by default, because it costs throughput most work does not need.",
      ],
    },
    {
      title: "What is not here yet",
      items: [
        "Not on npm yet; the release is blocked on one secret. Use a clone.",
        "The packages do not depend on each other yet; the transactional outbox is next.",
        "`bql.sh/bus` is not on the Windows CI gate, and Kysely's `.stream()` is not implemented.",
      ],
    },
  ],

  start: {
    install: { cmd: "git clone https://github.com/TimMikeladze/bql && cd bql", where: { doc: "db", section: "Install" } as Where },
    verify: { cmd: "bun run typecheck", where: { doc: "root" } as Where },
  },

  buildToday: {
    title: "Run the bus and three consumers now",
    cmd: "bun run bus dev",
    where: { doc: "root", section: "The bus" } as Where,
  },

  guides: [
    { title: "Exactly-once, in three tiers", body: "What each tier guarantees, what it costs, and where the last one stops.", href: "https://github.com/TimMikeladze/bql/blob/main/packages/bus/docs/exactly-once.md", line: "api.emit({ subject: \"thumbnails.ready\", body: { id: message.body.id } });", where: { doc: "bus" } as Where, file: "handler.ts" },
    { title: "The cluster and its leases", body: "Why two primaries are impossible by the guard margin, not by hope.", href: "https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/c2-promotion.md", line: "leaseGuardMs = 500     # the margin that makes two primaries impossible", where: { doc: "db" } as Where, file: "bql.toml" },
    { title: "WAL shipping, byte by byte", body: "Committed pages out of the -wal, as self-verifying records.", href: "https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/m3-wal.md", line: "const recorder = TxnRecorder.open({ dbPath: \"primary/main.db\" })", where: { doc: "db" } as Where, file: "wal.ts" },
  ],

  credit:
    "bql.sh is built by [linesofcode](https://x.com/linesofcode), who also builds [dagr](https://github.com/TimMikeladze/dagr), a workflow engine on one SQLite journal that uses this bus for remote steps.",

  nav: [
    { label: "Capabilities", href: "/#realtime" },
    { label: "Measured", href: "/#measured" },
    { label: "Reference", href: "/reference" },
    { label: "Changelog", href: "https://github.com/TimMikeladze/bql/commits/main" },
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
    { title: "bql.sh", links: [
      { label: "README", href: "https://github.com/TimMikeladze/bql/tree/main/packages/db" },
      { label: "API", href: "https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/api.md" },
      { label: "Design", href: "https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/design.md" },
      { label: "Benchmarks", href: "https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/benchmarks.md" },
    ] },
    { title: "bql.sh/bus", links: [
      { label: "README", href: "https://github.com/TimMikeladze/bql/tree/main/packages/bus" },
      { label: "Exactly-once", href: "https://github.com/TimMikeladze/bql/blob/main/packages/bus/docs/exactly-once.md" },
      { label: "Schemas", href: "https://github.com/TimMikeladze/bql/blob/main/packages/bus/docs/schemas.md" },
      { label: "Operations", href: "https://github.com/TimMikeladze/bql/blob/main/packages/bus/docs/operations.md" },
    ] },
    { title: "Learn", links: [
      { label: "Why one repository", href: "https://github.com/TimMikeladze/bql/blob/main/docs/monorepo.md" },
      { label: "Promotion", href: "https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/c2-promotion.md" },
      { label: "ORM mapping", href: "https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/r5-orm.md" },
      { label: "Performance", href: "https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/performance.md" },
    ] },
    { title: "Community", links: [
      { label: "GitHub", href: "repo" },
      { label: "Issues", href: "https://github.com/TimMikeladze/bql/issues" },
      { label: "X", href: "https://x.com/linesofcode" },
      { label: "Discord", href: "https://discord.com/users/linesofcode" },
    ] },
    { title: "Legal", links: [
      { label: "MIT License", href: "https://github.com/TimMikeladze/bql/blob/main/LICENSE" },
    ] },
  ] as { title: string; links: { label: string; href: string; released?: string }[] }[],
} as const

export type Site = typeof site
