import type { WebSocketFactory, WebSocketLike } from "../client/socket.ts"
/** Proxy credentials must not be forwarded by redirects, including same-origin redirects. */
export const cliFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, { ...init, redirect: "error" }),
  { preconnect: fetch.preconnect },
)
export function cliSocketFactory(
  headers: Record<string, string>,
): WebSocketFactory {
  const BunSocket = WebSocket as unknown as new (
    url: string,
    options: { protocols: string[]; headers: Record<string, string> },
  ) => WebSocketLike
  return (url, protocol) =>
    new BunSocket(url, { protocols: [protocol], headers })
}

/** A named endpoint is an explicit credential boundary, including SDK NOT_PRIMARY retries. */
export function endpointFetch(base: string): typeof fetch {
  const origin = new URL(base).origin
  return Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const target = input instanceof Request ? input.url : input.toString()
      if (new URL(target).origin !== origin)
        throw new Error(
          "Endpoint moved to a different origin; select its saved endpoint explicitly",
        )
      return cliFetch(input, init)
    },
    { preconnect: fetch.preconnect },
  )
}
