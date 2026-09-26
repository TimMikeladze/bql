import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContextStore } from "../../src/context/store.ts"
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  )
})
async function store() {
  const d = await mkdtemp(join(tmpdir(), "bql-context-"))
  dirs.push(d)
  return new ContextStore(join(d, "config"))
}
test("persists validated records and owner-only secrets", async () => {
  const s = await store()
  await s.mutate((r, c) => {
    r.organizations.push({ id: "org1", name: "personal", projects: [] })
    c.secret1 = "private-token"
  })
  expect((await s.read()).organizations[0]?.name).toBe("personal")
  expect((await s.readCredentials()).secret1).toBe("private-token")
  expect((await stat(s.directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(s.directory, "credentials.json"))).mode & 0o777).toBe(
    0o600,
  )
  expect(
    await readFile(join(s.directory, "config.json"), "utf8"),
  ).not.toContain("private-token")
})
test("serializes concurrent updates without lost records", async () => {
  const s = await store()
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      s.mutate((r) => {
        r.organizations.push({ id: `id${i}`, name: `org${i}`, projects: [] })
      }),
    ),
  )
  expect((await s.read()).organizations.length).toBe(8)
})
test("invalid mutation and malformed versions preserve original bytes", async () => {
  const s = await store()
  await s.mutate((r) => {
    r.organizations.push({ id: "a", name: "one", projects: [] })
  })
  const path = join(s.directory, "config.json"),
    before = await readFile(path, "utf8")
  await expect(
    s.mutate((r) => {
      r.organizations.push({ id: "b", name: "one", projects: [] })
    }),
  ).rejects.toThrow("duplicate")
  expect(await readFile(path, "utf8")).toBe(before)
  await writeFile(path, '{"version":99}')
  await expect(s.read()).rejects.toThrow("version")
  await expect(s.mutate(() => {})).rejects.toThrow("version")
  expect(await readFile(path, "utf8")).toBe('{"version":99}')
})
test("stale locks time out without being stolen", async () => {
  const s = await store()
  await mkdir(join(s.directory, ".lock"), { recursive: true })
  await expect(
    new ContextStore(s.directory, { lockTimeoutMs: 50 }).mutate(() => {}),
  ).rejects.toThrow("locked")
  expect((await stat(join(s.directory, ".lock"))).isDirectory()).toBe(true)
})

test("failed registry publication keeps old credentials valid and leaves no partial JSON", async () => {
  const { renameSync, mkdirSync } = await import("node:fs")
  const s = await store(),
    config = join(s.directory, "config.json"),
    backup = join(s.directory, "before.json")
  await s.mutate((r, c) => {
    r.organizations = [
      {
        id: "o",
        name: "org",
        projects: [
          {
            id: "p",
            name: "app",
            endpoints: [
              {
                id: "e",
                name: "dev",
                database: { url: "https://old.example", token: { key: "old" } },
              },
            ],
          },
        ],
      },
    ]
    c.old = "old-token"
  })
  await expect(
    s.mutate((r, c) => {
      r.organizations[0]!.projects[0]!.endpoints[0]!.database = {
        url: "https://new.example",
        token: { key: "new" },
      }
      c.new = "new-token"
      delete c.old
      renameSync(config, backup)
      mkdirSync(config)
    }),
  ).rejects.toThrow()
  await rm(config, { recursive: true })
  renameSync(backup, config)
  expect(
    (await s.read()).organizations[0]!.projects[0]!.endpoints[0]!.database.url,
  ).toBe("https://old.example")
  expect((await s.readCredentials()).old).toBe("old-token")
  expect((await s.readCredentials()).new).toBe("new-token")
  await s.mutate((r, c) => {
    r.organizations[0]!.projects[0]!.endpoints[0]!.database = {
      url: "https://new.example",
      token: { key: "new" },
    }
    delete c.old
  })
  expect(
    (await s.read()).organizations[0]!.projects[0]!.endpoints[0]!.database
      .token,
  ).toEqual({ key: "new" })
  expect((await s.readCredentials()).old).toBeUndefined()
})

test("rejects duplicate IDs, unsafe URLs, and invalid secret data without exposing values", async () => {
  const s = await store()
  await expect(
    s.mutate((r) => {
      r.organizations = [
        { id: "same", name: "one", projects: [] },
        { id: "same", name: "two", projects: [] },
      ]
    }),
  ).rejects.toThrow("duplicate")
  for (const url of [
    "ftp://example.com",
    "https://user:private-password@example.com",
    "https://example.com?secret=value",
    "https://example.com#token",
  ]) {
    await expect(
      s.mutate((r) => {
        r.organizations = [
          {
            id: "o",
            name: "one",
            projects: [
              {
                id: "p",
                name: "app",
                endpoints: [{ id: "e", name: "dev", database: { url } }],
              },
            ],
          },
        ]
      }),
    ).rejects.toThrow("Endpoint URL")
  }
  await expect(
    s.mutate((_r, c) => {
      c.bad = "sensitive\nvalue"
    }),
  ).rejects.toThrow("Invalid credential store")
})

test("JSON null is corrupt configuration, never an empty registry to overwrite", async () => {
  const s = await store()
  await mkdir(s.directory, { recursive: true })
  const path = join(s.directory, "config.json")
  await writeFile(path, "null")
  await expect(s.read()).rejects.toThrow("Invalid configuration")
  await expect(s.mutate(() => {})).rejects.toThrow("Invalid configuration")
  expect(await readFile(path, "utf8")).toBe("null")
  await writeFile(
    path,
    JSON.stringify({ version: 1, organizations: [], selection: {} }),
  )
  await writeFile(join(s.directory, "credentials.json"), "null")
  await expect(s.readCredentials()).rejects.toThrow("Invalid configuration")
})
