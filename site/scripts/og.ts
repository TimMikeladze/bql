// Renders the 1200×630 card from the page's own tokens and claim, in headless Chrome over CDP,
// to public/og.png. Launches its own Chrome on a free debugging port with a throwaway profile.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { site } from "../src/content.ts"
import { productMark } from "../src/icons.ts"
import { CSS } from "../src/render.ts"
import { esc } from "../src/markdown.ts"

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const lede = "Thousands of SQLite databases in one Bun process, and the durable bus that runs work against them."

export function cardHtml(): string {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${CSS}
html,body{margin:0;width:1200px;height:630px;overflow:hidden}
.card{box-sizing:border-box;width:1200px;height:630px;padding:72px 80px;display:flex;flex-direction:column;background:var(--paper)}
h1{margin-top:44px;font:700 78px/1.02 var(--sans);letter-spacing:-.04em;max-width:15ch}
p{margin-top:26px;font-size:26px;color:var(--body);max-width:46ch}
.row{margin-top:auto;display:flex;align-items:center;gap:18px;font:22px var(--mono);color:var(--soft)}
.row code{font-size:22px;padding:.3em .6em;border:1px solid var(--line);border-radius:10px}
.row i{font-style:normal;color:var(--accent)}</style></head><body><div class="card">
${productMark(64)}<h1>${esc(site.h1)}</h1><p>${esc(lede)}</p>
<div class="row"><code>${esc(site.install.humans.cmd)}</code><i>·</i><span>zero dependencies</span><i>·</i><span>${esc(new URL(site.origin).host)}</span></div>
</div></body></html>`
}

if (import.meta.main) {
  const dir = mkdtempSync(join(tmpdir(), "og-"))
  const file = join(dir, "card.html")
  writeFileSync(file, cardHtml())
  const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const port = probe.port; probe.stop(true)
  const proc = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, "p")}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdout: "ignore", stderr: "ignore" })
  try {
    let ws = ""
    for (let i = 0; i < 100 && !ws; i++) {
      try { ws = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "" } catch {}
      if (!ws) await Bun.sleep(100)
    }
    const sock = new WebSocket(ws); await new Promise((r) => (sock.onopen = r))
    let id = 0; const wait = new Map<number, (v: any) => void>()
    sock.onmessage = (e) => { const m = JSON.parse(String(e.data)); wait.get(m.id)?.(m.result) }
    const send = (method: string, params = {}) => new Promise<any>((r) => { wait.set(++id, r); sock.send(JSON.stringify({ id, method, params })) })
    await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false })
    await send("Page.navigate", { url: "file://" + file }); await Bun.sleep(800)
    const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 } })
    writeFileSync(join(import.meta.dir, "..", "public", "og.png"), Buffer.from(shot.data, "base64"))
    sock.close(); console.log("site: wrote public/og.png")
  } finally { proc.kill(); rmSync(dir, { recursive: true, force: true }) }
}
