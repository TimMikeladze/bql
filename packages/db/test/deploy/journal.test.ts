import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { initDeployment } from "../../src/deploy/config.ts"
import { withDeploymentJournal } from "../../src/deploy/journal.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "bql-journal-")); dirs.push(dir)
  return { dir, config: await initDeployment("fly", dir) }
}

test("interrupted steps retain resource ownership and stable secrets for a subsequent apply", async () => {
  const { dir, config } = await setup()
  let admin = "", directory = ""
  await expect(withDeploymentJournal(config, dir, async journal => {
    admin = journal.secrets.BQL_ADMIN_KEY!; directory = journal.directory
    await journal.step("app", async () => {
      await journal.recordResource("app", "app-123")
      throw new Error("interrupted after remote create")
    })
  })).rejects.toThrow("interrupted")
  await withDeploymentJournal(config, dir, async journal => {
    expect(journal.secrets.BQL_ADMIN_KEY).toBe(admin)
    expect(journal.state.resources.app).toBe("app-123")
    expect(journal.state.steps.app?.status).toBe("started")
    await journal.step("app", async () => {})
    await journal.step("app", async () => { throw new Error("completed operation repeated") })
  })
  expect(await readFile(join(directory, "state.json"), "utf8")).not.toContain(admin)
  expect((await stat(join(directory, "secrets.json"))).mode & 0o777).toBe(0o600)
  await expect(withDeploymentJournal({ ...config, name: "another-name" }, dir, async () => {})).rejects.toThrow("configuration changed")
})

test("two apply processes cannot provision the same deployment concurrently", async () => {
  const { dir, config } = await setup()
  await withDeploymentJournal(config, dir, async () => {
    await expect(withDeploymentJournal(config, dir, async () => { throw new Error("entered second apply") })).rejects.toThrow("already running")
  })
})

test("process death releases the deployment lock without deleting state or manual unlocking", async () => {
  const { dir, config } = await setup()
  const module = new URL("../../src/deploy/journal.ts", import.meta.url).pathname
  const code = `import {withDeploymentJournal} from ${JSON.stringify(module)};
    await withDeploymentJournal(${JSON.stringify(config)},${JSON.stringify(dir)},async journal=>{
      await journal.recordResource("app","before-crash");console.log("locked");await Bun.sleep(60000);
    });`
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" })
  try {
    const reader = child.stdout.getReader()
    const first = await reader.read()
    reader.releaseLock()
    expect(new TextDecoder().decode(first.value)).toContain("locked")
    child.kill("SIGKILL")
    await child.exited
    await withDeploymentJournal(config, dir, async journal => {
      expect(journal.state.resources.app).toBe("before-crash")
    })
  } finally { child.kill("SIGKILL"); await child.exited }
})
