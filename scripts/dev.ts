import { mkdir } from "node:fs/promises";
await mkdir(".prototype", { recursive: true });
const tokenFile = Bun.file(".prototype/worker-token");
const token =
  process.env.BUS_TOKEN ??
  ((await tokenFile.exists())
    ? (await tokenFile.text()).trim()
    : crypto.randomUUID());
if (!(await tokenFile.exists()))
  await Bun.write(tokenFile, token, { mode: 0o600 });
const env = { ...process.env, BUS_TOKEN: token };
const children: ReturnType<typeof Bun.spawn>[] = [];
const spawn = (args: string[]) => {
  const p = Bun.spawn([process.execPath, ...args], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(p);
  return p;
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
const server = spawn(["src/server/server.ts"]);
let ready = false;
for (let i = 0; i < 50; i++) {
  if (server.exitCode !== null) break;
  try {
    if ((await fetch("http://127.0.0.1:4317/health")).ok) {
      ready = true;
      break;
    }
  } catch {}
  await Bun.sleep(100);
}
if (!ready) {
  console.error(
    "Coordinator did not start. Check that port 4317 is available.",
  );
  stop();
} else {
  for (const mode of ["demo", "live"])
    for (const role of ["creator", "reviewer", "tester"])
      spawn([
        "src/worker/runner.ts",
        "--role",
        role,
        "--mode",
        mode,
        "--id",
        `local-${mode}-${role}`,
      ]);
  spawn(["--bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1"]);
  console.log(
    "\nAgenticBus prototype: http://localhost:5173\nDemo workers are scripted; live runs invoke your installed Claude/Codex CLIs.\n",
  );
  await Promise.race(children.map((p) => p.exited));
  if (!closing) {
    console.error(
      "A prototype process exited; stopping the remaining processes.",
    );
    stop();
  }
}
