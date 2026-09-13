# Agent integration research

Checked 2026-09-11. Scope: local Claude Code/Codex sessions and authenticated workers on multiple machines. The facts below describe fetched official documentation; the adapter recommendations are our design proposals. No paid agent runs or SDK compatibility tests were performed.

## Local evidence and compatibility policy

Read-only commands found `codex-cli 0.154.0` at `/opt/homebrew/bin/codex` and Claude Code `2.1.269` at `/Users/tim/.local/bin/claude`. `codex exec --help` confirms JSONL output, resume/fork, output schemas, explicit sandbox selection, and hook trust controls. `codex app-server --help` labels the server experimental and exposes stdio, Unix socket, WebSocket, protocol generation, and WebSocket authentication flags. This establishes installed command surfaces, not successful authentication or hook execution.

**Proposed compatibility policy:** record executable version, adapter version, protocol version, and tested capabilities when a worker registers. Pin production versions and run adapter contract fixtures on upgrade. Treat unknown events as retained vendor extensions; reject unknown decision fields before returning them to a runtime. Do not infer feature availability from a shared hook name or from a package compiling under Bun.

## Codex native hooks: current facts

Codex now documents native lifecycle hooks, including `PreToolUse`, `PermissionRequest`, `PostToolUse`, session/subagent events, `Stop`, and `Interrupt`. Non-managed hooks require trust; matching commands run concurrently. Command hooks receive JSON on stdin. Synchronous `PreToolUse` can deny or rewrite supported calls. However, `permissionDecision: "ask"` is unsupported: it fails the hook and the call continues. Hosted tools and specialized paths can bypass hooks; `write_stdin` does not repeat prechecks. `PermissionRequest` only fires where approval is needed. Post-tool handling cannot undo effects. [Official Codex hooks reference](https://learn.chatgpt.com/docs/hooks)

Async hooks cannot block, approve, or rewrite. Their informational output is delivered at a safe point; completion does not start an idle turn. Up to eight run concurrently, completion order can differ, and session teardown cancels unfinished work. `SessionEnd` stays synchronous. Transcript format is unstable, and `main` schemas may exceed released behavior. These hooks are useful guardrails, not a complete enforcement boundary. [Official Codex hooks reference](https://learn.chatgpt.com/docs/hooks)

**Design consequence:** implement a dedicated Codex decision translator. Never forward Claude output JSON directly. Authoritative restrictions must also live in the tool executor, sandbox, or external service.

## Codex app-server: control and observation

App-server offers bidirectional JSON-RPC-style messages, omitting the `jsonrpc` field. Default stdio uses JSONL. Initialize the connection before other requests. Thread/turn APIs start and resume work; `turn/steer` appends input to an active turn and requires matching `expectedTurnId`. It fails without an active turn. `turn/interrupt` requests cancellation; subsequent terminal status establishes the outcome. Notifications report item progress and message deltas. Approval requests are server-to-client requests correlated with thread, turn, and item identifiers. They are distinct from notifications. [Official app-server reference](https://learn.chatgpt.com/docs/app-server)

Generate TypeScript/JSON schemas with the installed binary to match its version. WebSocket transport is explicitly experimental and unsupported; non-loopback listeners can allow unauthenticated access unless authentication is configured. [Official app-server reference](https://learn.chatgpt.com/docs/app-server)

**Proposed default:** each worker owns its local stdio app-server process. Runners initiate outbound HTTPS requests to our authenticated coordinator API to claim work and report outcomes. Separate `submit`, `steer`, `interrupt`, and `answerApproval` capabilities. A successful RPC response means the command was accepted, not that a task finished. Keep pending approval replies bound to their original connection and request identity.

## Codex exec and SDK: useful alternatives

`codex exec --json` emits `thread.started`, turn lifecycle events, item events, and errors. Items include command execution, file changes, MCP calls, and messages. `--output-schema` constrains the final response; it does not describe every intermediate event. `exec` supports explicitly configured sandbox/approval behavior and is intended for scripts and CI. [Official non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode)

The TypeScript Codex SDK starts, continues, and resumes local threads; its documentation requires server-side Node.js 18+. The documentation recommends app-server for clients needing approvals, history, authentication, and streamed events. It also states that `codex mcp-server` and its standalone binary were removed. [Official Codex SDK guide](https://learn.chatgpt.com/docs/codex-sdk)

**Proposed use:** use exec for finite queued jobs and subprocess isolation. Consuming stdout alone is observation, not a synchronous veto channel. Native configured hooks are a separate integration. Use direct app-server framing from Bun for richer control; keep an SDK option behind compatibility tests or a Node sidecar if needed. Do not make an unverified claim that the SDK officially supports Bun.

## Claude Code hooks: current facts

Claude supports command, HTTP, MCP, prompt, and agent hooks. Command input arrives on stdin; HTTP input arrives in the POST body. Events span sessions, turns, and tool calls; `EndConversation` skips pre/post tool hooks. Synchronous pre-tool decisions can affect execution. Async command hooks cannot veto or control the triggering operation. Ordinarily their context arrives on the next conversation turn; `asyncRewake` has separate wake behavior. Ordinary async hooks do not retain timeout enforcement once running, and non-interactive teardown kills unfinished async hooks. Command hooks execute with the user's permissions. [Claude hooks reference](https://code.claude.com/docs/en/hooks)

**Proposed use:** a short synchronous hook submits an observation to a local durable spool and returns quickly. If policy is required, use a separate deadline-bounded local decision path. Upload telemetry from the spool independently of session lifetime. Never hold a shell hook open while a remote research agent thinks; remote decisions belong to explicit approval/task state.

## Claude Agent SDK and CLI control

SDK hook callbacks receive typed input, a tool-use correlation ID, and TypeScript cancellation context. Hooks return event-specific JSON. Pre-tool decisions include allow, deny, ask, and defer; defer ends the query for later resumption. Post-tool callbacks can replace tool output through `updatedToolOutput`. Event availability differs between Python and TypeScript, and newer fields have explicit minimum versions. Async callback output is for effects that need not influence the agent. [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

Streaming input supports persistent sessions, queued messages, interruptions, streamed feedback, and permissions. Single-message mode lacks dynamic queueing and realtime interruption. [SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

`claude -p` runs non-interactively; CLI supports structured output and continuation. SIGTERM leaves an unfinished turn; SIGINT or SDK `interrupt()` ends the turn before process shutdown. Bare mode skips automatic hook/plugin/context discovery, so wrappers must explicitly choose their configuration behavior. [Programmatic CLI guide](https://code.claude.com/docs/en/headless)

The Agent SDK runs Claude Code's loop and differs from the direct Anthropic API SDK, where callers implement their own loop. Third-party products should use the documented API authentication route rather than assume users' subscription login is available to embed. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

**Proposed default:** use SDK streaming mode for bus-owned Claude sessions; expose queue and interrupt capabilities independently. Begin with hook ingestion for existing interactive sessions. Persist bus task IDs separately from vendor session IDs.

## Optional Claude push integration

Channels push events from MCP servers into running Claude sessions and may support replies through channel tools. They are research preview, require Anthropic authentication, and have organization enablement restrictions; events arrive only while the session is open. Prebuilt channel plugins use Bun. [Claude channels guide](https://code.claude.com/docs/en/channels)

**Proposed use:** an optional channel adapter can connect the bus to a user's open terminal session. It is not the durable mailbox: our bus retains delivery state while the session is unavailable. Ordinary MCP tool access should not be advertised as equivalent to channel push support.

## Proposed cross-runtime contract

Keep these capabilities separate rather than promise identical agent behavior:

| Capability | Meaning in our contract |
| --- | --- |
| Observe | Normalize a reported fact; preserve original runtime payload and IDs |
| Submit | Start or enqueue new work with a stable command ID |
| Steer | Add input during an active turn only when the adapter supports it |
| Interrupt | Request cancellation; await terminal evidence |
| Decide | Answer a live, correlated policy/approval request before its deadline |
| Deliver | Present a durable message; distinguish presentation from completion |

For local and remote workers alike, use an inbox/outbox around vendor I/O. Commit coordinator events to local SQLite before acknowledging them; remote workers retry with the same IDs. Never place that database on a shared network filesystem. A network timeout means outcome unknown, so reconcile task/session state before launching replacement work. Tool side effects require their own idempotency or explicit reconciliation; replaying a tool event must not re-execute the tool.

The initial contract tests should cover split JSONL frames, process exit without a final event, unknown vendor events, duplicate deliveries, late approval replies, interrupted turns, and a coordinator outage during hook ingestion. These are proposed verification requirements, not claims of tests already run.
