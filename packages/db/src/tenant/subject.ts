// `bql_sub()` (docs/plan-web.md, the author column): the `sub` of the token the connection is
// serving right now, or NULL for the admin and for the node's own work. `applyPolicy` sets it per
// request and clears it on release, so a shared table can default and check its author column
// against it:
//
//   author text not null default (bql_sub()) check (bql_sub() is null or author = bql_sub())
//
// Registered deterministic, which is true within a statement (the subject cannot change while one
// runs) and is what lets a CHECK call it, and innocuous, so the schema may use it with
// `trusted_schema` off. Never index on it: the value differs between requests.

import type { Database } from "../sqlite/index.ts"

const subjects = new WeakMap<Database, string | null>()

export function setSubject(db: Database, sub: string | null): void {
  subjects.set(db, sub)
}

export function installSubjectFunction(db: Database): void {
  db.function("bql_sub", () => subjects.get(db) ?? null, { deterministic: true, innocuous: true })
}
