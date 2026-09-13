/**
 * Local development: the engine host, two remote workers, and the dashboard.
 *
 * The workers are separate OS processes talking HTTP, exactly as they would be
 * on another machine — the only thing loopback changes is the latency.
 */
import { mkdir } from "node:fs/promises";
import { generateKey, mint } from "../src/broker";

const state = ".agenticbus";
await mkdir(state, { recursive: true });

const read = async (path: string) => {
  const file = Bun.file(path);
  if (await file.exists()) return (await file.text()).trim();
  const value = generateKey();
  await Bun.write(file, value, { mode: 0o600 });
  return value;
};
const signingKey = await read(`${state}/signing-key`);
const adminToken = await read(`${state}/admin-token`);

/** Never take a port another app is holding — walk forward to a free one. */
async function freePort(start: number): Promise<number> {
  for (let candidate = start; candidate < start + 50; candidate++) {
    try {
      const probe = Bun.listen({
        hostname: "127.0.0.1",
        port: candidate,
        socket: { data() {} },
      });
      probe.stop(true);
      return candidate;
    } catch {}
  }
  throw new Error(`no free port in ${start}..${start + 50}`);
}

const port = await freePort(Number(process.env.PORT ?? 4317));
const enginePort = await freePort(port + 1);
const vitePort = await freePort(Number(process.env.VITE_PORT ?? 5173));
const env = {
  ...process.env,
  BUS_SIGNING_KEY: signingKey,
  BUS_ADMIN_TOKEN: adminToken,
  // The dev server's config imports the token minter from source, which Vite's
  // native config loader warns about. The import is deliberate.
  VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
};
const children: ReturnType<typeof Bun.spawn>[] = [];
const spawn = (args: string[], extra: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, ...args], {
    env: { ...env, ...extra },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  return child;
};

let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(0);
  }, 1500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const host = spawn([
  "src/cli/index.ts",
  "serve",
  "--port",
  String(port),
  "--engine-port",
  String(enginePort),
  "--workflows",
  "./workflows",
  "--assets",
  "dist",
]);

let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (host.exitCode !== null) break;
  try {
    if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
      ready = true;
      break;
    }
  } catch {}
  await Bun.sleep(150);
}

if (!ready) {
  console.error(
    `The engine host did not start. Check that port ${port} is free, or set PORT.`,
  );
  stop();
} else {
  for (const id of ["worker-a", "worker-b"]) {
    const token = mint(
      { sub: id, scope: "worker", runtimes: ["bun", "http"], labels: { pool: "general" }, exp: 0 },
      signingKey,
    );
    spawn(
      [
        "src/cli/index.ts",
        "worker",
        "--id",
        id,
        "--broker",
        `http://127.0.0.1:${port}`,
        "--runtimes",
        "bun,http",
        "--labels",
        "pool=general",
        "--jobs",
        "./jobs",
      ],
      { BUS_TOKEN: token },
    );
  }
  spawn(
    [
      "--bun",
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
    ],
    { BUS_URL: `http://127.0.0.1:${port}`, VITE_PORT: String(vitePort) },
  );
  console.log(`
AgenticBus dev
  dashboard   http://127.0.0.1:${vitePort}
  broker      http://127.0.0.1:${port}
  engine      http://127.0.0.1:${enginePort}  (dagr control plane)
  workers     worker-a, worker-b  (runtimes bun,http · labels pool=general)

  Start a run:
    ENGINE_URL=http://127.0.0.1:${enginePort} bun scripts/run.ts remote-slug '{"text":"Crème brûlée"}'
`);
  await Promise.race(children.map((child) => child.exited));
  if (!closing) {
    console.error("A process exited; stopping the rest.");
    stop();
  }
}
