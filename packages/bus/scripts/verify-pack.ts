#!/usr/bin/env bun
/**
 * Pack, install into an empty directory, and use what comes out.
 *
 * A bundler can drop a module and still emit its name in the export list: the
 * result type-checks, passes the source-run test suite, and only fails on
 * `import` in someone else's install. So this is deliberately not a source
 * test — it builds the tarball, installs it somewhere with no relationship to
 * this repo, and then imports every advertised entry point, runs the binary,
 * and starts a real bus from the installed copy.
 *
 *   bun run verify-pack
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

const scratch = await mkdtemp(`${tmpdir()}/agenticbus-pack-`);
let packed = false;

try {
  const build = await run(["bun", "run", "build"], repo);
  check("the package builds", build.code === 0, build.err.slice(-400));
  if (build.code !== 0) throw new Error("build failed");

  // Rewrite the manifest to point at dist/ exactly as `npm publish` would,
  // and put it back whatever happens below.
  const prepack = await run(["bun", "scripts/prepack.ts"], repo);
  packed = prepack.code === 0;
  check("the manifest is rewritten for publishing", prepack.code === 0, prepack.err);

  const pack = await run(
    ["bun", "pm", "pack", "--destination", scratch, "--ignore-scripts"],
    repo,
  );
  check("bun pm pack produced a tarball", pack.code === 0, pack.err.slice(-400));

  const manifest = JSON.parse(await Bun.file(`${repo}/package.json`).text()) as {
    name: string;
    bin: Record<string, string>;
    exports: Record<string, unknown>;
  };
  check(
    "the published bin points into dist and has no leading './'",
    manifest.bin.agenticbus === "dist/cli/index.js",
    manifest.bin.agenticbus,
  );

  // Derived from the manifest rather than spelled out, because the two have already disagreed
  // once: a scoped name packs with the scope flattened into the filename, so `@bunql/bus`
  // produces `bunql-bus-*.tgz`. A hardcoded prefix turns a rename into a failure here instead
  // of into a failure where the rename was.
  const slug = manifest.name.replace(/^@/, "").replace(/\//g, "-");
  const tarball = (await Array.fromAsync(
    new Bun.Glob(`${slug}-*.tgz`).scan({ cwd: scratch, absolute: true }),
  ))[0];
  if (!tarball) throw new Error(`no ${slug}-*.tgz was produced in ${scratch}`);

  // ---- a clean install, in a directory that knows nothing about this repo ----
  const consumer = `${scratch}/consumer`;
  await Bun.write(
    `${consumer}/package.json`,
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
  );
  const install = await run(["bun", "add", tarball], consumer);
  check("bun add <tarball> installs", install.code === 0, install.err.slice(-500));

  await Bun.write(
    `${consumer}/use.ts`,
    `import { BusStore, createServer, generateKey, mint, prometheusMetrics, createLogger, SCHEMA_VERSION } from "${manifest.name}";
import { BusClient, BusConsumer, FatalError, CancelledError } from "${manifest.name}/client";

for (const [name, value] of Object.entries({ BusStore, createServer, generateKey, mint, prometheusMetrics, createLogger, BusClient, BusConsumer, FatalError, CancelledError }))
  if (value === undefined) throw new Error(\`missing export \${name}\`);
if (typeof SCHEMA_VERSION !== "number") throw new Error("SCHEMA_VERSION is not a number");

// Not just importable: actually usable. A bus, a subscription, a message and
// a consumer, from the installed package alone.
const signingKey = generateKey();
const adminToken = generateKey();
const store = new BusStore(":memory:");
const server = createServer({ store, signingKey, adminToken, port: 0, hostname: "127.0.0.1" });
const client = new BusClient({ url: \`http://127.0.0.1:\${server.port}\`, token: adminToken });
await client.subscribe({ name: "work", pattern: "work.>" });
const published = await client.publish({ subject: "work.hello", body: { from: "a clean install" } });
const [envelope] = await client.claim("work", "consumer-1", 1);
if (envelope?.message.seq !== published.seq) throw new Error("the claim did not return the message");
await client.ack(envelope.delivery, "consumer-1");
await server.shutdown();
store.close();
console.log("USABLE");
`,
  );
  const used = await run(["bun", "use.ts"], consumer);
  check(
    "every advertised export is real, and a bus runs from the install",
    used.code === 0 && used.out.includes("USABLE"),
    used.err.slice(-600),
  );

  const binary = await run(
    ["./node_modules/.bin/agenticbus", "help"],
    consumer,
  );
  check(
    "the installed binary runs",
    binary.code === 0 && binary.out.includes("agenticbus"),
    binary.err.slice(-300),
  );

  // The dashboard has to be in the tarball too, or `serve` has nothing to
  // serve and the 404 only shows up for someone who installed it.
  check(
    "the dashboard shipped with the package",
    await Bun.file(
      `${consumer}/node_modules/${manifest.name}/dist/dashboard/index.html`,
    ).exists(),
  );

  // The other artefact people receive. A tarball that installs proves nothing
  // about a binary nobody executed, and the two break in different places:
  // `--compile` is fussy about assets read from disk and dynamic imports of
  // computed paths, neither of which the npm path exercises.
  if (!process.env.SKIP_COMPILED) {
    const compiled = await run(["bun", "scripts/compiled-e2e.ts"], repo);
    check(
      "the compiled binary passes the end-to-end suite and serves its dashboard",
      compiled.code === 0,
      compiled.out.split("\n").slice(-3).join(" ") || compiled.err.slice(-300),
    );
  }
} catch (error) {
  check("verify-pack completed without an unexpected error", false, String(error));
} finally {
  if (packed) await run(["bun", "scripts/prepack.ts", "--restore"], repo);
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nthe published package installs and works");
