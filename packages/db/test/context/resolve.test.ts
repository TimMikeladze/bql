import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ContextStore } from "../../src/context/store.ts"
import { resolveContext, redactContext } from "../../src/context/index.ts"
import { writeLink, findLink, unlinkProject } from "../../src/context/link.ts"
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  )
})
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "bql-resolve-"))
  dirs.push(cwd)
  const configDir = join(cwd, "config"),
    store = new ContextStore(configDir)
  await store.mutate((r, c) => {
    r.organizations = [
      {
        id: "o",
        name: "personal",
        projects: [
          {
            id: "p",
            name: "app",
            defaultEndpoint: "dev",
            endpoints: [
              {
                id: "dev",
                name: "development",
                database: {
                  url: "https://dev.example",
                  token: { key: "devkey" },
                },
                bus: { url: "https://bus.example", token: { env: "BUS_KEY" } },
              },
              {
                id: "prod",
                name: "production",
                database: {
                  url: "https://prod.example",
                  token: { env: "PROD_KEY" },
                  bypass: { env: "BYPASS" },
                },
              },
            ],
          },
        ],
      },
      {
        id: "o2",
        name: "other",
        projects: [{ id: "p2", name: "app", endpoints: [] }],
      },
    ]
    r.selection = { org: "o", project: "p" }
    c.devkey = "dev-secret"
  })
  return {
    cwd,
    configDir,
    store,
    env: {
      PROD_KEY: "prod-secret",
      BYPASS: "bypass-secret",
      BUS_KEY: "bus-secret",
    },
  }
}
test("selection precedence and isolation from legacy credentials", async () => {
  const f = await fixture()
  await writeLink(f.cwd, {
    version: 1,
    org: "o",
    project: "p",
    endpoint: "prod",
  })
  expect((await resolveContext(f)).url).toBe("https://prod.example")
  expect(
    (
      await resolveContext({
        ...f,
        endpoint: "development",
        env: {
          ...f.env,
          BQL_URL: "https://legacy.example",
          BQL_TOKEN: "wrong",
        },
      })
    ).token,
  ).toBe("dev-secret")
  expect(
    (
      await resolveContext({
        ...f,
        env: {
          ...f.env,
          BQL_ENDPOINT: "development",
          BQL_URL: "https://legacy.example",
        },
      })
    ).url,
  ).toBe("https://dev.example")
  const direct = await resolveContext({ ...f, url: "https://direct.example" })
  expect(direct.token).toBeUndefined()
  expect(direct.headers).toEqual({})
  expect(
    (
      await resolveContext({
        ...f,
        env: {
          ...f.env,
          BQL_URL: "https://legacy.example",
          BQL_TOKEN: "legacy-secret",
        },
      })
    ).token,
  ).toBe("legacy-secret")
  await expect(
    resolveContext({ ...f, url: "https://x.example", endpoint: "production" }),
  ).rejects.toThrow("combine")
  await expect(resolveContext({ ...f, org: "other" })).rejects.toThrow(
    "project",
  )
})
test("links survive renames, nested lookup and unlink preserves other files", async () => {
  const f = await fixture()
  await writeFile(join(f.cwd, ".gitignore"), "node_modules/\n")
  await writeLink(f.cwd, {
    version: 1,
    org: "o",
    project: "p",
    endpoint: "prod",
  })
  await mkdir(join(f.cwd, "src"))
  await writeFile(join(f.cwd, ".bql", "keep"), "keep")
  await f.store.mutate((r) => {
    r.organizations[0]!.name = "renamed"
    r.organizations[0]!.projects[0]!.name = "new-app"
  })
  expect(
    (await resolveContext({ ...f, cwd: join(f.cwd, "src") })).org?.name,
  ).toBe("renamed")
  expect(await readFile(join(f.cwd, ".gitignore"), "utf8")).toBe(
    "node_modules/\n.bql/\n",
  )
  await unlinkProject(join(f.cwd, "src"))
  expect(await findLink(f.cwd)).toBeNull()
  expect(await readFile(join(f.cwd, ".bql", "keep"), "utf8")).toBe("keep")
})
test("missing references, stale links, missing bus fail closed; redacted output has no secrets", async () => {
  const f = await fixture()
  await expect(
    resolveContext({ ...f, endpoint: "production", env: {} }),
  ).rejects.toThrow("PROD_KEY")
  const c = await resolveContext({ ...f, endpoint: "production" })
  expect(JSON.stringify(redactContext(c))).not.toContain("secret")
  expect(c.headers["x-vercel-protection-bypass"]).toBe("bypass-secret")
  const bus = await resolveContext({ ...f, service: "bus" })
  expect(bus.token).toBe("bus-secret")
  expect(bus.url).toBe("https://bus.example")
  await expect(
    resolveContext({ ...f, service: "bus", endpoint: "production" }),
  ).rejects.toThrow("bus")
  await writeLink(f.cwd, { version: 1, org: "o", project: "gone" })
  await expect(resolveContext(f)).rejects.toThrow("project")
})
test("unconfigured context retains localhost and explicit URL ignores corrupt registry", async () => {
  const f = await fixture()
  await writeFile(join(f.configDir, "config.json"), "bad json")
  expect(
    (await resolveContext({ ...f, url: "https://direct.example" })).url,
  ).toBe("https://direct.example")
  expect(
    (await resolveContext({ ...f, configDir: join(f.cwd, "missing") })).url,
  ).toBe("http://127.0.0.1:4321")
})
test("explicit parent selection discards incompatible environment child selections", async () => {
  const f = await fixture()
  await f.store.mutate((r) => {
    r.organizations[1]!.projects[0]!.endpoints = [
      {
        id: "other-e",
        name: "production",
        database: { url: "https://other.example" },
      },
    ]
    r.organizations[1]!.projects[0]!.defaultEndpoint = "other-e"
  })
  // A project name from a different organization's environment context must not silently cross over.
  await expect(
    resolveContext({
      ...f,
      org: "other",
      env: {
        ...f.env,
        BQL_ORG: "personal",
        BQL_PROJECT: "app",
        BQL_ENDPOINT: "production",
      },
    }),
  ).rejects.toThrow("project")
})

test("persisted IDs cannot be hijacked by a name or revive removed links", async () => {
  const f = await fixture()
  await writeLink(f.cwd, {
    version: 1,
    org: "o",
    project: "p",
    endpoint: "prod",
  })
  await f.store.mutate((r) => {
    r.organizations[0]!.projects[0]!.endpoints[0]!.name = "prod"
  })
  expect((await resolveContext(f)).url).toBe("https://prod.example")
  await expect(resolveContext({ ...f, endpoint: "prod" })).rejects.toThrow(
    "Ambiguous",
  )
  await f.store.mutate((r) => {
    r.organizations[0]!.projects[0]!.endpoints.splice(1, 1)
  })
  await expect(resolveContext(f)).rejects.toThrow("removed endpoint")
})

test("invalid HTTP credentials fail generically for all sources", async () => {
  const f = await fixture()
  for (const value of [
    "private\u0000secret",
    "private秘密secret",
    "private\r\nsecret",
  ]) {
    for (const options of [
      { ...f, endpoint: "production", env: { ...f.env, PROD_KEY: value } },
      { ...f, token: value },
      { ...f, vercelBypass: value },
      { ...f, url: "https://direct.example", env: { BQL_TOKEN: value } },
      {
        ...f,
        service: "bus" as const,
        url: "https://bus.example",
        env: { BUS_VERCEL_BYPASS: value },
      },
    ]) {
      await expect(resolveContext(options)).rejects.toThrow(
        "Invalid credential",
      )
    }
  }
})

test("explicit empty selection or URL cannot silently fall back to a different target", async () => {
  const f = await fixture()
  for (const extra of [
    { url: "" },
    { org: "" },
    { project: "" },
    { endpoint: "" },
  ])
    await expect(resolveContext({ ...f, ...extra })).rejects.toThrow("empty")
})
