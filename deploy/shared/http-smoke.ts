import { createClient, type ClientOptions } from "../../packages/db/src/client/index.ts"
import { BqlClientError } from "../../packages/db/src/client/errors.ts"

/** Receipt contains a revoked token: keep it private and never print it. */
export interface SmokeReceipt { database: string; key: string; value: string; revokedToken: string }
export async function seedSmoke(options: ClientOptions): Promise<SmokeReceipt> {
  const client = createClient(options)
  const database = `smoke_${crypto.randomUUID().replaceAll("-", "")}`
  const key = crypto.randomUUID(), value = crypto.randomUUID()
  try {
    await client.admin.create(database)
    await client.db(database).batch([{ sql: "create table items (id integer primary key, value text)" }, { sql: "insert into items values (1, ?)", args: [value] }], { idempotencyKey: key })
    await client.admin.configure(database, { foreignKeys: false })
    const token = await client.admin.mintToken({ db: database, scope: "ro" })
    await client.admin.revokeToken(token.jti)
    const receipt = { database, key, value, revokedToken: token.token }
    await verifySmoke(options, receipt)
    return receipt
  } finally { client.close() }
}
export async function verifySmoke(options: ClientOptions, receipt: SmokeReceipt) {
  const client = createClient(options)
  try {
    // Retrying the original batch after recovery must return its persisted result,
    // even though executing CREATE TABLE again would fail.
    await client.db(receipt.database).batch([{ sql: "create table items (id integer primary key, value text)" }, { sql: "insert into items values (1, ?)", args: [receipt.value] }], { idempotencyKey: receipt.key })
    const rows = await client.db(receipt.database).execute("select id, value from items")
    if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0]?.value !== receipt.value) throw new Error("Smoke data differs from acknowledged write")
    if ((await client.admin.stat(receipt.database)).foreignKeys !== false) throw new Error("Database settings did not survive")
    if (!(await client.admin.list()).some(db => db.name === receipt.database)) throw new Error("Database catalog entry missing")
    const revoked = createClient({ ...options, token: receipt.revokedToken })
    try {
      let refused = false
      try { await revoked.db(receipt.database).execute("select 1") }
      catch (error) { if (error instanceof BqlClientError && error.status === 401) refused = true; else throw error }
      if (!refused) throw new Error("Revoked token was accepted")
    } finally { revoked.close() }
    return { database: receipt.database, checks: ["sql", "saved-result", "catalog", "settings", "revocation"] }
  } finally { client.close() }
}
