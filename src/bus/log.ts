/**
 * Structured logging.
 *
 * `console.error` was the whole story, which is fine until someone has to find
 * out why one consumer stopped acking at 03:00. Two formats, because the two
 * audiences are different: `text` for a terminal, `json` for anything that
 * parses.
 *
 * What it deliberately does *not* do is log a line per request. At a claim
 * every 100ms per consumer that is the loudest thing in the system and says
 * the least — request-level detail lives at `debug`, off by default.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "text" | "json";

export type Fields = Record<string, string | number | boolean | null>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** A logger that stamps these fields onto every line. */
  child(fields: Fields): Logger;
  readonly level: LogLevel;
}

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export function isLogLevel(value: string): value is LogLevel {
  return value in ORDER;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Where lines go. Defaults to stderr, so stdout stays a data channel. */
  write?: (line: string) => void;
  now?: () => number;
}

function render(
  format: LogFormat,
  level: Exclude<LogLevel, "silent">,
  time: number,
  message: string,
  fields: Fields,
): string {
  if (format === "json")
    return JSON.stringify({
      time: new Date(time).toISOString(),
      level,
      message,
      ...fields,
    });
  const pairs = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === "string" && /[\s"]/.test(value) ? JSON.stringify(value) : String(value)}`)
    .join(" ");
  return `${new Date(time).toISOString()} ${level.padEnd(5)} ${message}${
    pairs ? ` ${pairs}` : ""
  }`;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "text";
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const threshold = ORDER[level];

  const make = (bound: Fields): Logger => {
    const at =
      (at: Exclude<LogLevel, "silent">) => (message: string, fields: Fields = {}) => {
        if (ORDER[at] < threshold) return;
        write(render(format, at, now(), message, { ...bound, ...fields }));
      };
    return {
      level,
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      child: (fields: Fields) => make({ ...bound, ...fields }),
    };
  };
  return make({});
}

/** A logger that discards everything. The default inside the library. */
export function silentLogger(): Logger {
  return createLogger({ level: "silent", write: () => {} });
}
