import { expect, test } from "bun:test"
import { cloudflareApi, CloudflareApiError } from "../../src/deploy/cloudflare-api.ts"

test("Cloudflare API calls reuse native auth and keep credentials out of URLs and errors", async () => {
  let authCalls = 0
  const api = cloudflareApi({
    account: "a".repeat(32), cwd: "/tmp",
    runner: async command => {
      expect(command.args).toEqual(["auth", "token", "--json"])
      authCalls++
      return { stdout: '{"type":"oauth","token":"private-value"}', stderr: "", exitCode: 0 }
    },
    fetch: async (input, init) => {
      expect(String(input)).toBe(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/containers/me`)
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-value")
      expect(init?.redirect).toBe("error")
      if (authCalls === 1) return Response.json({ success: true, result: { available: true } })
      return Response.json({ success: false, errors: [{ message: "private-value" }] }, { status: 403 })
    },
  })
  expect(await api<{ available: boolean }>("/containers/me")).toEqual({ available: true })
  await expect(api("/containers/me")).rejects.toThrow("HTTP 403")
  try { await api("/containers/me") } catch (error) {
    expect(error).toBeInstanceOf(CloudflareApiError)
    expect(JSON.stringify(error)).not.toContain("private-value")
    expect(String(error)).not.toContain("private-value")
  }
})

test("the account transport cannot forward native credentials to another origin", async () => {
  let called = false
  const api = cloudflareApi({ account: "a".repeat(32), cwd: "/tmp", runner: async () => { called = true; throw new Error("unexpected") } })
  await expect(api("https://other.test")).rejects.toThrow("path")
  await expect(api("//other.test")).rejects.toThrow("path")
  expect(called).toBe(false)
})
