import { createHmac, timingSafeEqual } from "node:crypto";
import type { SinkRecord, SinkWriter } from "./runner";

/**
 * POSTs each batch as a JSON array of `SinkRecord`s. Anything but a 2xx
 * throws, which nacks the batch into the bus's retry and dead-letter path — the
 * webhook sink has no retry loop of its own on purpose, because the bus's is
 * durable and this one would not be.
 *
 * With a secret, the request carries `x-bql-signature: t=<ms>,sha256=<hex>`,
 * an HMAC-SHA256 over `<t>.<body>`. The timestamp is signed so a captured
 * request cannot be replayed later; `verifyWebhookSignature` is the receiving
 * half.
 */

export const SIGNATURE_HEADER = "x-bql-signature";

export interface WebhookSinkOptions {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export function signWebhook(secret: string, body: string, at = Date.now()): string {
  const digest = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return `t=${at},sha256=${digest}`;
}

/** True when `header` is a signature of `body` under `secret`, made within `toleranceMs`. */
export function verifyWebhookSignature(
  secret: string,
  header: string | null,
  body: string,
  toleranceMs = 5 * 60_000,
  now = Date.now(),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    }),
  );
  const at = Number(parts.t);
  if (!Number.isFinite(at) || Math.abs(now - at) > toleranceMs) return false;
  const expected = Buffer.from(signWebhook(secret, body, at).split("sha256=")[1]!, "hex");
  const given = Buffer.from(parts.sha256 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function webhookSink(options: WebhookSinkOptions): SinkWriter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    kind: "webhook",
    async write(records: SinkRecord[], signal: AbortSignal) {
      const body = JSON.stringify(records);
      const response = await doFetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.headers ?? {}),
          ...(options.secret ? { [SIGNATURE_HEADER]: signWebhook(options.secret, body) } : {}),
        },
        body,
        signal,
      });
      // Drained either way, so the connection goes back to the pool.
      const text = await response.text().catch(() => "");
      if (!response.ok)
        throw new Error(`webhook answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    },
  };
}
