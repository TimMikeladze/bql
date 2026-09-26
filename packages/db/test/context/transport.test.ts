import { expect, test } from "bun:test"
import { cliSocketFactory } from "../../src/cli/transport.ts"
test("Bun socket handshake includes protection header and retains protocol", async () => {
  let bypass: string | null = null,
    protocol: string | null = null
  const server = Bun.serve({
    port: 0,
    fetch(req, s) {
      bypass = req.headers.get("x-vercel-protection-bypass")
      protocol = req.headers.get("sec-websocket-protocol")
      if (s.upgrade(req)) return
      return new Response("bad", { status: 400 })
    },
    websocket: { message() {} },
  })
  try {
    const socket = cliSocketFactory({
      "x-vercel-protection-bypass": "private",
    })(server.url.toString().replace("http", "ws"), "bql.test")
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.close()
        resolve()
      })
      socket.addEventListener("error", () =>
        reject(new Error("Handshake failed")),
      )
    })
    expect(String(bypass)).toBe("private")
    expect(String(protocol)).toBe("bql.test")
  } finally {
    server.stop(true)
  }
})
test("socket redirect does not forward protection credentials", async () => {
  let hits = 0
  const target = Bun.serve({
    port: 0,
    fetch() {
      hits++
      return new Response("no")
    },
  })
  const redirect = Bun.serve({
    port: 0,
    fetch() {
      return Response.redirect(target.url.toString(), 307)
    },
  })
  try {
    const socket = cliSocketFactory({
      "x-vercel-protection-bypass": "private",
    })(redirect.url.toString().replace("http", "ws"), "bql.test")
    await new Promise<void>((resolve) => {
      socket.addEventListener("error", () => {
        socket.close()
        resolve()
      })
      socket.addEventListener("close", () => resolve())
    })
    expect(hits).toBe(0)
  } finally {
    redirect.stop(true)
    target.stop(true)
  }
})
