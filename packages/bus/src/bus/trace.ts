/**
 * W3C trace context, and an OTLP/HTTP exporter, in one file.
 *
 * The OpenTelemetry SDK is a large dependency tree for what this actually
 * needs: parse a `traceparent`, mint a child of it, and POST spans as JSON.
 * The wire format is a public specification, `fetch` is built in, and the bus
 * ships as one binary with no runtime dependencies — so it is written here.
 *
 * What it buys: a message that crosses three consumers is **one** trace rather
 * than three unrelated ones. The trace id travels in the message headers, which
 * is the only place that survives a queue.
 */

const HEX = "0123456789abcdef";

function randomHex(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (const byte of buffer) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

export const newTraceId = () => randomHex(16);
export const newSpanId = () => randomHex(8);

export interface TraceContext {
  traceId: string;
  spanId: string;
  /** `01` means sampled. Propagated verbatim; this bus does not re-sample. */
  flags: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(value: string | undefined): TraceContext | null {
  if (!value) return null;
  const match = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!match) return null;
  // All-zero ids are explicitly invalid in the spec, and treating them as
  // valid is how a whole trace ends up collapsed onto one nonexistent parent.
  if (/^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return { traceId: match[1]!, spanId: match[2]!, flags: match[3]! };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

/** A new span in the same trace, or a brand new trace if there was none. */
export function childOf(parent: TraceContext | null): TraceContext {
  return {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    flags: parent?.flags ?? "01",
  };
}

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  /** Epoch milliseconds; converted to nanoseconds on the wire. */
  startMs: number;
  endMs: number;
  attributes: Record<string, string | number | boolean>;
  error?: string;
}

export interface SpanExporter {
  record(span: SpanData): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function noopExporter(): SpanExporter {
  return {
    record: () => {},
    flush: async () => {},
    shutdown: async () => {},
  };
}

const KIND: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

function attributes(values: Record<string, string | number | boolean>) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value },
  }));
}

export interface OtlpOptions {
  /** Collector base URL. `/v1/traces` is appended if it is not already there. */
  endpoint: string;
  serviceName?: string;
  headers?: Record<string, string>;
  /** Spans buffered before a flush is forced. */
  maxBatch?: number;
  /** How often a partial batch is sent anyway. */
  flushMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
}

/**
 * Batching OTLP/HTTP JSON exporter.
 *
 * Fire-and-forget on purpose: tracing must never be able to fail a publish. A
 * collector that is down costs dropped spans and one log line, never a 500 —
 * the failure mode of an observability pipeline should not be an outage.
 */
export function otlpExporter(options: OtlpOptions): SpanExporter {
  const url = options.endpoint.replace(/\/$/, "").endsWith("/v1/traces")
    ? options.endpoint
    : `${options.endpoint.replace(/\/$/, "")}/v1/traces`;
  const doFetch = options.fetchImpl ?? fetch;
  const maxBatch = options.maxBatch ?? 256;
  const serviceName = options.serviceName ?? "bql-bus";
  let buffer: SpanData[] = [];
  let stopped = false;

  const send = async (spans: SpanData[]) => {
    if (spans.length === 0) return;
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: attributes({ "service.name": serviceName }),
          },
          scopeSpans: [
            {
              scope: { name: "bql-bus" },
              spans: spans.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: KIND[span.kind],
                startTimeUnixNano: String(Math.round(span.startMs * 1e6)),
                endTimeUnixNano: String(Math.round(span.endMs * 1e6)),
                attributes: attributes(span.attributes),
                ...(span.error
                  ? { status: { code: 2, message: span.error } }
                  : { status: { code: 1 } }),
              })),
            },
          ],
        },
      ],
    };
    try {
      await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      options.onError?.(error);
    }
  };

  const timer = setInterval(() => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    void send(batch);
  }, options.flushMs ?? 5000);
  timer.unref?.();

  return {
    record(span) {
      if (stopped) return;
      buffer.push(span);
      if (buffer.length >= maxBatch) {
        const batch = buffer;
        buffer = [];
        void send(batch);
      }
    },
    async flush() {
      const batch = buffer;
      buffer = [];
      await send(batch);
    },
    async shutdown() {
      stopped = true;
      clearInterval(timer);
      const batch = buffer;
      buffer = [];
      await send(batch);
    },
  };
}
