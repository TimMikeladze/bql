import {
  resolveContext,
  type ResolveOptions,
} from "../../../db/src/context/index.ts";
import { validateHttpCredential } from "../../../db/src/context/model.ts";
import { cliFetch } from "../../../db/src/cli/transport.ts";
import type { ClientOptions } from "../client/bus";
/** Share workstation selection without importing the executable database CLI. */
export async function resolveBusConnection(options: {
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  legacyToken: () => Promise<string>;
  url?: string;
}): Promise<ClientOptions> {
  const flag = (name: string) => {
    for (let i = 0; i < options.argv.length; i++) {
      const arg = options.argv[i]!;
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      if (arg === `--${name}`) {
        const value = options.argv[i + 1];
        if (!value || value.startsWith("--"))
          throw new Error(`--${name} needs a value`);
        return value;
      }
    }
    return undefined;
  };
  const input: ResolveOptions = {
    service: "bus",
    env: options.env,
    cwd: flag("cwd") ?? options.cwd,
    configDir: flag("config-dir"),
    org: flag("org"),
    project: flag("project"),
    endpoint: flag("endpoint"),
    url: options.url ?? flag("url"),
    token: flag("token"),
    vercelBypass: flag("vercel-bypass"),
  };
  const context = await resolveContext(input);
  const token =
    context.token ??
    (context.mode === "named" ? "" : await options.legacyToken());
  validateHttpCredential(token);
  const fetchImpl: typeof fetch = Object.assign(
    (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(context.headers))
        headers.set(key, value);
      return cliFetch(url, { ...init, headers });
    },
    { preconnect: fetch.preconnect },
  );
  return { url: context.url, token, fetchImpl };
}
