import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  emptyRegistry,
  validateCredentials,
  validateRegistry,
  type Credentials,
  type Environment,
  type Registry,
} from "./model.ts"
export function configDirectory(
  options: { configDir?: string; env?: Environment } = {},
): string {
  const env = options.env ?? process.env
  return resolve(
    options.configDir ||
      env.BQL_CONFIG_DIR ||
      join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "bql"),
  )
}
export async function readJson(path: string): Promise<unknown | undefined> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error(`Cannot read BQL configuration at ${path}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in BQL configuration at ${path}`)
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    const file = await open(tmp, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + "\n")
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}
/** Atomic registry publication; immutable credential keys allow lock-free readers. */
export class ContextStore {
  constructor(
    readonly directory = configDirectory(),
    private options: { lockTimeoutMs?: number } = {},
  ) {}
  async read(): Promise<Registry> {
    const raw = await readJson(join(this.directory, "config.json"))
    const value = raw === undefined ? emptyRegistry() : raw
    validateRegistry(value)
    return value
  }
  async readCredentials(): Promise<Credentials> {
    const raw = await readJson(join(this.directory, "credentials.json"))
    const value = raw === undefined ? {} : raw
    validateCredentials(value)
    return value
  }
  async mutate(
    change: (state: Registry, secrets: Credentials) => void,
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const lock = join(this.directory, ".lock"),
      deadline = Date.now() + (this.options.lockTimeoutMs ?? 3000)
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 })
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
        if (Date.now() >= deadline)
          throw new Error(
            `BQL configuration is locked at ${lock}; check for a running command before removing a stale lock`,
          )
        await Bun.sleep(10)
      }
    }
    try {
      const registry = await this.read(),
        original = await this.readCredentials(),
        secrets = { ...original }
      change(registry, secrets)
      validateRegistry(registry)
      validateCredentials(secrets)
      for (const [key, value] of Object.entries(original))
        if (key in secrets && secrets[key] !== value)
          throw new Error("Credential keys are immutable; use a new reference")
      // Staging retains old keys until the registry no longer points to them.
      await atomicJson(join(this.directory, "credentials.json"), {
        ...original,
        ...secrets,
      })
      await chmod(join(this.directory, "credentials.json"), 0o600)
      await atomicJson(join(this.directory, "config.json"), registry)
      await atomicJson(join(this.directory, "credentials.json"), secrets)
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }
}
