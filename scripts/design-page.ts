// Renders docs/design.md into a self-contained HTML page (used to publish the design for review).
// Usage: bun scripts/design-page.ts [out.html]
import { readFileSync, writeFileSync } from "node:fs";

const md = readFileSync(new URL("../docs/design.md", import.meta.url), "utf8");
let body = Bun.markdown.html(md, {});

// Slugify h2/h3 headings and collect a table of contents.
const toc: { level: number; id: string; text: string }[] = [];
body = body.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => {
  const text = inner.replace(/<[^>]+>/g, "");
  const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  toc.push({ level: Number(lvl), id, text });
  return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
});
// Drop the markdown H1 (the page header carries the title) and the leading intro paragraph rule.
body = body.replace(/<h1>[\s\S]*?<\/h1>/, "");
// Wrap tables so wide ones scroll instead of the page.
body = body.replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, "</table></div>");

const nav = toc
  .filter((t) => t.level === 2)
  .map((t) => `<a href="#${t.id}">${t.text.replace(/^(\d+)\.\s*/, '<span class="n">$1</span>')}</a>`)
  .join("\n");

const html = `<title>BunQL Design</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{
  --ground:#F5F7F6; --surface:#FFFFFF; --ink:#171B19; --muted:#5C6461; --rule:#D7DDDA;
  --accent:#0B6E62; --accent-ink:#FFFFFF; --accent-soft:#DDF0EC; --code:#EEF2F0; --warn:#8A5A00; --warn-soft:#FBF1DC;
  --display:"Familjen Grotesk","Helvetica Neue",Arial,sans-serif;
  --body:"Source Sans 3","Segoe UI",system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --ground:#0F1312; --surface:#161B19; --ink:#E4E9E6; --muted:#98A29D; --rule:#2B3330;
  --accent:#46C4B1; --accent-ink:#06211D; --accent-soft:#113E38; --code:#1B2220; --warn:#E3B45C; --warn-soft:#2E2510;
}}
:root[data-theme="dark"]{
  --ground:#0F1312; --surface:#161B19; --ink:#E4E9E6; --muted:#98A29D; --rule:#2B3330;
  --accent:#46C4B1; --accent-ink:#06211D; --accent-soft:#113E38; --code:#1B2220; --warn:#E3B45C; --warn-soft:#2E2510;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--body);font-size:16.5px;line-height:1.55;padding-inline:16px;padding-block:0 64px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.page{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:1fr;gap:0 48px}
@media (min-width:1100px){.page{grid-template-columns:236px minmax(0,1fr)}}
header.top{grid-column:1/-1;padding-block:40px 24px;border-bottom:1px solid var(--rule);margin-bottom:24px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1.title{font-family:var(--display);font-weight:700;font-size:clamp(34px,5vw,54px);line-height:1.02;letter-spacing:-.02em;margin:10px 0 12px;text-wrap:balance}
.dek{max-width:66ch;color:var(--muted);font-size:18px;margin:0 0 18px}
.meta{display:flex;flex-wrap:wrap;gap:8px 20px;font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.meta b{color:var(--ink);font-weight:500}
nav.toc{display:none}
@media (min-width:1100px){nav.toc{display:block;position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto;padding-right:8px}}
nav.toc a{display:flex;gap:10px;padding:5px 0;font-size:14px;color:var(--muted);border-left:2px solid transparent;padding-left:12px;line-height:1.3}
nav.toc a:hover{color:var(--ink);text-decoration:none;border-left-color:var(--rule)}
nav.toc .n{font-family:var(--mono);font-size:12px;color:var(--accent);min-width:1.6em;text-align:right}
article{min-width:0;max-width:78ch}
.focus{background:var(--accent-soft);border-left:3px solid var(--accent);padding:12px 16px;margin:0 0 28px;font-size:15.5px}
.focus b{font-weight:600}
article h2{font-family:var(--display);font-weight:600;font-size:27px;letter-spacing:-.015em;line-height:1.15;margin:52px 0 14px;padding-top:14px;border-top:1px solid var(--rule);text-wrap:balance;scroll-margin-top:16px}
article h3{font-family:var(--display);font-weight:600;font-size:19.5px;margin:32px 0 10px;text-wrap:balance;scroll-margin-top:16px}
article p{margin:0 0 14px}
article ul,article ol{padding-left:1.35em;margin:0 0 14px}
article li{margin:0 0 5px}
article li p{margin:0}
article code{font-family:var(--mono);font-size:.86em;background:var(--code);padding:1px 5px;border-radius:3px}
article pre{background:var(--code);border:1px solid var(--rule);border-radius:6px;padding:14px 16px;overflow-x:auto;margin:0 0 18px;font-size:13px;line-height:1.5}
article pre code{background:none;padding:0;font-size:inherit}
.tbl{overflow-x:auto;margin:0 0 18px;border:1px solid var(--rule);border-radius:6px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{text-align:left;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--rule)}
th{font-family:var(--mono);font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-weight:500;background:var(--code)}
tr:last-child td{border-bottom:none}
td{font-variant-numeric:tabular-nums}
article hr{border:0;border-top:1px solid var(--rule);margin:36px 0}
article strong{font-weight:600}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
footer{grid-column:1/-1;margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);font-family:var(--mono);font-size:12.5px;color:var(--muted)}
</style>
<div class="page">
  <header class="top">
    <div class="eyebrow">Design proposal · v0 for review</div>
    <h1 class="title">BunQL</h1>
    <p class="dek">Multi-tenant SQLite on Bun: one process, thousands of databases, sub-millisecond queries over HTTP, WebSocket and SSE, physical WAL-shipping replication, realtime change feeds, point-in-time restore, optional HA. Standalone by default.</p>
    <div class="meta">
      <span>date <b>2026-09-11</b></span>
      <span>runtime <b>Bun 1.4.0</b></span>
      <span>sqlite <b>3.51 / 3.53</b></span>
      <span>source <b>docs/design.md</b></span>
      <span>proofs <b>experiments/</b></span>
    </div>
  </header>
  <nav class="toc" aria-label="Sections">
${nav}
  </nav>
  <article>
    <div class="focus"><b>Where I want your eyes:</b> §6–9 are the API surfaces (HTTP, WebSocket, replication wire, TypeScript client, embedded library, CLI, config) and §13 lists the eleven decisions I need from you, with my recommendation first on each. §2 is what was proven on real bits before any of this was written.</div>
${body}
  </article>
  <footer>BunQL design v0 · generated from docs/design.md · numbers measured on this machine, see experiments/README.md</footer>
</div>
`;

const out = process.argv[2] ?? "bunql-design.html";
writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes, ${toc.length} headings)`);
