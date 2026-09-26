import { PreconditionFailed, StoreUnavailable } from "../../src/storage/object-store.ts"
import { FakeObjectStore } from "./fake-store.ts"

/** Process-independent test boundary for the real Bun S3 signing/fetch adapter. */
export function serveFakeObjectStore(store = new FakeObjectStore()) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const key = decodeURIComponent(new URL(request.url).pathname.split("/").slice(2).join("/"))
    try {
      if (request.method === "GET") {
        const result = await store.get(key)
        return result ? new Response(result.body, { headers: { etag: result.version } }) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
      }
      if (request.method !== "PUT") return new Response(null, { status: 405 })
      const body = new Uint8Array(await request.arrayBuffer())
      const expected = request.headers.get("if-match")
      if (!expected && request.headers.get("if-none-match") !== "*") return new Response(null, { status: 400 })
      const result = expected ? await store.replace(key, expected, body) : await store.create(key, body)
      return new Response(null, { headers: { etag: result.version } })
    } catch (error) {
      return new Response(null, { status: error instanceof PreconditionFailed ? 412 : error instanceof StoreUnavailable ? 503 : 500 })
    }
  } })
  return { store, server, endpoint: `http://127.0.0.1:${server.port}` }
}
