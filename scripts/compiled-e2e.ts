#!/usr/bin/env bun
/**
 * Run the full end-to-end suite against the **compiled binary**.
 *
 * `bun run test:e2e` runs the TypeScript. That proves the code works; it does
 * not prove the thing people download works, and the two differ in exactly the
 * places `--compile` is fussy about: assets read from disk, `import.meta.dir`,
 * dynamic imports of computed paths. Those failures are invisible until
 * someone runs the release.
 *
 *   bun scripts/compiled-e2e.ts
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function run(command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

const target = `bun-${process.platform === "darwin" ? "darwin" : "linux"}-${
  process.arch === "arm64" ? "arm64" : "x64"
}`;
const binary = `${root}/dist/bin/agenticbus-${target.replace(/^bun-/, "")}`;

if (!(await Bun.file(binary).exists())) {
  console.log("building the binary first…");
  if ((await run(["bun", "scripts/build-binary.ts", "--target", target])) !== 0)
    process.exit(1);
}

console.log(`\n— end-to-end against ${binary}\n`);
const e2e = await run(["bun", "scripts/e2e.ts"], { AGENTICBUS_BIN: binary });
if (e2e !== 0) {
  console.error("the compiled binary failed the end-to-end suite");
  process.exit(1);
}

// The dashboard is the part `--compile` most reliably breaks: it is the only
// thing the binary serves that did not come from a TypeScript import.
const port = 4790 + Math.floor(Math.random() * 100);
const scratch = `${root}/dist/bin/.e2e-${port}`;
const bus = Bun.spawn([binary, "serve", "--data", scratch, "--port", String(port)], {
  cwd: root,
  stdout: "ignore",
  stderr: "ignore",
});
try {
  let ok = false;
  for (let attempt = 0; attempt < 60 && !ok; attempt++) {
    try {
      ok = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {}
    if (!ok) await Bun.sleep(100);
  }
  if (!ok) throw new Error("the compiled binary never answered /health");
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  const assetPath = /src="([^"]+\.js)"/.exec(html)?.[1];
  const asset = assetPath
    ? await fetch(`http://127.0.0.1:${port}${assetPath}`)
    : null;
  const good =
    page.status === 200 &&
    html.includes("__BUS_TOKEN") &&
    asset !== null &&
    asset.status === 200 &&
    (await asset.text()).length > 1000;
  console.log(
    `${good ? "ok  " : "FAIL"} the compiled binary serves the dashboard from inside itself — ${
      assetPath ?? "no asset referenced"
    }`,
  );
  if (!good) process.exit(1);
} finally {
  bus.kill("SIGTERM");
  await bus.exited;
  await Bun.$`rm -rf ${scratch}`.quiet().nothrow();
}

console.log("\ncompiled-binary end-to-end passed");
