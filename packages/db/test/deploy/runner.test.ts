import { expect, test } from "bun:test"
import { runNative, NativeCommandError } from "../../src/deploy/runner.ts"

test("native runner preserves argument boundaries and delivers secrets on stdin", async () => {
  const result = await runNative({
    executable: process.execPath,
    args: ["-e", 'console.log(JSON.stringify({arg:Bun.argv[1],input:await Bun.stdin.text()}))', "$(touch /never); spaced"],
    cwd: process.cwd(), input: "secret-value",
  })
  expect(JSON.parse(result.stdout)).toEqual({ arg: "$(touch /never); spaced", input: "secret-value" })
})

test("native failure diagnostics omit output and secret-bearing argument values", async () => {
  try {
    await runNative({ executable: process.execPath, args: ["-e", 'console.error("secret-value"); process.exit(7)'], cwd: process.cwd(), input: "secret-value" })
    throw new Error("expected failure")
  } catch (error) {
    expect(error).toBeInstanceOf(NativeCommandError)
    expect((error as NativeCommandError).exitCode).toBe(7)
    expect(String(error)).not.toContain("secret-value")
    expect(JSON.stringify(error)).not.toContain("secret-value")
  }
})

test("native runner reports a missing CLI and bounds a hung command", async () => {
  await expect(runNative({ executable: "bql-nonexistent-provider-cli", args: [], cwd: process.cwd() })).rejects.toThrow("not installed")
  await expect(runNative({ executable: process.execPath, args: ["-e", "await Bun.sleep(60000)"], cwd: process.cwd(), timeoutMs: 25 })).rejects.toThrow("timed out")
})
