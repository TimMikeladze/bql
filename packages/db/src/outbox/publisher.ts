// X6: the relay's half of the bus's HTTP API — publish a batch, nothing else.
//
// A few lines of `fetch` rather than an import of `bql.sh/bus/client`: `packages/db` and
// `packages/bus` do not import each other's source (`docs/monorepo.md`), and the relay needs one
// route. `POST /api/publish/batch` is one request and one bus transaction per batch; a bus that
// predates it answers 404 and the batch goes one message at a time instead, which is slower and
// exactly as correct, because every message carries its own dedupe key.

export interface BusMessage {
  subject: string
  key: string
  dedupeKey: string
  body: unknown
}

export interface BusTarget {
  url: string
  token: string
  workspace?: string
}

export class BusPublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "BusPublishError"
  }
}

export interface Publisher {
  publish(messages: BusMessage[]): Promise<void>
}

export function httpPublisher(
  target: BusTarget,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Publisher {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  let batched = true
  const post = async (route: string, body: unknown): Promise<Response> =>
    doFetch(`${target.url}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/json",
        ...(target.workspace ? { "x-bus-workspace": target.workspace } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  const check = async (response: Response): Promise<void> => {
    if (response.ok) {
      await response.body?.cancel()
      return
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new BusPublishError(
      `bus answered ${response.status}: ${payload.error ?? response.statusText}`,
      response.status,
    )
  }
  return {
    async publish(messages: BusMessage[]): Promise<void> {
      if (messages.length === 0) return
      if (batched) {
        const response = await post("/api/publish/batch", { messages })
        // 413: larger than the bus's request ceiling or its `--publish-rate` burst. Halving until
        // it fits is correct because each half is its own transaction and every message its own
        // dedupe key; a half that lands before the other fails is simply not sent twice.
        if (response.status === 413 && messages.length > 1) {
          await response.body?.cancel()
          const half = Math.ceil(messages.length / 2)
          await this.publish(messages.slice(0, half))
          await this.publish(messages.slice(half))
          return
        }
        if (response.status !== 404) return check(response)
        await response.body?.cancel()
        batched = false
      }
      for (const message of messages) await check(await post("/api/publish", message))
    },
  }
}
