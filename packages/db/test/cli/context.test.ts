import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
const CLI = resolve(import.meta.dir, "../../src/cli.ts"),
  dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  )
})
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "bql-cli-context-"))
  dirs.push(cwd)
  const configDir = join(cwd, "config")
  async function run(...args: string[]) {
    const child = Bun.spawn(["bun", CLI, ...args, "--config-dir", configDir], {
      cwd,
      env: {
        ...process.env,
        BQL_URL: "",
        BQL_TOKEN: "",
        BQL_ADMIN_KEY: "",
        BQL_ORG: "",
        BQL_PROJECT: "",
        BQL_ENDPOINT: "",
        KEY: "fixture-secret",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, out, err }
  }
  return { cwd, configDir, run }
}
test("operator can manage orgs, projects, endpoints, links and defaults", async () => {
  const f = await fixture(),
    run = f.run
  for (const args of [
    ["org", "add", "personal"],
    ["switch", "personal"],
    ["project", "add", "app"],
    ["project", "use", "app"],
    [
      "endpoint",
      "add",
      "dev",
      "--url",
      "https://dev.example",
      "--token-env",
      "KEY",
    ],
    ["endpoint", "add", "prod", "--url", "https://prod.example"],
    ["link", "--org", "personal", "--project", "app", "--endpoint", "dev"],
  ]) {
    const r = await run(...args)
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
  }
  let c = JSON.parse((await run("context", "--json")).out)
  expect(c.endpoint.name).toBe("dev")
  expect(c.authenticated).toBe(true)
  expect((await run("endpoint", "inspect", "dev", "--json")).out).not.toContain(
    "fixture-secret",
  )
  expect(
    (await run("endpoint", "update", "dev", "--name", "development")).code,
  ).toBe(0)
  c = JSON.parse((await run("context", "--json")).out)
  expect(c.endpoint.name).toBe("development")
  expect((await run("endpoint", "use", "prod")).code).toBe(0)
  expect(JSON.parse((await run("context", "--json")).out).url).toBe(
    "https://prod.example",
  )
  expect((await run("project", "remove", "app")).code).toBe(1)
  expect((await run("unlink")).code).toBe(0)
  expect((await run("endpoint", "use", "prod", "--default")).code).toBe(0)
  expect(JSON.parse((await run("context", "--json")).out).endpoint.name).toBe(
    "prod",
  )
  expect((await run("project", "remove", "app", "--recursive")).code).toBe(0)
  expect((await run("context")).code).toBe(1)
  expect(JSON.parse((await run("project", "list", "--json")).out)).toEqual([])
})
test("noninteractive link fails promptly with missing context; URL replacement drops old auth", async () => {
  const f = await fixture()
  expect((await f.run("link")).code).toBe(1)
  for (const args of [
    ["org", "add", "o"],
    ["switch", "o"],
    ["project", "add", "p"],
    ["project", "use", "p"],
    [
      "endpoint",
      "add",
      "e",
      "--url",
      "https://old.example",
      "--token-env",
      "KEY",
    ],
  ])
    expect((await f.run(...args)).code).toBe(0)
  expect(
    (await f.run("endpoint", "update", "e", "--url", "https://new.example"))
      .code,
  ).toBe(0)
  expect(JSON.parse((await f.run("context", "--json")).out).authenticated).toBe(
    false,
  )
  expect(
    await readFile(join(f.configDir, "config.json"), "utf8"),
  ).not.toContain("fixture-secret")
  const nested = join(f.cwd, "nested")
  await mkdir(nested)
  expect(
    (await f.run("link", "--cwd", nested, "--org", "o", "--project", "p")).code,
  ).toBe(0)
  expect(
    JSON.parse((await f.run("context", "--cwd", nested, "--json")).out).endpoint
      .name,
  ).toBe("e")
})

test("invalid credential values fail without exposing secrets in CLI errors", async () => {
  const f = await fixture()
  for (const args of [
    ["org", "add", "o"],
    ["switch", "o"],
    ["project", "add", "p"],
    ["project", "use", "p"],
    [
      "endpoint",
      "add",
      "e",
      "--url",
      "http://127.0.0.1:1",
      "--token-env",
      "KEY",
    ],
  ])
    expect((await f.run(...args)).code).toBe(0)
  for (const secret of ["private秘密secret", "private\u0000secret"]) {
    for (const mode of ["env", "override", "bypass", "legacy"] as const) {
      const args =
        mode === "legacy"
          ? ["db", "list", "--url", "http://127.0.0.1:1"]
          : ["db", "list", "--endpoint", "e"]
      if (mode === "override") args.push("--token", secret)
      if (mode === "bypass") args.push("--vercel-bypass", secret)
      // NUL cannot travel in OS argv/environment; cover it in the resolver unit test instead.
      if (secret.includes("\u0000")) continue
      const child = Bun.spawn(
        ["bun", CLI, ...args, "--config-dir", f.configDir],
        {
          cwd: f.cwd,
          env: {
            ...process.env,
            BQL_ORG: "",
            BQL_PROJECT: "",
            BQL_ENDPOINT: "",
            BQL_URL: "",
            BQL_ADMIN_KEY: "",
            BQL_TOKEN: mode === "legacy" ? secret : "",
            KEY: mode === "env" ? secret : "valid",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(1)
      expect(out + err).not.toContain(secret)
      expect(err).toContain("credential")
    }
  }
})

test("local serve and help ignore corrupt remote context", async () => {
  const f = await fixture()
  await mkdir(f.configDir)
  await Bun.write(join(f.configDir, "config.json"), "broken json")
  expect((await f.run("--help")).code).toBe(0)
  const server = Bun.spawn(
    [
      "bun",
      CLI,
      "serve",
      "--port",
      "0",
      "--admin-key",
      "local-fixture-key",
      "--dir",
      join(f.cwd, "data"),
      "--config-dir",
      f.configDir,
    ],
    {
      cwd: f.cwd,
      env: { ...process.env, BQL_ORG: "missing" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const reader = server.stdout.getReader()
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(3000).then(() => {
        throw new Error("Server startup timed out")
      }),
    ])
    expect(new TextDecoder().decode(first.value)).toContain("bql http")
    reader.releaseLock()
  } finally {
    server.kill()
    await server.exited
  }
})
