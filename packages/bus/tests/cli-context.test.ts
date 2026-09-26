import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContextStore } from "../../db/src/context/store.ts";
import { createServer } from "../src/bus/server";
import { BusStore } from "../src/bus/store";
import { generateKey } from "../src/bus/tokens";
const CLI = resolve(import.meta.dir, "../../db/src/cli.ts"),
  dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "bql-bus-context-"));
  dirs.push(cwd);
  const configDir = join(cwd, "config");
  return {
    cwd,
    configDir,
    async run(args: string[], extra: Record<string, string> = {}) {
      const child = Bun.spawn(
        ["bun", CLI, "bus", ...args, "--config-dir", configDir],
        {
          cwd,
          env: {
            ...process.env,
            BQL_URL: "",
            BQL_TOKEN: "",
            BQL_ORG: "",
            BQL_PROJECT: "",
            BQL_ENDPOINT: "",
            BUS_URL: "",
            BUS_TOKEN: "",
            ...extra,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, out, err };
    },
  };
}
test("bus commands use endpoint-specific bus auth and bypass; legacy direct mode still works", async () => {
  const f = await fixture(),
    store = new BusStore(":memory:"),
    key = generateKey(),
    server = createServer({
      store,
      signingKey: generateKey(),
      adminToken: key,
      port: 0,
      hostname: "127.0.0.1",
    });
  let hits = 0;
  const proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      hits++;
      if (req.headers.get("x-vercel-protection-bypass") !== "bypass")
        return Response.json({ error: "protected" }, { status: 401 });
      return fetch(
        `http://127.0.0.1:${server.port}${new URL(req.url).pathname}`,
        {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" ? undefined : await req.text(),
        },
      );
    },
  });
  try {
    await new ContextStore(f.configDir).mutate((r, c) => {
      r.organizations = [
        {
          id: "o",
          name: "personal",
          projects: [
            {
              id: "p",
              name: "app",
              defaultEndpoint: "e",
              endpoints: [
                {
                  id: "e",
                  name: "preview",
                  database: { url: "https://db.example", token: { key: "db" } },
                  bus: {
                    url: proxy.url.toString(),
                    token: { key: "bus" },
                    bypass: { key: "bypass" },
                  },
                },
                {
                  id: "db-only",
                  name: "database-only",
                  database: { url: "https://db.example" },
                },
              ],
            },
          ],
        },
      ];
      r.selection = { org: "o", project: "p" };
      c.db = "wrong-database-key";
      c.bus = key;
      c.bypass = "bypass";
    });
    const published = await f.run([
      "publish",
      "work.test",
      '{"ok":true}',
      "--endpoint",
      "preview",
    ]);
    expect(published.err).toBe("");
    expect(published.code).toBe(0);
    expect(store.lastSeq()).toBe(1);
    expect(hits).toBe(1);
    expect((await f.run(["stats", "--endpoint", "database-only"])).code).toBe(
      1,
    );
    await expect(
      access(join(f.cwd, ".bql-bus", "admin-token")),
    ).rejects.toThrow();
    expect(
      (
        await f.run(["publish", "legacy.test", "null"], {
          BUS_URL: `http://127.0.0.1:${server.port}`,
          BUS_TOKEN: key,
        })
      ).code,
    ).toBe(0);
    expect(store.lastSeq()).toBe(2);
  } finally {
    proxy.stop(true);
    server.stop(true);
    store.close();
  }
});
test("consumer requests and follower replication share selected protected bus transport", async () => {
  const f = await fixture(),
    store = new BusStore(":memory:"),
    key = generateKey(),
    server = createServer({
      store,
      signingKey: generateKey(),
      adminToken: key,
      port: 0,
      hostname: "127.0.0.1",
    });
  const proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("x-vercel-protection-bypass") !== "bypass")
        return Response.json({ error: "protected" }, { status: 401 });
      return fetch(
        `http://127.0.0.1:${server.port}${new URL(req.url).pathname}${new URL(req.url).search}`,
        {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" ? undefined : await req.text(),
        },
      );
    },
  });
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  const start = (args: string[]) => {
    const p = Bun.spawn(
      [
        "bun",
        CLI,
        "bus",
        ...args,
        "--config-dir",
        f.configDir,
        "--endpoint",
        "preview",
      ],
      {
        cwd: f.cwd,
        env: {
          ...process.env,
          BQL_ORG: "",
          BQL_PROJECT: "",
          BQL_ENDPOINT: "",
          BUS_URL: "",
          BUS_TOKEN: "",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    processes.push(p);
    return p;
  };
  try {
    await new ContextStore(f.configDir).mutate((r, c) => {
      r.organizations = [
        {
          id: "o",
          name: "org",
          projects: [
            {
              id: "p",
              name: "app",
              defaultEndpoint: "e",
              endpoints: [
                {
                  id: "e",
                  name: "preview",
                  database: { url: "https://db.example" },
                  bus: {
                    url: proxy.url.toString(),
                    token: { key: "bus" },
                    bypass: { key: "bypass" },
                  },
                },
              ],
            },
          ],
        },
      ];
      r.selection = { org: "o", project: "p" };
      c.bus = key;
      c.bypass = "bypass";
    });
    expect(
      (await f.run(["subscribe", "rpc", "rpc.>", "--endpoint", "preview"]))
        .code,
    ).toBe(0);
    const consumer = start([
      "consume",
      "rpc",
      "--exec",
      `printf '{"answer":42}'`,
    ]);
    const reply = await f.run([
      "request",
      "rpc.test",
      "null",
      "--wait",
      "2000",
      "--endpoint",
      "preview",
    ]);
    expect(reply.err).toBe("");
    expect(reply.code).toBe(0);
    expect(JSON.parse(reply.out)).toEqual({ answer: 42 });
    expect(consumer.exitCode).toBeNull();
    const replicaDir = join(f.cwd, "replica"),
      follower = start(["follow", "--data", replicaDir, "--idle-ms", "20"]);
    const deadline = Date.now() + 3000;
    let replicated = 0;
    while (Date.now() < deadline) {
      try {
        await access(join(replicaDir, "bus.db"));
        const replica = new BusStore(join(replicaDir, "bus.db"));
        replicated = replica.lastSeq();
        replica.close();
        if (replicated >= store.lastSeq()) break;
      } catch {}
      await Bun.sleep(30);
    }
    expect(follower.exitCode).toBeNull();
    expect(replicated).toBeGreaterThanOrEqual(store.lastSeq());
    expect(replicated).toBeGreaterThan(0);
  } finally {
    for (const p of processes) p.kill();
    await Promise.all(processes.map((p) => p.exited));
    proxy.stop(true);
    server.stop(true);
    store.close();
  }
}, 10000);

test("bus redirects fail without forwarding credentials to another server", async () => {
  const f = await fixture();
  let hits = 0;
  const destination = Bun.serve({
    port: 0,
    fetch() {
      hits++;
      return Response.json({});
    },
  });
  const redirect = Bun.serve({
    port: 0,
    fetch() {
      return Response.redirect(destination.url.toString(), 307);
    },
  });
  try {
    const result = await f.run(["stats"], {
      BUS_URL: redirect.url.toString(),
      BUS_TOKEN: "private",
      BUS_VERCEL_BYPASS: "private-bypass",
    });
    expect(result.code).toBe(1);
    expect(hits).toBe(0);
  } finally {
    redirect.stop(true);
    destination.stop(true);
  }
});

test("local key management does not require a valid remote registry", async () => {
  const f = await fixture();
  await Bun.write(join(f.configDir, "config.json"), "broken json");
  const result = await f.run(["keys", "list"], { BQL_ORG: "missing" });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).active).toBe("k1");
});
