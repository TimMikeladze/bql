import type { SinkRecord, SinkWriter } from "./runner";

/**
 * Writes each batch as one gzipped NDJSON object — one `SinkRecord` per line —
 * through `Bun.S3Client`, so any S3-compatible store works (AWS, R2, Tigris,
 * MinIO). NDJSON and not Parquet: DuckDB, ClickHouse and Athena all read it,
 * and a Parquet writer would be the bus's first runtime dependency.
 *
 * The key is `<prefix><yyyy>/<mm>/<dd>/<hh>/<time>-<firstSeq>.ndjson.gz`, UTC.
 * Time first, so a date-partitioned reader can prune by prefix; the first
 * sequence number second, so two flushes in the same millisecond cannot
 * collide. A redelivered batch lands as a new object — at-least-once, and
 * `idempotencyKey` on every line is what a reader dedupes on.
 */

export interface S3SinkOptions {
  bucket: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Replaces the S3 client: what a test injects. */
  put?: (key: string, body: Uint8Array) => Promise<void>;
}

export function s3ObjectKey(prefix: string, at: Date, firstSeq: number): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(".", "");
  return `${prefix}${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())}/${pad(
    at.getUTCHours(),
  )}/${stamp}-${pad(firstSeq, 12)}.ndjson.gz`;
}

/** The object body: one JSON line per record, gzipped. */
export function encodeNdjson(records: SinkRecord[]): Uint8Array<ArrayBuffer> {
  const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  return Bun.gzipSync(new TextEncoder().encode(text));
}

export function s3Sink(options: S3SinkOptions): SinkWriter {
  const prefix = options.prefix ?? "";
  let put = options.put;
  if (!put) {
    const client = new Bun.S3Client({
      bucket: options.bucket,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.region ? { region: options.region } : {}),
      ...(options.accessKeyId ? { accessKeyId: options.accessKeyId } : {}),
      ...(options.secretAccessKey ? { secretAccessKey: options.secretAccessKey } : {}),
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    });
    put = async (key, body) => {
      await client.write(key, body, { type: "application/gzip" });
    };
  }
  const write = put;
  return {
    kind: "s3",
    async write(records: SinkRecord[], signal: AbortSignal) {
      signal.throwIfAborted();
      const first = records[0];
      if (!first) return;
      await write(s3ObjectKey(prefix, new Date(), first.seq), encodeNdjson(records));
    },
  };
}
