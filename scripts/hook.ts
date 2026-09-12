import { mkdir, readdir, unlink } from "node:fs/promises";
const dir = ".prototype/hook-spool";
await mkdir(dir, { recursive: true });
if (!process.argv.includes("--flush")) {
  const raw = await Bun.stdin.text();
  const input = JSON.parse(raw);
  const event = {
    id: crypto.randomUUID(),
    source: `urn:agenticbus:hook:${process.env.BUS_HOOK_PROVIDER ?? "generic"}`,
    type: String(input.hook_event_name ?? "observation"),
    data: input,
  };
  await Bun.write(`${dir}/${event.id}.json`, JSON.stringify(event));
}
for (const file of await readdir(dir)) {
  if (!file.endsWith(".json")) continue;
  try {
    const r = await fetch(
      `${process.env.BUS_URL ?? "http://127.0.0.1:4317"}/api/hooks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.BUS_TOKEN ?? ""}`,
          "Content-Type": "application/json",
        },
        body: await Bun.file(`${dir}/${file}`).text(),
        signal: AbortSignal.timeout(1000),
      },
    );
    if (r.ok) await unlink(`${dir}/${file}`);
    else console.error(`Hook retained locally: HTTP ${r.status}`);
  } catch {
    console.error("Hook retained locally; coordinator unavailable");
    break;
  }
}
// Observation only: no stdout payload that could accidentally authorize a tool.
