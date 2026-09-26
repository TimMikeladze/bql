/**
 * Local development: the bus, three example consumers, and the dashboard.
 *
 * The consumers are separate OS processes talking HTTP, which is the only shape
 * the bus supports — there is no in-process shortcut here to be misled by.
 */
import { mkdir } from "node:fs/promises";
import { generateKey, mint } from "../src/bus/tokens";
import { BusClient } from "../src/client/bus";

const state = ".bql-bus";
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
const vitePort = await freePort(Number(process.env.VITE_PORT ?? 5173));
const url = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  BUS_SIGNING_KEY: signingKey,
  BUS_ADMIN_TOKEN: adminToken,
  BUS_URL: url,
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

const bus = spawn([
  "src/cli/index.ts",
  "serve",
  "--port",
  String(port),
  "--assets",
  "dist/dashboard",
]);

let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (bus.exitCode !== null) break;
  try {
    if ((await fetch(`${url}/health`)).ok) {
      ready = true;
      break;
    }
  } catch {}
  await Bun.sleep(150);
}

if (!ready) {
  console.error(`The bus did not start. Check that port ${port} is free.`);
  stop();
} else {
  const admin = new BusClient({ url, token: adminToken });
  await admin.subscribe({ name: "work", pattern: "work.>", ackWaitMs: 15_000 });
  await admin.subscribe({ name: "rpc", pattern: "rpc.>", ackWaitMs: 15_000 });
  // A second subscription on the same subjects, to show fan-out: `audit` sees
  // everything `work` sees, and its own cursor means neither steals from the
  // other.
  await admin.subscribe({ name: "audit", pattern: ">", ackWaitMs: 15_000 });

  for (const [id, subscription] of [
    ["worker-a", "work"],
    ["worker-b", "work"],
    ["responder", "rpc"],
  ] as const) {
    const token = mint(
      {
        sub: id,
        scope: "consumer",
        workspace: "default",
        publish: ["reply", "results.>"],
        subscribe: [subscription],
        exp: 0,
      },
      signingKey,
    );
    spawn(["examples/consumer.ts", "--id", id, "--subscription", subscription], {
      BUS_TOKEN: token,
    });
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
    { VITE_PORT: String(vitePort) },
  );

  console.log(`
bql.sh/bus dev
  dashboard   http://127.0.0.1:${vitePort}
  bus         ${url}
  consumers   worker-a, worker-b (work) · responder (rpc)

  publish   bun src/cli/index.ts publish work.slow '{"ms":2000}'
  request   bun src/cli/index.ts request rpc.upper '"hello"'
  tail      bun src/cli/index.ts tail --after 0
  stats     bun src/cli/index.ts stats
`);
  await Promise.race(children.map((child) => child.exited));
  if (!closing) {
    console.error("A process exited; stopping the rest.");
    stop();
  }
}
