import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { promptLine, choose } from "../../src/cli/prompt.ts"
function io() {
  const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(_raw: boolean) {
        return this
      },
    }),
    output = new PassThrough()
  let text = ""
  output.on("data", (d) => {
    text += d
  })
  return { input, output, text: () => text }
}
test("hidden input supports backspace without echoing secrets", async () => {
  const x = io()
  const result = promptLine("Token", true, x)
  x.input.write("secrex\u007ft\r")
  expect(await result).toBe("secret")
  expect(x.text()).not.toContain("secret")
})
test("EOF and cancellation reject instead of hanging", async () => {
  for (const cancel of [true, false]) {
    const x = io(),
      p = promptLine("Token", true, x)
    if (cancel) x.input.write("\u0003")
    else x.input.end()
    await expect(p).rejects.toThrow("cancelled")
  }
})
test("noninteractive input requires explicit values; selection checks range", async () => {
  const x = io()
  x.input.isTTY = false
  await expect(promptLine("Token", true, x)).rejects.toThrow("terminal")
  const y = io(),
    p = choose("Project", [{ id: "p", name: "app" }], y)
  y.input.write("1\r")
  expect(await p).toBe("p")
})
