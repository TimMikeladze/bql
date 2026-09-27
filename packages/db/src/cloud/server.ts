import { bodyReader, executeOperation, type Invocation } from "../http/index.ts"
import { errorResponse } from "../server/errors.ts"
import { serverOperations } from "../server/registry.ts"
import { CloudError } from "./errors.ts"
import { StoreUnavailable, StoreOutcomeUnknown } from "../storage/object-store.ts"
import { CLOUD_CAPABILITIES, CLOUD_OPERATIONS, CloudRuntime, type CloudOperationKind, type CloudRuntimeOptions } from "./runtime.ts"

const STATUSES: Record<string, number> = { CLOUD_TIMEOUT: 408, TXID_NOT_AVAILABLE: 425, GENERATION_CHANGED: 409, CLOUD_UNSUPPORTED: 501, CLOUD_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, COMMIT_UNKNOWN: 503, CLOUD_DRAINING: 503, CLOUD_BACKPRESSURE: 503, CLOUD_NOT_INITIALIZED: 503, CLOUD_CONFIG: 400, FORBIDDEN: 403 }
function failure(error: unknown): Response {
  if (error instanceof CloudError) return Response.json({ error: { code: error.code, message: error.message, status: STATUSES[error.code] ?? 503, ...(error.requestId ? { requestId: error.requestId } : {}) } }, { status: STATUSES[error.code] ?? 503, ...(error.requestId ? { headers: { "BQL-Request-ID": error.requestId } } : {}) })
  if (error instanceof StoreUnavailable || error instanceof StoreOutcomeUnknown) return Response.json({ error: { code: "STORE_UNAVAILABLE", message: "Remote storage is unavailable", status: 503 } }, { status: 503 })
  return errorResponse(error)
}
const unsupported = () => failure(new CloudError("CLOUD_UNSUPPORTED", "This protocol or operation is not supported in cloud mode"))

/** Every ordinary server operation is either explicitly supported here or
 * rejected. The fallback also refuses Hrana, WebSocket and generated surfaces;
 * none can bypass the remote publication boundary. */
export async function startCloudServer(options: CloudRuntimeOptions) {
  const runtime = await CloudRuntime.open(options)
  const routes: Record<string, Record<string, (request: Request & { params?: Record<string, string> }) => Response | Promise<Response>>> = {}
  const decorate = (request: Request, response: Response) => {
    if (options.config.server.cors) {
      const origin = request.headers.get("origin") ?? "*"
      response.headers.set("access-control-allow-origin", origin)
      if (origin !== "*") response.headers.set("vary", "Origin")
      response.headers.set("access-control-expose-headers", "BQL-Txid, BQL-Generation, BQL-Revision, BQL-Durability, BQL-Request-ID")
    }
    return response
  }
  const preflight = (request: Request) => decorate(request, new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "authorization,content-type,idempotency-key" } }))
  for (const operation of serverOperations()) {
    const entry = routes[operation.path] ??= { OPTIONS: preflight }
    if (operation.id === "healthz" || operation.id === "readyz") {
      entry[operation.method.toUpperCase()] = async request => {
        const ready = operation.id === "healthz" || await runtime.ready(request.signal)
        return Response.json({ ok: ready, phase: runtime.phase }, { status: ready ? 200 : 503 })
      }
      continue
    }
    if (!CLOUD_OPERATIONS.includes(operation.id as CloudOperationKind)) { entry[operation.method.toUpperCase()] = unsupported; continue }
    const http = { maxBodyBytes: options.config.limits.maxBodyBytes, deferBody: true }
    const reader = operation.body ? bodyReader(operation, http) : undefined
    const execute = executeOperation<Invocation>({ ...operation, handler: (_input, invocation) => runtime.run({ request: invocation.request, ...(reader ? { readBody: async signal => (await reader({ ...invocation, request: new Request(invocation.request, { signal }) }) ?? {}) as Record<string, unknown> } : {}) }, { kind: operation.id as CloudOperationKind, ...(invocation.params.db ? { db: invocation.params.db } : {}), ...(invocation.params.jti ? { jti: invocation.params.jti } : {}) }) }, http)
    entry[operation.method.toUpperCase()] = async request => {
      const invocation = { request, params: request.params ?? {}, url: new URL(request.url) }
      try { return decorate(request, await execute(invocation, invocation)) }
      catch (error) { return decorate(request, failure(error)) }
    }
  }
  routes["/v1/cloud"] = { GET: request => decorate(request, Response.json(CLOUD_CAPABILITIES)), OPTIONS: preflight }
  try {
    const server = Bun.serve({
      port: options.config.server.port, hostname: options.config.server.host,
      routes: routes as never,
      fetch(request) { return request.method === "OPTIONS" ? preflight(request) : decorate(request, unsupported()) },
    })
    return { server, runtime, async close(deadline?: number) { server.stop(); await runtime.close(deadline); await server.stop(true) } }
  } catch (error) { await runtime.close(); throw error }
}
