// Finding the library, and failing usefully when it cannot be found. The messages here are what a
// person on a fresh machine actually reads, so they are asserted rather than left to drift.

import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  candidatePaths,
  capabilityDetail,
  loadFrom,
  MIN_VERSION,
  remedy,
  sqlite,
} from "../../src/sqlite/lib.ts"

/** A shared library that exists on this platform and is definitely not a libsqlite3. */
const NOT_SQLITE =
  process.platform === "darwin"
    ? "/usr/lib/libSystem.B.dylib"
    : process.platform === "win32"
      ? "C:\\Windows\\System32\\kernel32.dll"
      : "libc.so.6"

/**
 * The vendored artefact as `vendoredName()` names it, matched the way a path can be matched on
 * every platform: the separator is `\` on Windows and the file is `sqlite3.dll`, so neither the
 * directory separator nor the `libsqlite3.` prefix can be written into the needle.
 */
const VENDOR_DIR = ["vendor", "sqlite"].join(path.sep)
const isVendored = (candidate: string): boolean =>
  candidate.includes(VENDOR_DIR) && candidate.endsWith(EXTENSION)
const EXTENSION =
  process.platform === "darwin" ? ".dylib" : process.platform === "win32" ? ".dll" : ".so"

describe("the search path", () => {
  test("the vendored library is tried after BUNQL_SQLITE_LIB and before the system ones", () => {
    const before = process.env.BUNQL_SQLITE_LIB
    process.env.BUNQL_SQLITE_LIB = "/explicit/libsqlite3.so"
    try {
      const paths = candidatePaths()
      expect(paths[0]).toBe("/explicit/libsqlite3.so")
      const vendored = paths.findIndex(isVendored)
      expect(vendored).toBe(1)
      // Every system candidate comes after it — and on Windows there are none at all, which is
      // deliberate (`candidatePaths`: a bare "sqlite3.dll" is a request to search PATH).
      const system = paths.findIndex((p) => p.includes("/usr/lib") || p.includes("/opt/"))
      if (process.platform === "win32") expect(system).toBe(-1)
      else expect(system).toBeGreaterThan(vendored)
    } finally {
      if (before === undefined) delete process.env.BUNQL_SQLITE_LIB
      else process.env.BUNQL_SQLITE_LIB = before
    }
  })

  test("the vendored path is absolute and named for this platform", () => {
    const vendored = candidatePaths().find(isVendored)
    expect(vendored).toBeDefined()
    expect(path.isAbsolute(vendored as string)).toBe(true)
    expect(vendored).toEndWith(EXTENSION)
  })
})

describe("when no library loads", () => {
  test("a missing file says what to run and what to set", () => {
    let message = ""
    try {
      loadFrom(["/nonexistent/libsqlite3.so"])
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain("could not load a libsqlite3")
    expect(message).toContain("bun run sqlite:build")
    expect(message).toContain("BUNQL_SQLITE_LIB")
    expect(message).toContain("SQLITE_ENABLE_PREUPDATE_HOOK")
    // The candidate that failed, and why, so the reader can see where it looked.
    expect(message).toContain("/nonexistent/libsqlite3.so")
  })

  test("a library that is not SQLite is not reported as an old SQLite", () => {
    let message = ""
    try {
      loadFrom([NOT_SQLITE])
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain("it is not a libsqlite3")
    expect(message).not.toContain("too old")
    expect(message).toContain("bun run sqlite:build")
  })

  test("the library that did load clears the documented floor", () => {
    // MIN_VERSION is a claim about what `CORE` needs — sqlite3_changes64 arrived in 3.37.0. If
    // this ever fails, the floor in lib.ts is wrong rather than the library.
    const [major, minor, patch] = MIN_VERSION.split(".").map(Number) as [number, number, number]
    const floor = major * 1_000_000 + minor * 1_000 + patch
    expect(sqlite().versionNumber).toBeGreaterThanOrEqual(floor)
  })
})

describe("the remedy", () => {
  test("names the build script and the override, and what a library of your own must have", () => {
    const text = remedy()
    expect(text).toContain("bun run sqlite:build")
    expect(text).toContain("BUNQL_SQLITE_LIB")
    expect(text).toContain("SQLITE_ENABLE_PREUPDATE_HOOK")
    expect(text).toContain("SQLITE_ENABLE_SESSION")
  })

  test("a capability failure names the flag, the loaded file and the fix", () => {
    const lib = sqlite()
    const detail = capabilityDetail(lib, "SQLITE_ENABLE_SESSION")
    expect(detail).toContain("SQLITE_ENABLE_SESSION")
    expect(detail).toContain(lib.path)
    expect(detail).toContain(lib.version)
    expect(detail).toContain("bun run sqlite:build")
  })
})
