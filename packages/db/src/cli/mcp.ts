// `bql mcp` (docs/plan-web.md): a Model Context Protocol server on stdio, so an agent asked to "add
// persistence to this page" can create the app, its tables and its actions, and get the snippet
// to paste, without a person running the CLI. It talks to a running bql.sh server with the admin
// key, exactly as the CLI does (`BQL_URL`, `BQL_ADMIN_KEY`, or a saved context).
//
// The transport is MCP's stdio one: one JSON-RPC message per line in, one per line out. Nothing
// but protocol may reach stdout, so the server never logs there.

import type { Client } from "../client/index.ts"
import type { AppConfig, AppInfo } from "../client/protocol.ts"
import { createTableSql, sharedTableSql } from "../web/table.ts"

const PROTOCOL_VERSION = "2025-06-18"

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>): Promise<string>
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${what} is required`)
  return value
}

/** The page code an agent pastes: SQL first, the way the README leads. */
export function snippet(app: AppInfo, url: string): string {
  return `<script type="module">
  import { connect } from "https://cdn.jsdelivr.net/npm/bql.sh/packages/db/dist/web.js"

  const db = await connect("${app.key}", { url: "${url}" })

  // The visitor's own database: create tables here with db.sql.
  await db.sql\`create table if not exists todos(id integer primary key, title text not null, done integer not null default 0) strict\`
  await db.sql\`insert into todos(title) values (\${"write it"})\`
  db.live\`select id, title, done from todos order by id\`.on("rows", (rows) => render(rows))

  // Or keep one object in sync: const app = await db.state({ todos: [] }); app.todos.push({ title: "x" })
  // Shared tables (db.shared.table("posts")), actions (db.action("name", input)) and HTML forms
  // (POST ${url}/v1/forms/${app.id}/<table>) are set up with the other tools.
</script>`
}

export function tools(client: Client, url: string): Tool[] {
  const admin = client.admin
  return [
    {
      name: "list_apps",
      description: "List the bql.sh apps on the server: id, public pk_ key, shared database and config.",
      inputSchema: { type: "object", properties: {} },
      async call() {
        return JSON.stringify(await admin.apps(), null, 2)
      },
    },
    {
      name: "create_app",
      description:
        "Create an app a static HTML/JS page connects to with no server of its own. Returns its public " +
        "pk_ key and the snippet to paste into the page. Each visitor gets a private database.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lowercase letters, digits and dashes, e.g. 'todo-app'." },
          origins: {
            type: "array",
            items: { type: "string" },
            description: "Page origins allowed to connect, e.g. 'https://acme.app'. Default: localhost on any port.",
          },
        },
        required: ["id"],
      },
      async call(args) {
        const config: AppConfig = Array.isArray(args.origins) ? { origins: args.origins as string[] } : {}
        const app = await admin.createApp(text(args.id, "id"), config)
        return `Created ${app.id}. Key ${app.key}, shared database ${app.sharedDb}.\n\n${snippet(app, url)}`
      },
    },
    {
      name: "create_shared_table",
      description:
        "Create a table in the app's shared database, which every visitor of the app can reach. mode 'a' " +
        "is append-only, 'r' read-only, 'rw' read-write; rows carry an author and only the author can change " +
        "or delete one. form: true instead makes a table plain HTML forms post into.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string" },
          table: { type: "string", description: "A plain identifier." },
          mode: { type: "string", enum: ["a", "r", "rw"] },
          form: { type: "boolean" },
        },
        required: ["app", "table"],
      },
      async call(args) {
        const id = text(args.app, "app")
        const table = text(args.table, "table")
        const form = args.form === true
        const mode = (args.mode as "a" | "r" | "rw" | undefined) ?? "a"
        if (form && mode !== "a") throw new Error("a form table is mode a")
        const current = await admin.app(id)
        const ddl = form ? [createTableSql(table)] : sharedTableSql(table)
        await client.db(current.sharedDb).batch(ddl.map((sql) => ({ sql })))
        await admin.updateApp(id, {
          ...current.config,
          tables: { ...current.config.tables, [table]: form ? { mode: "a", form: true } : { mode } },
        })
        return form
          ? `Created form table ${table}. Point a <form method="post"> at ${url}/v1/forms/${id}/${table}.`
          : `Created ${current.sharedDb}.${table} (mode ${mode}). In the page: db.shared.table("${table}").`
      },
    },
    {
      name: "update_app_config",
      description:
        "Merge keys into an app's config: origins, tables, actions (named SQL visitors run with the server's " +
        "rights, with checked input bound by name and :user as the caller), session. Top-level keys replace.",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string" }, config: { type: "object" } },
        required: ["app", "config"],
      },
      async call(args) {
        const id = text(args.app, "app")
        if (typeof args.config !== "object" || args.config === null) throw new Error("config must be an object")
        const current = await admin.app(id)
        const updated = await admin.updateApp(id, { ...current.config, ...(args.config as AppConfig) })
        return JSON.stringify(updated.config, null, 2)
      },
    },
    {
      name: "run_sql",
      description:
        "Run one SQL statement on a database with the admin key, e.g. create a table in app-<id>-shared " +
        "with columns of its own. Returns the rows.",
      inputSchema: {
        type: "object",
        properties: { db: { type: "string" }, sql: { type: "string" } },
        required: ["db", "sql"],
      },
      async call(args) {
        const rows = await client.db(text(args.db, "db")).execute(text(args.sql, "sql"))
        return JSON.stringify([...rows], null, 2)
      },
    },
    {
      name: "get_snippet",
      description: 'The <script type="module"> to paste into a page for an existing app.',
      inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
      async call(args) {
        return snippet(await admin.app(text(args.app, "app")), url)
      },
    },
  ]
}

interface Message {
  jsonrpc: "2.0"
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

/** Answers one message; null for a notification, which gets no answer. */
export async function handle(list: Tool[], message: Message, version: string): Promise<unknown | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id ?? null, result })
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id ?? null, error: { code, message: text } })
  if (message.id === undefined) return null
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "bql", version },
      })
    case "ping":
      return reply({})
    case "tools/list":
      return reply({ tools: list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case "tools/call": {
      const tool = list.find((one) => one.name === message.params?.name)
      if (!tool) return fail(-32602, `unknown tool ${String(message.params?.name)}`)
      try {
        const out = await tool.call((message.params?.arguments as Record<string, unknown>) ?? {})
        return reply({ content: [{ type: "text", text: out }] })
      } catch (err) {
        // A tool failure is a result the model reads, not a protocol error.
        const why = err instanceof Error ? `${(err as { code?: string }).code ?? "error"}: ${err.message}` : String(err)
        return reply({ content: [{ type: "text", text: why }], isError: true })
      }
    }
    default:
      return fail(-32601, `method not found: ${String(message.method)}`)
  }
}

/** Reads newline-delimited JSON-RPC from `input` until it ends, writing answers to `output`. */
export async function serveMcp(
  client: Client,
  url: string,
  version: string,
  input: ReadableStream<Uint8Array>,
  output: (line: string) => void,
): Promise<void> {
  const list = tools(client, url)
  const decoder = new TextDecoder()
  let buffered = ""
  for await (const chunk of input) {
    buffered += decoder.decode(chunk, { stream: true })
    let newline = buffered.indexOf("\n")
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf("\n")
      if (!line) continue
      let message: Message
      try {
        message = JSON.parse(line) as Message
      } catch {
        output(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }))
        continue
      }
      const answer = await handle(list, message, version)
      if (answer !== null) output(JSON.stringify(answer))
    }
  }
}
