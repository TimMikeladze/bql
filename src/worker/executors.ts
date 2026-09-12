import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Claim, Completion } from "../shared/protocol";

type Progress = (
  type: "tool.started" | "tool.completed" | "agent.output",
  data: Record<string, unknown>,
) => Promise<void>;
const SOURCE = `export function slugify(text: string): string {
  return text.normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`;
const CASES = [
  ["Hello World", "hello-world"],
  ["  Hello, World!  ", "hello-world"],
  ["Crème brûlée", "creme-brulee"],
  ["a---b___c", "a-b-c"],
  ["", ""],
  ["  -- !! --  ", ""],
];

async function child(
  cmd: string[],
  cwd: string,
  prompt: string | undefined,
  signal: AbortSignal,
  timeoutMs = 180_000,
  environment: Record<string, string | undefined> = process.env,
) {
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  const proc = Bun.spawn(cmd, {
    cwd,
    detached: process.platform !== "win32",
    stdin: prompt === undefined ? "ignore" : new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...environment, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  let killed = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32") process.kill(-proc.pid, signal);
      else {
        Bun.spawn(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        });
      }
    } catch {}
  };
  const kill = () => {
    killed = true;
    signalGroup("SIGTERM");
    hardKill = setTimeout(() => signalGroup("SIGKILL"), 1000);
  };
  combined.addEventListener("abort", kill, { once: true });
  if (combined.aborted) kill();
  const timer = setTimeout(
    () => local.abort("Execution deadline exceeded"),
    timeoutMs,
  );
  async function read(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let result = "";
    for await (const chunk of stream) {
      result += decoder.decode(chunk, { stream: true });
      if (result.length > 1_000_000) {
        local.abort("Output limit exceeded");
        throw new Error("Provider output exceeded 1 MB");
      }
    }
    return result + decoder.decode();
  }
  try {
    const [stdout, stderr, exit] = await Promise.all([
      read(proc.stdout),
      read(proc.stderr),
      proc.exited,
    ]);
    if (killed)
      throw new Error(String(combined.reason ?? "Execution cancelled"));
    return { stdout, stderr, exit };
  } finally {
    clearTimeout(timer);
    if (hardKill) clearTimeout(hardKill);
    combined.removeEventListener("abort", kill);
    signalGroup("SIGKILL");
  }
}
function parseObject(text: string): Record<string, unknown> {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  return JSON.parse(clean);
}

export async function execute(
  claim: Claim,
  progress: Progress,
  signal: AbortSignal,
  delay = 1200,
): Promise<Omit<Completion, "generation">> {
  const { task, run, artifact } = claim;
  const dir = await mkdtemp(`${tmpdir()}/agenticbus-prototype-`);
  const observe: Progress = async (type, data) => {
    try {
      await progress(type, data);
    } catch {
      signal.throwIfAborted(); /* Observation loss must not discard a completed computation. */
    }
  };
  try {
    if (delay) await Bun.sleep(delay);
    signal.throwIfAborted();
    if (task.role === "creator") {
      await observe("tool.started", {
        tool: run.mode === "demo" ? "scripted.create" : "claude.print",
        description: "Create a TypeScript slug utility",
      });
      let code = SOURCE;
      if (run.mode === "live") {
        const schema = {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        };
        const result = await child(
          [
            process.env.CLAUDE_BIN ?? "claude",
            "-p",
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--disable-slash-commands",
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--max-budget-usd",
            "1",
            "--json-schema",
            JSON.stringify(schema),
          ],
          dir,
          `Generate a self-contained TypeScript module. No imports, side effects, or filesystem access. Export slugify(text: string): string. Requirements: ${run.brief}\nReturn a JSON object with code containing only source code.`,
          signal,
        );
        if (result.exit !== 0)
          throw new Error(
            `Claude exited ${result.exit}: ${(result.stderr || result.stdout).slice(-2500)}`,
          );
        const envelope = parseObject(result.stdout);
        if (envelope.is_error)
          throw new Error(
            `Claude: ${String(envelope.result ?? envelope.subtype)}`,
          );
        const payload =
          envelope.structured_output ??
          parseObject(String(envelope.result ?? "{}"));
        code = String((payload as Record<string, unknown>).code ?? "");
        if (!code.includes("slugify"))
          throw new Error("Claude did not return the required source artifact");
        await observe("agent.output", {
          provider: "claude",
          sessionId: envelope.session_id,
          usage: envelope.usage,
          costUsd: envelope.total_cost_usd,
        });
      }
      await observe("tool.completed", {
        tool: "artifact.create",
        name: "slugify.ts",
        bytes: code.length,
      });
      return {
        ok: true,
        name: "slugify.ts",
        mediaType: "text/typescript",
        content: code,
      };
    }
    if (!artifact) throw new Error("Task is missing its input artifact");
    if (task.role === "reviewer") {
      await observe("tool.started", {
        tool: run.mode === "demo" ? "scripted.review" : "codex.exec",
        artifactId: artifact.id,
      });
      let report = {
        verdict: "approved",
        summary:
          "The implementation handles whitespace, accents, punctuation, and empty input. Pure function with no dependencies.",
        findings: [] as string[],
        provider: "scripted demo",
        inputDigest: artifact.digest,
      };
      if (run.mode === "live") {
        const schema = {
          type: "object",
          properties: {
            verdict: {
              type: "string",
              enum: ["approved", "changes_requested"],
            },
            summary: { type: "string" },
            findings: { type: "array", items: { type: "string" } },
          },
          required: ["verdict", "summary", "findings"],
          additionalProperties: false,
        };
        await Bun.write(`${dir}/review.schema.json`, JSON.stringify(schema));
        const result = await child(
          [
            process.env.CODEX_BIN ?? "codex",
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--json",
            "--output-schema",
            `${dir}/review.schema.json`,
            "-",
          ],
          dir,
          `Review the following TypeScript utility against these requirements: ${run.brief}\nDo not use tools. Return only your structured review.\nSource:\n${artifact.content}`,
          signal,
        );
        if (result.exit !== 0)
          throw new Error(
            `Codex exited ${result.exit}: ${(result.stderr || result.stdout).slice(-2500)}`,
          );
        const events = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const last = events
          .filter(
            (e) =>
              e.type === "item.completed" && e.item?.type === "agent_message",
          )
          .at(-1);
        if (!last?.item?.text)
          throw new Error("Codex returned no completed review message");
        const parsed = parseObject(last.item.text);
        if (
          !["approved", "changes_requested"].includes(String(parsed.verdict)) ||
          typeof parsed.summary !== "string" ||
          !Array.isArray(parsed.findings)
        )
          throw new Error("Invalid Codex review shape");
        report = {
          verdict: String(parsed.verdict),
          summary: parsed.summary,
          findings: parsed.findings.map(String),
          provider: "codex",
          inputDigest: artifact.digest,
        };
        await observe("agent.output", {
          provider: "codex",
          usage: events.find((e) => e.type === "turn.completed")?.usage,
        });
      }
      await observe("tool.completed", {
        tool: "code.review",
        verdict: report.verdict,
        artifactId: artifact.id,
      });
      return {
        ok: report.verdict === "approved",
        name: "review.json",
        mediaType: "application/json",
        content: JSON.stringify(report, null, 2),
        ...(report.verdict !== "approved"
          ? { error: "Reviewer requested changes" }
          : {}),
      };
    }
    await observe("tool.started", {
      tool: "bun.test",
      artifactId: artifact.id,
      cases: CASES.length,
    });
    await Bun.write(`${dir}/slugify.ts`, artifact.content);
    await Bun.write(
      `${dir}/slugify.test.ts`,
      `import { test, expect } from "bun:test";\nimport {slugify} from "./slugify";\n${CASES.map(([input, expected], i) => `test(${JSON.stringify(`case ${i + 1}: ${input || "empty input"}`)},()=>expect(slugify(${JSON.stringify(input)})).toBe(${JSON.stringify(expected)}));`).join("\n")}`,
    );
    const result = await child(
      [process.execPath, "test", "./slugify.test.ts"],
      dir,
      undefined,
      signal,
      15_000,
      { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    );
    await observe("tool.completed", {
      tool: "bun.test",
      exitCode: result.exit,
      cases: CASES.length,
      artifactId: artifact.id,
    });
    return {
      ok: result.exit === 0,
      name: "test-results.txt",
      mediaType: "text/plain",
      content: `Input SHA-256: ${artifact.digest}\n\n${result.stdout}\n${result.stderr}`,
      ...(result.exit !== 0
        ? { error: "Artifact failed executable tests" }
        : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
