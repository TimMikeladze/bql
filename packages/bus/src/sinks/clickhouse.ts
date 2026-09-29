import type { SinkRecord, SinkWriter } from "./runner";

/**
 * Inserts each batch with ClickHouse's HTTP interface:
 * `POST <url>/?query=INSERT INTO <table> FORMAT JSONEachRow`, one line per
 * message. `input_format_skip_unknown_fields` is on, so a table takes the
 * columns it names and ignores the rest — which also means a line whose keys
 * match no column inserts a row of defaults without complaint, so the shape
 * has to fit the table:
 *
 * - `"body"` (default): the message body as it stands; a body that is not an
 *   object is wrapped as `{"body": …}`. Right for events you publish yourself.
 * - `"row"`: for the db outbox, whose body is `{db, table, op, txid, row, …}`
 *   — the table's columns are inside `row`. This unwraps it (`old` for a
 *   delete, falling back to `pk`) and adds `_op`, `_db`, `_table`, `_txid`,
 *   `_seq`, `_i` and `_committed_at`, for a table that wants them.
 * - `"record"`: the whole `SinkRecord`, subject and sequence number included.
 */

export interface ClickHouseSinkOptions {
  /** `http(s)://host:8123`. */
  url: string;
  /** `table` or `database.table`. */
  table: string;
  database?: string;
  user?: string;
  password?: string;
  shape?: "body" | "row" | "record";
  fetchImpl?: typeof fetch;
}

const TABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** An outbox change as a table row: its values, plus the change's metadata. */
function outboxRow(body: Obj): Obj {
  const values = [body.row, body.old, body.pk].find(isObject) ?? {};
  return {
    ...values,
    _op: body.op,
    _db: body.db,
    _table: body.table,
    _txid: body.txid,
    _seq: body.seq,
    _i: body.i,
    _committed_at: body.committedAt,
  };
}

export function clickhouseRows(
  records: SinkRecord[],
  shape: "body" | "row" | "record" = "body",
): string {
  return (
    records
      .map((record) => {
        if (shape === "record") return JSON.stringify(record);
        const body = record.body;
        if (shape === "row") {
          if (!isObject(body) || typeof body.op !== "string")
            throw new Error(
              `clickhouse shape "row" wants db outbox changes; message ${record.seq} on ${record.subject} is not one`,
            );
          return JSON.stringify(outboxRow(body));
        }
        return JSON.stringify(
          body !== null && typeof body === "object" && !Array.isArray(body) ? body : { body },
        );
      })
      .join("\n") + "\n"
  );
}

export function clickhouseSink(options: ClickHouseSinkOptions): SinkWriter {
  // The table is spliced into the query text, so it is an identifier or it is
  // refused — never escaped and hoped for.
  if (!TABLE.test(options.table))
    throw new Error(`clickhouse table must be an identifier or database.table, got '${options.table}'`);
  const doFetch = options.fetchImpl ?? fetch;
  const query = new URLSearchParams({
    query: `INSERT INTO ${options.table} FORMAT JSONEachRow`,
    input_format_skip_unknown_fields: "1",
    ...(options.database ? { database: options.database } : {}),
  });
  const endpoint = `${options.url.replace(/\/$/, "")}/?${query}`;
  return {
    kind: "clickhouse",
    async write(records: SinkRecord[], signal: AbortSignal) {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          ...(options.user ? { "x-clickhouse-user": options.user } : {}),
          ...(options.password ? { "x-clickhouse-key": options.password } : {}),
        },
        body: clickhouseRows(records, options.shape),
        signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok)
        throw new Error(`clickhouse answered ${response.status}: ${text.slice(0, 300)}`);
    },
  };
}
