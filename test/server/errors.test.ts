// The §6.6 status map, and the promise that nothing a client sees came from a stack trace.

import { describe, expect, test } from "bun:test"
import { SqliteError } from "../../src/sqlite/index.ts"
import { BunQLError, errorResponse, mapError } from "../../src/server/errors.ts"

/** Extended result codes as sqlite3.h numbers them. */
const RC = {
  SQLITE_ERROR: 1,
  SQLITE_BUSY: 5,
  SQLITE_BUSY_SNAPSHOT: 517,
  SQLITE_LOCKED: 6,
  SQLITE_READONLY: 8,
  SQLITE_INTERRUPT: 9,
  SQLITE_IOERR: 10,
  SQLITE_FULL: 13,
  SQLITE_CONSTRAINT: 19,
  SQLITE_CONSTRAINT_UNIQUE: 2067,
  SQLITE_CONSTRAINT_FOREIGNKEY: 787,
  SQLITE_MISUSE: 21,
  SQLITE_AUTH: 23,
  SQLITE_RANGE: 25,
} as const

describe("mapError on SQLite failures", () => {
  const cases: [keyof typeof RC, number, string][] = [
    ["SQLITE_ERROR", 400, "SQLITE_ERROR"],
    ["SQLITE_MISUSE", 400, "SQLITE_MISUSE"],
    ["SQLITE_RANGE", 400, "SQLITE_RANGE"],
    ["SQLITE_CONSTRAINT", 409, "SQLITE_CONSTRAINT"],
    ["SQLITE_CONSTRAINT_UNIQUE", 409, "SQLITE_CONSTRAINT_UNIQUE"],
    ["SQLITE_CONSTRAINT_FOREIGNKEY", 409, "SQLITE_CONSTRAINT_FOREIGNKEY"],
    ["SQLITE_INTERRUPT", 408, "QUERY_TIMEOUT"],
    ["SQLITE_AUTH", 403, "NOT_AUTHORIZED"],
    ["SQLITE_READONLY", 403, "NOT_AUTHORIZED"],
    ["SQLITE_FULL", 507, "QUOTA_EXCEEDED"],
    ["SQLITE_BUSY", 503, "BUSY"],
    ["SQLITE_BUSY_SNAPSHOT", 503, "BUSY"],
    ["SQLITE_LOCKED", 503, "BUSY"],
    ["SQLITE_IOERR", 500, "SQLITE_IOERR"],
  ]

  for (const [name, status, code] of cases) {
    test(`${name} → ${status} ${code}`, () => {
      const mapped = mapError(new SqliteError("boom", RC[name]))
      expect(mapped.status).toBe(status)
      expect(mapped.body.error.code).toBe(code)
      expect(mapped.body.error.status).toBe(status)
      expect(mapped.body.error.message).toBe("boom")
    })
  }
})

describe("mapError on BunQL failures", () => {
  const cases: [BunQLError, number, string][] = [
    [BunQLError.badRequest("bad sql"), 400, "BAD_REQUEST"],
    [BunQLError.unauthenticated(), 401, "UNAUTHENTICATED"],
    [BunQLError.notAuthorized(), 403, "NOT_AUTHORIZED"],
    [BunQLError.dbNotFound("acme"), 404, "DB_NOT_FOUND"],
    [BunQLError.queryTimeout(10), 408, "QUERY_TIMEOUT"],
    [BunQLError.resetRequired(), 409, "RESET_REQUIRED"],
    [BunQLError.txidNotAvailable(99, 12), 425, "TXID_NOT_AVAILABLE"],
    [BunQLError.notPrimary("wss://node-b/v1/ws"), 503, "NOT_PRIMARY"],
    [BunQLError.busy(), 503, "BUSY"],
    [BunQLError.quotaExceeded(), 507, "QUOTA_EXCEEDED"],
  ]

  for (const [err, status, code] of cases) {
    test(`${code} → ${status}`, () => {
      const mapped = mapError(err)
      expect(mapped.status).toBe(status)
      expect(mapped.body.error.code).toBe(code)
    })
  }

  test("the status follows from the code when the caller does not give one", () => {
    expect(new BunQLError("DB_NOT_FOUND", "gone").status).toBe(404)
    expect(new BunQLError("SOMETHING_NEW", "gone").status).toBe(500)
  })

  test("a replica that cannot reach minTxid reports where it is", () => {
    const body = mapError(BunQLError.txidNotAvailable(99, 12)).body
    expect(body.error.txid).toBe(12)
  })
})

describe("mapError context", () => {
  test("carries txid and the failing statement of a batch", () => {
    const body = mapError(new SqliteError("boom", RC.SQLITE_CONSTRAINT_UNIQUE), {
      txid: 4813,
      failedIndex: 1,
    }).body
    expect(body.error).toEqual({
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "boom",
      status: 409,
      txid: 4813,
      failedIndex: 1,
    })
  })

  test("leaves out fields nobody supplied", () => {
    const body = mapError(BunQLError.badRequest("nope")).body
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "status"])
  })
})

describe("mapError on anything else", () => {
  test("an unexpected throw becomes a bare 500 and keeps its message to itself", () => {
    const err = new Error("connect ECONNREFUSED /Users/tim/secret/socket")
    const mapped = mapError(err)
    expect(mapped.status).toBe(500)
    expect(mapped.body.error).toEqual({ code: "INTERNAL", message: "internal error", status: 500 })
  })

  test("no stack trace ever reaches the body", () => {
    const err = new Error("boom")
    expect(JSON.stringify(mapError(err).body)).not.toContain("at ")
    expect(JSON.stringify(mapError(BunQLError.badRequest("boom")).body)).not.toContain(
      "errors.test",
    )
  })

  test("a bad argument from the codec or the binder is the client's fault", () => {
    expect(mapError(new TypeError("cannot bind [object Object]")).status).toBe(400)
    expect(mapError(new RangeError('no parameter named "id"')).status).toBe(400)
    expect(mapError(new SyntaxError("Unexpected token")).status).toBe(400)
    expect(mapError(new RangeError("nope")).body.error.message).toBe("nope")
  })
})

describe("errorResponse", () => {
  test("is JSON with the mapped status", async () => {
    const response = errorResponse(BunQLError.dbNotFound("acme"))
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await response.json()).toEqual({
      error: { code: "DB_NOT_FOUND", message: "no such database: acme", status: 404 },
    })
  })

  test("points a redirected client at the primary", () => {
    const response = errorResponse(BunQLError.notPrimary("wss://node-b/v1/ws"))
    expect(response.status).toBe(503)
    expect(response.headers.get("BunQL-Primary")).toBe("wss://node-b/v1/ws")
  })

  test("reports the txid it was serving and keeps extra headers", () => {
    const response = errorResponse(BunQLError.badRequest("nope"), { txid: 41 }, {
      "BunQL-Node": "node-a",
    })
    expect(response.headers.get("BunQL-Txid")).toBe("41")
    expect(response.headers.get("BunQL-Node")).toBe("node-a")
  })
})
