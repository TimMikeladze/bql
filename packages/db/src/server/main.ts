// The entry point: `bun run src/server/main.ts`, or `bun start`. Configuration comes from
// `bql.toml` in the working directory when there is one, then from `BQL_*` (design §9.4).
//
// Invariant: this file starts a server and prints where it is. Everything else belongs in
// `app.ts`, so the embedded API and the tests take exactly the same path as the CLI does.

import { walChecksumIsNative } from "../wal/native.ts"
import { startServer } from "./app.ts"
import { loadConfig } from "./config.ts"

const CONFIG_FILE = process.env.BQL_CONFIG ?? "bql.toml"

async function main(): Promise<void> {
  const config = loadConfig({ file: CONFIG_FILE, required: Boolean(process.env.BQL_CONFIG) })
  const handle = await startServer(config)

  console.log(
    `bql ${handle.url}  node=${config.server.node}  data=${config.data.dir}` +
      (config.server.workers === 1 ? "" : `  workers=${handle.workers}`),
  )
  console.log(
    `bql: ${handle.registry.list().length} database(s), maxOpen ${config.data.maxOpen}, ` +
      `ack ${config.durability.defaultAck}`,
  )
  if (!walChecksumIsNative()) {
    console.log(
      "bql: this libsqlite3 carries no bql_wal_* helper, so WAL frames are checksummed in " +
        "JavaScript — about 4.5 µs a frame, 16% of a write. `bun run sqlite:build` " +
        "fixes it. docs/p3-wal-checksum.md",
    )
  }
  if (!process.env.BQL_ADMIN_KEY && !process.env.BQL_AUTH_ADMIN_KEY) {
    console.log(
      `bql: the admin key is in ${config.auth.keysFile}; set BQL_AUTH_ADMIN_KEY to override`,
    )
  }

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    console.log(`bql: ${signal}, shutting down`)
    void handle.close().then(() => process.exit(0))
  }
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("SIGTERM", () => stop("SIGTERM"))
}

await main()
