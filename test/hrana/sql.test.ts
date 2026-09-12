// The two pieces of SQL reading the compat layer does for itself: which statements move a
// connection's transaction state, and where one statement ends. Both are reachable through the
// wire, but the interesting cases are quoting and trigger bodies, which are cheaper to pin here.

import { describe, expect, test } from "bun:test"
import { isExplain, splitStatements, txVerb } from "../../src/server/hrana/sql.ts"

describe("txVerb", () => {
  test("the four transaction verbs, with their modes", () => {
    const begin = (mode: string, readonly = false) => ({ kind: "begin", mode, readonly })
    expect(txVerb("BEGIN")).toEqual(begin("deferred") as never)
    expect(txVerb("begin transaction")).toEqual(begin("deferred") as never)
    expect(txVerb("BEGIN IMMEDIATE")).toEqual(begin("immediate") as never)
    expect(txVerb("begin transaction immediate")).toEqual(begin("immediate") as never)
    expect(txVerb("BEGIN EXCLUSIVE")).toEqual(begin("exclusive") as never)
    // `@libsql/client`'s read mode, which SQLite itself does not understand: a deferred
    // transaction that refuses writes.
    expect(txVerb("BEGIN TRANSACTION READONLY")).toEqual(begin("deferred", true) as never)
    expect(txVerb("commit")).toEqual({ kind: "commit" })
    expect(txVerb("COMMIT TRANSACTION")).toEqual({ kind: "commit" })
    expect(txVerb("end")).toEqual({ kind: "commit" })
    expect(txVerb("ROLLBACK")).toEqual({ kind: "rollback" })
  })

  test("a savepoint rollback is not a transaction rollback", () => {
    expect(txVerb("rollback to s1")).toBeNull()
    expect(txVerb("ROLLBACK TRANSACTION TO SAVEPOINT s1")).toBeNull()
  })

  test("leading comments and whitespace do not hide the verb", () => {
    expect(txVerb("  -- start here\n  /* really */ begin immediate")).toEqual({
      kind: "begin",
      mode: "immediate",
      readonly: false,
    })
  })

  test("ordinary statements are not transaction control", () => {
    for (const sql of [
      "select 1",
      "insert into t values (1)",
      "savepoint s1",
      "release s1",
      "create table t (id integer)",
      "select 'begin'",
    ]) {
      expect(txVerb(sql)).toBeNull()
    }
  })

  test("isExplain", () => {
    expect(isExplain("explain select 1")).toBe(true)
    expect(isExplain("  EXPLAIN QUERY PLAN select 1")).toBe(true)
    expect(isExplain("select 1")).toBe(false)
  })
})

describe("splitStatements", () => {
  test("plain statements, with the trailing semicolon producing no empty tail", () => {
    expect(splitStatements("select 1; select 2;")).toEqual(["select 1", "select 2"])
    expect(splitStatements("select 1;\n\n  select 2")).toEqual(["select 1", "select 2"])
    expect(splitStatements("   ")).toEqual([])
  })

  test("a semicolon inside a string, an identifier or a comment does not split", () => {
    expect(splitStatements("select ';'; select 2")).toEqual(["select ';'", "select 2"])
    expect(splitStatements(`select "a;b" from t`)).toEqual([`select "a;b" from t`])
    expect(splitStatements("select [a;b] from t")).toEqual(["select [a;b] from t"])
    expect(splitStatements("select `a;b` from t")).toEqual(["select `a;b` from t"])
    expect(splitStatements("select 1; -- and; then\nselect 2")).toEqual(["select 1", "select 2"])
    expect(splitStatements("select 1; /* a; b */ select 2")).toEqual(["select 1", "select 2"])
  })

  test("a doubled quote inside a literal is not the end of it", () => {
    expect(splitStatements("select 'it''s; fine'; select 2")).toEqual([
      "select 'it''s; fine'",
      "select 2",
    ])
  })

  test("a trigger body's semicolons belong to the trigger", () => {
    const script =
      "create trigger t after insert on a begin insert into l values (1); insert into l values (2); end; select 1"
    expect(splitStatements(script)).toEqual([
      "create trigger t after insert on a begin insert into l values (1); insert into l values (2); end",
      "select 1",
    ])
  })

  test("a temp trigger, and a leading EXPLAIN, are still trigger bodies", () => {
    expect(
      splitStatements("create temp trigger t after insert on a begin select 1; end; select 2"),
    ).toEqual(["create temp trigger t after insert on a begin select 1; end", "select 2"])
    expect(
      splitStatements("explain create trigger t after insert on a begin select 1; end; select 2"),
    ).toEqual(["explain create trigger t after insert on a begin select 1; end", "select 2"])
  })

  test("a plain BEGIN outside a trigger still ends at its semicolon", () => {
    expect(splitStatements("begin; insert into t values (1); commit;")).toEqual([
      "begin",
      "insert into t values (1)",
      "commit",
    ])
  })

  test("an unterminated literal does not run past the end of the script", () => {
    expect(splitStatements("select 'oops")).toEqual(["select 'oops"])
  })

  test("leading comments are dropped, and a comment-only fragment is not a statement", () => {
    // `sqlite3_prepare` refuses SQL with no statement in it, so a migration script that ends in a
    // comment must not produce a fragment at all.
    expect(splitStatements("select 1; -- done")).toEqual(["select 1"])
    expect(splitStatements("/* header */\nselect 1;\n/* footer */")).toEqual(["select 1"])
    expect(splitStatements("-- only a comment")).toEqual([])
    expect(splitStatements("select 1; -- and; then\nselect 2")).toEqual(["select 1", "select 2"])
  })
})
