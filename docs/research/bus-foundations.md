# Bus foundations: primary-source research

Checked 2026-09-11. These are documented capabilities, followed by design implications. Agent-specific findings are in [agent-integrations.md](agent-integrations.md). No throughput benchmark or live cross-provider integration was run.

| Source | Documented fact | Implication for this design |
| --- | --- | --- |
| [Bun SQLite](https://bun.com/docs/runtime/sqlite) | `bun:sqlite` provides a synchronous SQLite API, prepared statements, and transactions. | A small coordinator can atomically record accepted events, work state, and delivery intent. Keep transactions short and isolate storage from latency-sensitive hook handling. |
| [Bun subprocesses](https://bun.com/docs/runtime/child-process) | `Bun.spawn` accepts argument arrays and exposes subprocess streams. | Run CLI adapters without constructing shell strings; parse bounded streaming frames and drain stderr separately. |
| [Bun HTTP server](https://bun.com/docs/runtime/http/server) | `Bun.serve` provides HTTP serving and streaming responses. | Use HTTP for commands and acknowledgements, SSE for observation, and long polling for worker claims. |
| [SQLite WAL](https://sqlite.org/wal.html) | WAL requires same-host shared memory, permits one writer at a time, and `synchronous=FULL` syncs at commit; `NORMAL` weakens power-loss durability. | Keep the DB on coordinator-local disk. Remote workers call the coordinator API. WAL is not replication. Use FULL for durable acceptance, subject to the underlying disk honoring sync. |
| [CloudEvents 1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) | Required attributes include `id`, `source`, `specversion`, and `type`. Identity is the pair `source` + `id`; extension names use lowercase ASCII letters/digits. | Adopt the JSON envelope for facts; define our own explicit task and decision contracts. The envelope does not supply queue semantics. |
| [NATS JetStream](https://docs.nats.io/concepts/jetstream) | Core NATS is transient, at-most-once delivery; JetStream adds persistence, replay, and at-least-once delivery. | JetStream is a candidate for replicated event transport later. Business effects still require their own idempotency and state authority. |
| [JetStream pull consumers](https://docs.nats.io/learn/jetstream/pull-consumers) | Workers can pull bounded batches and acknowledge successful processing. | Prefer worker demand and explicit credit to unbounded push into expensive agents. |
| [A2A specification](https://a2a-protocol.org/latest/specification/) | The fetched page identifies release 1.0.0 and defines discovery, tasks, messages, artifacts, and streaming across independent agents. | Offer A2A through a gateway, with explicit mappings and version negotiation. It need not dictate internal scheduling or durability. |
| [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28) and [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview) | MCP exposes tools/resources/prompts. Its Tasks extension supports durable handles, polling, input, and cooperative cancellation, with explicit client/server support. | Expose bus operations as MCP tools and map task handles where negotiated. Do not describe MCP as only synchronous or assume every host supports Tasks. |
| [W3C Trace Context](https://www.w3.org/TR/trace-context/) | Defines interoperable trace context propagation. | Carry `traceparent` when available; retain explicit task/causation identity independently of tracing. |

## Recommendation derived from the sources

Start with one Bun coordinator and its local SQLite database, local/remote worker runners, and a language-neutral HTTP/JSON contract. Separate durable observations, leased work, and deadline-bound decisions. Keep provider translation in adapters. Support a laptop deployment and a server deployment with authenticated remote workers from the first release.

This is an engineering recommendation, not a performance claim from the sources. A replicated broker is useful when coordinator downtime, storage growth, or measured load justifies its operating cost. Adding it must include a task-state migration; a transport swap alone cannot remove a single state authority.
