import type { Readable, Writable } from "node:stream"
interface TerminalInput extends Readable {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?(raw: boolean): unknown
}
export interface PromptIO {
  input: TerminalInput
  output: Writable
}
const terminal = (): PromptIO => ({
  input: process.stdin,
  output: process.stderr,
})
/** Raw terminal input is never echoed when collecting a secret. Always restore terminal mode. */
export async function promptLine(
  label: string,
  hidden = false,
  io: PromptIO = terminal(),
): Promise<string> {
  if (!io.input.isTTY || !io.input.setRawMode)
    throw new Error(
      "This operation needs a terminal; supply explicit flags or credential environment references",
    )
  if (io.input.readableEnded || io.input.destroyed)
    throw new Error("Input cancelled")
  return new Promise((resolve, reject) => {
    const wasRaw = io.input.isRaw ?? false
    let value = ""
    const finish = (error?: Error) => {
      io.input.removeListener("data", data)
      io.input.removeListener("end", end)
      io.input.removeListener("error", end)
      io.input.setRawMode?.(wasRaw)
      io.input.pause()
      io.output.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const end = () => finish(new Error("Input cancelled"))
    const data = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003" || char === "\u0004") {
          end()
          return
        }
        if (char === "\r" || char === "\n") {
          finish()
          return
        }
        if (char === "\u007f" || char === "\b") {
          if (value) {
            value = [...value].slice(0, -1).join("")
            if (!hidden) io.output.write("\b \b")
          }
          continue
        }
        if (char >= " " && char !== "\u001b") {
          value += char
          if (!hidden) io.output.write(char)
        }
      }
    }
    io.output.write(`${label}: `)
    io.input.setRawMode!(true)
    io.input.on("data", data)
    io.input.once("end", end)
    io.input.once("error", end)
    io.input.resume()
  })
}
export async function choose(
  label: string,
  rows: { id: string; name: string }[],
  io: PromptIO = terminal(),
): Promise<string> {
  if (!rows.length)
    throw new Error(`No ${label.toLowerCase()} available; add one first`)
  io.output.write(rows.map((r, i) => `${i + 1}. ${r.name}`).join("\n") + "\n")
  const value = await promptLine(label, false, io),
    index = Number(value) - 1
  if (!/^\d+$/.test(value) || !Number.isInteger(index) || !rows[index])
    throw new Error("Invalid selection")
  return rows[index]!.id
}
