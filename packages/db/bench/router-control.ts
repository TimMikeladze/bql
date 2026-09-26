// The control for `bench/router.ts`: a `Bun.serve` that answers the benchmark's route with a
// canned body and does nothing else (`docs/p4-router-hop.md` §2, `docs/p6-router-resolution.md`).
//
//   bun run bench/router-control.ts --port 4500 [--mode plain|headers|hop-shape]
//
// It exists so the same load client drives the control and the real node over the *same* route,
// the same body size and the same header count — an A/B where the only difference is the server.
//
//   plain      — one `new Response(BODY, { status, headers })` from a literal. The floor.
//   headers    — the same, built from the `[string, string][]` pairs a worker reply carries, which
//                is suspect (a) in §4 of `docs/p4-router-hop.md`.
//   hop-shape  — `headers`, plus a `structuredClone` of those pairs and the body in each direction,
//                which is suspect (b) with no thread and no channel under it.
//
// The three together separate "what a Response costs" from "what the clone costs" from "what the
// channel costs", without a worker anywhere near the measurement.

function flag(name: string, fallback: string): string {
  const at = Bun.argv.indexOf(`--${name}`)
  return at >= 0 ? (Bun.argv[at + 1] as string) : fallback
}

const PORT = Number(flag("port", "4500"))
const MODE = flag("mode", "plain")

/** The shape and size of a one-row `POST /v1/db/{db}/query` answer, so the bytes match. */
const BODY = JSON.stringify({
  columns: ["v"],
  types: ["TEXT"],
  rows: [["x"]],
  rowsAffected: 0,
  lastInsertRowid: null,
  txid: 1,
  durationUs: 4,
  vmSteps: 12,
})

/** The headers a `/v1/db/{db}/query` answer actually carries, as the worker sends them. */
const PAIRS: [string, string][] = [
  ["content-type", "application/json"],
  ["bql-node", "bench"],
  ["bql-role", "primary"],
  ["bql-txid", "1"],
]

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  development: false,
  async fetch(request) {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok")
    // The real router reads the body before it hops, so the control does too.
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null
    if (MODE === "plain") {
      return new Response(BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (MODE === "headers") {
      return new Response(BODY, { status: 200, headers: PAIRS })
    }
    if (MODE === "clone-headers") {
      // Only the header pairs cross, in both directions. The body is not cloned.
      void structuredClone({ method: request.method, url: request.url, headers: headerPairs(request.headers) })
      const reply = structuredClone({ status: 200, headers: PAIRS })
      return new Response(BODY, { status: reply.status, headers: reply.headers })
    }
    if (MODE === "clone-body") {
      // Only the bodies cross. The headers are literals.
      void structuredClone({ method: request.method, url: request.url, body })
      const reply = structuredClone({ status: 200, body: REPLY_BYTES })
      return new Response(reply.body, { status: 200, headers: PAIRS })
    }
    if (MODE === "hop-flat") {
      // `hop-shape`, with the headers as one joined string instead of an array of pairs — the same
      // bytes, one clone instead of a nested structure of a dozen small ones.
      const outbound = structuredClone({
        method: request.method,
        url: request.url,
        headers: flatten(headerPairs(request.headers)),
        body,
      })
      const reply = structuredClone({ status: 200, headers: FLAT_PAIRS, body: REPLY_BYTES })
      void outbound
      return new Response(reply.body, { status: reply.status, headers: unflatten(reply.headers) })
    }
    // hop-shape: everything a hop crosses, cloned in both directions, on one thread.
    const outbound = structuredClone({
      method: request.method,
      url: request.url,
      headers: headerPairs(request.headers),
      body,
    })
    const reply = structuredClone({
      status: 200,
      headers: PAIRS,
      body: REPLY_BYTES,
    })
    void outbound
    return new Response(reply.body, { status: reply.status, headers: reply.headers })
  },
})

const REPLY_BYTES = new TextEncoder().encode(BODY)
const FLAT_PAIRS = flatten(PAIRS)

/** `[["a","b"],["c","d"]]` as `"a\nb\nc\nd"`: the same bytes, one clone instead of a dozen. */
function flatten(pairs: [string, string][]): string {
  const parts: string[] = []
  for (const [key, value] of pairs) parts.push(key, value)
  return parts.join("\n")
}

function unflatten(flat: string): [string, string][] {
  const parts = flat.split("\n")
  const out: [string, string][] = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push([parts[i] as string, parts[i + 1] as string])
  return out
}

function headerPairs(headers: Headers): [string, string][] {
  const out: [string, string][] = []
  headers.forEach((value, key) => out.push([key, value]))
  return out
}

console.log(`router-control ${MODE} on ${server.port}`)
