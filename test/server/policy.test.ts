// The policy is only worth anything if SQLite itself enforces it, so every case here runs a real
// statement on a real connection and checks what the driver threw.

import { afterAll, describe, expect, test } from "bun:test"
import {
  Database,
  SQLITE_DENY,
  SQLITE_FUNCTION,
  SqliteError,
} from "../../src/sqlite/index.ts"
import {
  ADMIN,
  applyPolicy,
  buildAuthorizer,
  claimsFor,
  tokenPrincipal,
  type Principal,
} from "../../src/server/auth.ts"
import { BunQLError, mapError } from "../../src/server/errors.ts"
import { cleanupTempDirs, tempDb } from "../sqlite/tmp.ts"

afterAll(cleanupTempDirs)

function fresh(): Database {
  const db = Database.open(tempDb())
  db.exec(`
    create table todos(id integer primary key, title text, done integer default 0);
    create table users(id integer primary key, email text);
    create table secrets(id integer primary key, value text);
    insert into todos(title) values ('write it'), ('ship it');
    insert into users(email) values ('ann@example.com');
    insert into secrets(value) values ('hunter2');
  `)
  return db
}

const rw = tokenPrincipal(claimsFor({ rw: ["acme"] }))
const ro = tokenPrincipal(claimsFor({ ro: ["acme"] }))

/** Status a request would have got for whatever this threw. */
function statusOf(fn: () => unknown): number {
  try {
    fn()
  } catch (err) {
    return mapError(err).status
  }
  throw new Error("expected the statement to fail")
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof SqliteError ? err.code : (err as BunQLError).code
  }
  throw new Error("expected the statement to fail")
}

describe("scope", () => {
  test("a token with no claim on the database is refused before any SQL runs", () => {
    const db = fresh()
    const elsewhere = tokenPrincipal(claimsFor({ rw: ["other"] }))
    expect(() => applyPolicy(db, elsewhere, "acme")).toThrow(BunQLError)
    expect(statusOf(() => applyPolicy(db, elsewhere, "acme"))).toBe(403)
    db.close()
  })

  test("a read-write token reads and writes", () => {
    const db = fresh()
    const policy = applyPolicy(db, rw, "acme")
    expect(policy.scope).toBe("rw")
    expect(db.prepare("select count(*) from todos").values()).toEqual([[2]])
    db.run("insert into todos(title) values ('third')")
    expect(db.prepare("select count(*) from todos").values()).toEqual([[3]])
    policy.release()
    db.close()
  })

  test("a read-only token reads but cannot write, in any shape", () => {
    const db = fresh()
    const policy = applyPolicy(db, ro, "acme")
    expect(policy.scope).toBe("ro")
    expect(db.prepare("select title from todos where id = 1").values()).toEqual([["write it"]])
    for (const sql of [
      "insert into todos(title) values ('nope')",
      "update todos set done = 1",
      "delete from todos",
      "create table sneaky(id integer)",
      "drop table todos",
      "alter table todos add column note text",
      "create index idx on todos(title)",
    ]) {
      expect(statusOf(() => db.run(sql))).toBe(403)
    }
    policy.release()
    db.close()
  })

  test("a read-only token cannot lift its own query_only flag", () => {
    const db = fresh()
    applyPolicy(db, ro, "acme")
    expect(codeOf(() => db.run("pragma query_only = 0"))).toBe("SQLITE_AUTH")
    expect(statusOf(() => db.run("insert into todos(title) values ('nope')"))).toBe(403)
    db.close()
  })

  test("query_only is still the second line of defence when the authorizer allows a write", () => {
    const db = fresh()
    applyPolicy(db, ro, "acme")
    // Reach past the authorizer by installing one that allows everything, as a route bug would.
    db.authorizer(() => 0)
    expect(codeOf(() => db.run("insert into todos(title) values ('nope')"))).toBe("SQLITE_READONLY")
    db.close()
  })

  test("releasing hands the connection back unrestricted", () => {
    const db = fresh()
    const policy = applyPolicy(db, ro, "acme")
    expect(statusOf(() => db.run("insert into todos(title) values ('nope')"))).toBe(403)
    policy.release()
    db.run("insert into todos(title) values ('now fine')")
    expect(db.prepare("select count(*) from todos").values()).toEqual([[3]])
    db.close()
  })

  test("re-scoping a pooled connection re-authorizes its cached statements", () => {
    const db = fresh()
    applyPolicy(db, rw, "acme")
    const stmt = db.prepare("select value from secrets")
    expect(stmt.values()).toEqual([["hunter2"]])
    applyPolicy(db, tokenPrincipal(claimsFor({ rw: ["acme"], tables: { todos: "rw" } })), "acme")
    expect(codeOf(() => stmt.values())).toBe("SQLITE_AUTH")
    db.close()
  })
})

describe("cross-database access", () => {
  test("ATTACH and DETACH are denied for every token", () => {
    const db = fresh()
    for (const principal of [rw, ro]) {
      applyPolicy(db, principal, "acme")
      expect(codeOf(() => db.exec("attach database ':memory:' as m"))).toBe("SQLITE_AUTH")
      expect(codeOf(() => db.exec("detach database m"))).toBe("SQLITE_AUTH")
    }
    db.close()
  })

  test("load_extension is denied but ordinary functions are not", () => {
    const db = fresh()
    applyPolicy(db, rw, "acme")
    expect(db.prepare("select upper(title) from todos where id = 1").values()).toEqual([
      ["WRITE IT"],
    ])
    expect(db.prepare("select count(*), max(id) from todos").values()).toEqual([[2, 2]])
    // This SQLite is built without load_extension, so the authorizer rule is checked directly;
    // through SQL the function does not resolve in the first place.
    expect(() => db.run("select load_extension('evil.so')")).toThrow(SqliteError)
    const authorizer = buildAuthorizer({ scope: "rw" })
    expect(authorizer(SQLITE_FUNCTION, null, "load_extension", null, null)).toBe(SQLITE_DENY)
    expect(authorizer(SQLITE_FUNCTION, null, "LOAD_EXTENSION", null, null)).toBe(SQLITE_DENY)
    expect(authorizer(SQLITE_FUNCTION, null, "upper", null, null)).toBe(0)
    db.close()
  })
})

describe("pragmas", () => {
  test("the allow-list lets a client describe the schema", () => {
    const db = fresh()
    applyPolicy(db, ro, "acme")
    expect(db.prepare("pragma table_info(todos)").all()).toHaveLength(3)
    expect(db.prepare("pragma table_list").all().length).toBeGreaterThan(0)
    expect(db.prepare("pragma index_list(todos)").all()).toBeDefined()
    expect(db.prepare("pragma foreign_key_list(todos)").all()).toEqual([])
    expect(db.prepare("pragma user_version").values()).toEqual([[0]])
    expect(db.prepare("pragma journal_mode").values()).toEqual([["wal"]])
    expect(db.prepare("pragma page_size").values()).toEqual([[4096]])
    expect(db.prepare("pragma freelist_count").values()).toEqual([[0]])
    expect(db.prepare("pragma data_version").all()).toHaveLength(1)
    expect(db.prepare("pragma page_count").all()).toHaveLength(1)
    expect(db.prepare("pragma compile_options").all().length).toBeGreaterThan(0)
    db.close()
  })

  test("everything off the allow-list is denied, in both scopes", () => {
    const db = fresh()
    for (const principal of [rw, ro]) {
      applyPolicy(db, principal, "acme")
      for (const sql of [
        "pragma journal_mode = delete",
        "pragma query_only = 0",
        "pragma writable_schema = 1",
        "pragma temp_store_directory = '/tmp'",
        "pragma max_page_count = 100000",
        "pragma synchronous = off",
        "pragma user_version = 9",
        "pragma cache_size = 1000000",
        "pragma integrity_check",
      ]) {
        expect(codeOf(() => db.run(sql))).toBe("SQLITE_AUTH")
      }
    }
    expect(db.prepare("pragma journal_mode").values()).toEqual([["wal"]])
    db.close()
  })
})

describe("table ACL", () => {
  const scoped: Principal = tokenPrincipal(
    claimsFor({ rw: ["acme"], tables: { todos: "rw", users: "r" } }),
  )

  test("reads are allowed on listed tables and denied on the rest", () => {
    const db = fresh()
    applyPolicy(db, scoped, "acme")
    expect(db.prepare("select title from todos").values()).toEqual([["write it"], ["ship it"]])
    expect(db.prepare("select email from users").values()).toEqual([["ann@example.com"]])
    expect(codeOf(() => db.prepare("select value from secrets"))).toBe("SQLITE_AUTH")
    expect(codeOf(() => db.prepare("select * from todos join secrets on 1"))).toBe("SQLITE_AUTH")
    db.close()
  })

  test("every column of a listed table is readable", () => {
    const db = fresh()
    applyPolicy(db, scoped, "acme")
    expect(db.prepare("select id, title, done from todos").all()).toHaveLength(2)
    expect(db.prepare("select * from todos").all()).toHaveLength(2)
    db.close()
  })

  test("writes need rw on that table", () => {
    const db = fresh()
    applyPolicy(db, scoped, "acme")
    db.run("insert into todos(title) values ('third')")
    db.run("update todos set done = 1 where id = 1")
    db.run("delete from todos where id = 2")
    expect(db.prepare("select count(*) from todos").values()).toEqual([[2]])
    expect(statusOf(() => db.run("insert into users(email) values ('bob@example.com')"))).toBe(403)
    expect(statusOf(() => db.run("update users set email = 'x'"))).toBe(403)
    expect(statusOf(() => db.run("delete from secrets"))).toBe(403)
    db.close()
  })

  test("the schema stays readable, so clients can still introspect", () => {
    const db = fresh()
    applyPolicy(db, scoped, "acme")
    expect(db.prepare("select name from sqlite_master where type = 'table'").all().length).toBe(3)
    expect(db.prepare("pragma table_info(todos)").all()).toHaveLength(3)
    db.close()
  })

  test("AUTOINCREMENT keeps working, which means sqlite_sequence is reachable", () => {
    const db = Database.open(tempDb())
    db.exec("create table notes(id integer primary key autoincrement, body text)")
    applyPolicy(db, tokenPrincipal(claimsFor({ rw: ["acme"], tables: { notes: "rw" } })), "acme")
    db.run("insert into notes(body) values ('one')")
    db.run("insert into notes(body) values ('two')")
    expect(db.prepare("select id from notes order by id").values()).toEqual([[1], [2]])
    db.close()
  })

  test("a table-scoped token may not change the schema at all", () => {
    const db = fresh()
    applyPolicy(db, scoped, "acme")
    for (const sql of [
      "create table more(id integer)",
      "drop table todos",
      "alter table todos add column note text",
      "create index idx on todos(title)",
      "create temp table scratch(id integer)",
    ]) {
      expect(statusOf(() => db.run(sql))).toBe(403)
    }
    db.close()
  })

  test("table names are matched the way SQLite matches identifiers", () => {
    const db = fresh()
    applyPolicy(db, tokenPrincipal(claimsFor({ rw: ["acme"], tables: { TODOS: "rw" } })), "acme")
    expect(db.prepare("select title from ToDoS").all()).toHaveLength(2)
    db.close()
  })
})

describe("admin", () => {
  test("runs with no authorizer at all", () => {
    const db = fresh()
    const policy = applyPolicy(db, ADMIN, "acme")
    expect(policy.scope).toBe("rw")
    db.exec("attach database ':memory:' as m")
    db.exec("detach database m")
    db.run("pragma user_version = 9")
    expect(db.prepare("pragma user_version").values()).toEqual([[9]])
    db.run("create table anything(id integer)")
    expect(db.prepare("select value from secrets").values()).toEqual([["hunter2"]])
    policy.release()
    db.close()
  })

  test("takes a connection back from a read-only token", () => {
    const db = fresh()
    applyPolicy(db, ro, "acme")
    expect(statusOf(() => db.run("insert into todos(title) values ('nope')"))).toBe(403)
    applyPolicy(db, ADMIN, "acme")
    db.run("insert into todos(title) values ('fine')")
    expect(db.prepare("select count(*) from todos").values()).toEqual([[3]])
    db.close()
  })
})

describe("reportEveryDelete", () => {
  test("makes a whole-table delete report each row without changing the outcome", () => {
    const db = fresh()
    applyPolicy(db, rw, "acme", { reportEveryDelete: true })
    const deleted: bigint[] = []
    db.onUpdate((op, _dbName, table, rowid) => {
      if (op === 9 && table === "todos") deleted.push(rowid)
    })
    db.run("delete from todos")
    expect(deleted).toEqual([1n, 2n])
    expect(db.prepare("select count(*) from todos").values()).toEqual([[0]])
    db.onUpdate(null)
    db.close()
  })

  test("is off by default, and the truncate optimisation then hides the rows", () => {
    const db = fresh()
    applyPolicy(db, rw, "acme")
    let seen = 0
    db.onUpdate(() => seen++)
    db.run("delete from todos")
    expect(seen).toBe(0)
    expect(db.prepare("select count(*) from todos").values()).toEqual([[0]])
    db.onUpdate(null)
    db.close()
  })
})
