import { validateHttpCredential } from "../context/model.ts"
import { parseNativeJson } from "./driver.ts"
import { runNative, type NativeRunner } from "./runner.ts"

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>
export class CloudflareApiError extends Error {
  constructor(readonly status: number) { super(`Cloudflare API request failed (HTTP ${status})`); this.name = "CloudflareApiError" }
}
export type CloudflareApi = <T = unknown>(path: string, options?: { method?: "GET" | "POST" | "PUT"; body?: unknown }) => Promise<T>

/** Wrangler owns login/token refresh; the HTTP adapter covers APIs its CLI does not expose. */
export function cloudflareApi(options: { account: string; cwd: string; runner?: NativeRunner; fetch?: ProviderFetch }): CloudflareApi {
  if (!/^[a-f0-9]{32}$/.test(options.account)) throw new Error("Invalid Cloudflare account ID")
  return async <T>(path: string, request: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {}): Promise<T> => {
    if (!/^\/[a-z][a-zA-Z0-9/_?=&.-]*$/.test(path) || path.includes("..") || path.includes("//")) throw new Error("Invalid Cloudflare account API path")
    const result = await (options.runner ?? runNative)({ executable: "wrangler", args: ["auth", "token", "--json"], cwd: options.cwd, timeoutMs: 30000 })
    const auth = parseNativeJson<{ token?: string }>(result.stdout, "wrangler auth token")
    if (typeof auth?.token !== "string" || !auth.token) throw new Error("No native Cloudflare token; run wrangler login")
    validateHttpCredential(auth.token)
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${options.account}${path}`, {
        method: request.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      })
    } catch { throw new Error("Cloudflare API request could not be completed; remote changes may have succeeded") }
    if (!response.ok) throw new CloudflareApiError(response.status)
    let body: { success?: boolean; result?: T }
    try { body = await response.json() as typeof body }
    catch { throw new Error("Cloudflare API returned an invalid response") }
    if (body.success !== true) throw new CloudflareApiError(502)
    return body.result as T
  }
}
