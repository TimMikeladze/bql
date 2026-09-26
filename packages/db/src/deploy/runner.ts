import { basename } from "node:path"

export interface NativeCommand {
  executable: string
  args: readonly string[]
  cwd: string
  /** Secrets go through stdin/environment, never command arguments or diagnostics. */
  input?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
}
export interface NativeResult { stdout: string; stderr: string; exitCode: number }
export type NativeRunner = (command: NativeCommand) => Promise<NativeResult>
export class NativeCommandError extends Error {
  constructor(message: string, readonly exitCode?: number) { super(message); this.name = "NativeCommandError" }
}

/** Raw output is available only to a successful command's parser; failures never echo it. */
export const runNative: NativeRunner = async command => {
  const name = basename(command.executable)
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn([command.executable, ...command.args], {
      cwd: command.cwd, env: { ...process.env, ...command.env },
      stdin: command.input === undefined ? "ignore" : new TextEncoder().encode(command.input),
      stdout: "pipe", stderr: "pipe",
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NativeCommandError(`${name} is not installed or its working directory is missing`)
    throw new NativeCommandError(`Could not start ${name}`)
  }
  let timedOut = false, tooLarge = false
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, command.timeoutMs ?? 15 * 60_000)
  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 8 * 1024 * 1024) { tooLarge = true; child.kill("SIGKILL"); break }
        chunks.push(value)
      }
      return Buffer.concat(chunks).toString("utf8")
    } finally { reader.releaseLock() }
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited])
    if (timedOut) throw new NativeCommandError(`${name} timed out; remote changes may have completed`)
    if (tooLarge) throw new NativeCommandError(`${name} exceeded the diagnostic output limit; remote changes may have completed`)
    if (exitCode !== 0) throw new NativeCommandError(`${name} failed (exit ${exitCode}); inspect provider status before retrying`, exitCode)
    return { stdout, stderr, exitCode }
  } finally { clearTimeout(timer) }
}
