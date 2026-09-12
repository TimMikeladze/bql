// The entry point: `bun run src/server/main.ts`, or `bun start`. Configuration comes from
// `bunql.toml` in the working directory when there is one, then from `BUNQL_*` (design §9.4).
//
// Invariant: this file starts a server and prints where it is. Everything else belongs in
// `app.ts`, so the embedded API and the tests take exactly the same path as the CLI does.

import { startServer } from "./app.ts"
import { loadConfig } from "./config.ts"

const CONFIG_FILE = process.env.BUNQL_CONFIG ?? "bunql.toml"

async function main(): Promise<void> {
  const config = loadConfig({ file: CONFIG_FILE, required: Boolean(process.env.BUNQL_CONFIG) })
  const handle = await startServer(config)

  console.log(`bunql ${handle.url}  node=${config.server.node}  data=${config.data.dir}`)
  console.log(
    `bunql: ${handle.registry.list().length} database(s), maxOpen ${config.data.maxOpen}, ` +
      `ack ${config.durability.defaultAck}`,
  )
  if (!process.env.BUNQL_ADMIN_KEY) {
    console.log(`bunql: the admin key is in ${config.auth.keysFile}; set BUNQL_ADMIN_KEY to override`)
  }

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    console.log(`bunql: ${signal}, shutting down`)
    void handle.close().then(() => process.exit(0))
  }
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("SIGTERM", () => stop("SIGTERM"))
}

await main()
