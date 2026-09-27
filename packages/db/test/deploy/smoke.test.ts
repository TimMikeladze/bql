import { expect, test } from "bun:test"
import { probeDeployment } from "../../src/deploy/smoke.ts"
test("readiness accepts disk and cloud contracts, refuses errors and credential redirects", async () => {
  let body: unknown = { ready: true, node: "test", role: "primary" }, status = 200, redirect = false
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => redirect ? Response.redirect("https://example.com", 302) : Response.json(body, { status }) })
  try {
    const connection = { url: `http://127.0.0.1:${server.port}`, token: "" }
    expect(await probeDeployment(connection)).toBe(true)
    body = { ok: true, phase: "ready" }
    expect(await probeDeployment(connection)).toBe(true)
    status = 503
    expect(await probeDeployment(connection)).toBe(false)
    status = 200; body = { ready: false }
    expect(await probeDeployment(connection)).toBe(false)
    redirect = true
    expect(await probeDeployment({ ...connection, bypass: "private" })).toBe(false)
  } finally { server.stop(true) }
})
