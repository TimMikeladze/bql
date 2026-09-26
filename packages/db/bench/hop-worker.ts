// The far end of `bench/hop.ts`: replies to a hop with a message of the same shape it received.
// Nothing here touches SQLite, because the point is to measure the channel and nothing else.

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(value: unknown): void
}

const SHAPE = new URL(import.meta.url).searchParams.get("shape") === "empty" ? "empty" : "http"
const BODY = new Uint8Array(200)
const HEADERS: [string, string][] = [
  ["content-type", "application/json"],
  ["bql-node", "bench"],
  ["bql-role", "primary"],
  ["bql-txid", "2"],
]

function reply(id: number): Record<string, unknown> {
  if (SHAPE === "empty") return { id }
  return { id, status: 200, headers: HEADERS, body: BODY }
}

let batch: Record<string, unknown>[] = []
let scheduled = false

function flush(): void {
  scheduled = false
  const out = batch
  batch = []
  self.postMessage(out.length === 1 ? out[0] : { items: out })
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data as { id?: number; items?: { id: number }[] }
  // A batched send is answered with a batched reply, so the two directions are measured together.
  if (message.items) {
    for (const one of message.items) batch.push(reply(one.id))
    if (!scheduled) {
      scheduled = true
      queueMicrotask(flush)
    }
    return
  }
  self.postMessage(reply(message.id as number))
}
