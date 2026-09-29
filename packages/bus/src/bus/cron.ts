/**
 * Cron expressions, and when they next fire in a real time zone.
 *
 * Five fields — minute, hour, day of month, month, day of week — with `*`,
 * lists, ranges, steps and month/day names, plus the `@hourly`-style aliases.
 * Day of month and day of week follow Vixie cron: when both are restricted a
 * day matches if *either* does, and a field that starts with `*` counts as
 * unrestricted (so `*\/2` in one of them turns the OR back into an AND).
 *
 * Time zones are IANA names resolved through `Intl`, so there is no zone table
 * to ship. DST follows Vixie cron's split between two kinds of job:
 *
 * - **Wildcard** jobs — the minute or the hour field starts with `*`
 *   (`* * * * *`, `*\/15 * * * *`, `0 * * * *`, `@hourly`) — run on real
 *   time. Through a repeated hour they fire in both passes, so a minutely job
 *   never goes quiet for 61 minutes; minutes the clock skips are simply not
 *   there.
 * - **Fixed** jobs (`30 1 * * *`) name a wall-clock time. One the clocks skip
 *   fires once, at the first valid minute after the gap; one that happens
 *   twice fires once, at its first occurrence.
 *
 * The search jumps field by field rather than minute by minute, so even a
 * leap-day schedule is a handful of steps, not a year of minutes.
 */

export class CronError extends Error {}

const MINUTE = 60_000;

interface Field {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  {
    name: "month",
    min: 1,
    max: 12,
    names: Object.fromEntries(MONTHS.map((month, index) => [month, index + 1])),
  },
  // 7 is Sunday as well as 0; folded onto 0 after parsing.
  {
    name: "day of week",
    min: 0,
    max: 7,
    names: Object.fromEntries(DAYS.map((day, index) => [day, index])),
  },
];

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export interface Cron {
  source: string;
  minute: boolean[];
  hour: boolean[];
  /** Indexed 1..31. */
  dom: boolean[];
  /** Indexed 1..12. */
  month: boolean[];
  /** Indexed 0..6, Sunday first. */
  dow: boolean[];
  domStar: boolean;
  dowStar: boolean;
  /** Minute or hour starts with `*`: stepped in real time across DST. */
  wildcard: boolean;
}

function value(text: string, field: Field, source: string): number {
  const named = field.names?.[text.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(text))
    throw new CronError(`${field.name} has an invalid value '${text}' in "${source}"`);
  const number = Number(text);
  if (number < field.min || number > field.max)
    throw new CronError(
      `${field.name} value ${number} is outside ${field.min}-${field.max} in "${source}"`,
    );
  return number;
}

function parseField(text: string, field: Field, source: string): boolean[] {
  const set = new Array<boolean>(field.max + 1).fill(false);
  for (const item of text.split(",")) {
    if (item === "")
      throw new CronError(`${field.name} has an empty list item in "${source}"`);
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined || range === undefined || range === "")
      throw new CronError(`${field.name} has an invalid item '${item}' in "${source}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw new CronError(`${field.name} has an invalid step '${stepText}' in "${source}"`);
      step = Number(stepText);
    }
    let low: number;
    let high: number;
    if (range === "*") {
      low = field.min;
      high = field.max;
    } else if (range.includes("-")) {
      const [from, to, more] = range.split("-");
      if (more !== undefined || !from || !to)
        throw new CronError(`${field.name} has an invalid range '${range}' in "${source}"`);
      low = value(from, field, source);
      high = value(to, field, source);
      if (low > high)
        throw new CronError(
          `${field.name} range '${range}' runs backwards in "${source}"`,
        );
    } else {
      low = value(range, field, source);
      // `5/15` means "from 5, every 15" — the common reading, where Vixie
      // would reject it outright.
      high = stepText !== undefined ? field.max : low;
    }
    for (let index = low; index <= high; index += step) set[index] = true;
  }
  return set;
}

/** Parse, or throw a `CronError` that names the field and the expression. */
export function parseCron(expression: string): Cron {
  const source = expression.trim();
  const expanded = source.startsWith("@") ? ALIASES[source.toLowerCase()] : source;
  if (expanded === undefined)
    throw new CronError(
      `unknown alias "${source}"; expected one of ${Object.keys(ALIASES).join(", ")}`,
    );
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5)
    throw new CronError(
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length} in "${source}"`,
    );
  const [minute, hour, dom, month, dow] = parts.map((part, index) =>
    parseField(part, FIELDS[index]!, source),
  ) as [boolean[], boolean[], boolean[], boolean[], boolean[]];
  if (dow[7]) dow[0] = true;
  dow.length = 7;
  return {
    source,
    minute,
    hour,
    dom,
    month,
    dow,
    domStar: parts[2]!.startsWith("*"),
    dowStar: parts[4]!.startsWith("*"),
    wildcard: parts[0]!.startsWith("*") || parts[1]!.startsWith("*"),
  };
}

/** Throw unless `zone` is an IANA zone this runtime knows. */
export function assertTimeZone(zone: string): void {
  try {
    formatter(zone);
  } catch {
    throw new CronError(`unknown time zone '${zone}'`);
  }
}

// ---------------------------------------------------------------- zones

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let cached = formatters.get(zone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, cached);
  }
  return cached;
}

/** Local wall-clock time at `instant`, encoded as if it were UTC. */
function wall(zone: string, instant: number): number {
  if (zone === "UTC") return instant;
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(instant))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
}

const offsetAt = (zone: string, instant: number) =>
  wall(zone, instant) - Math.floor(instant / 1000) * 1000;

/**
 * The instant a local wall-clock minute fires at.
 *
 * Offsets a day either side cover both sides of any transition, since no zone
 * changes offset twice in a day. A repeated time takes its earlier instant; a
 * skipped one takes the first instant after the gap.
 */
function resolve(zone: string, local: number): number {
  if (zone === "UTC") return local;
  const before = offsetAt(zone, local - 86_400_000);
  const after = offsetAt(zone, local + 86_400_000);
  const valid = [before, after]
    .map((offset) => local - offset)
    .filter((instant) => wall(zone, instant) === local);
  if (valid.length > 0) return Math.min(...valid);
  // A gap: the transition lies between the two readings. Binary search to the
  // minute for the first instant already on the far side of it.
  let low = local - Math.max(before, after);
  let high = local - Math.min(before, after);
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
    if (offsetAt(zone, middle) === after) high = middle;
    else low = middle;
  }
  return high;
}

// --------------------------------------------------------------- search

function dayMatches(cron: Cron, date: Date): boolean {
  const dom = cron.dom[date.getUTCDate()]!;
  const dow = cron.dow[date.getUTCDay()]!;
  return cron.domStar || cron.dowStar ? dom && dow : dom || dow;
}

/** First local minute at or after `from` (UTC-encoded wall time) that matches. */
function nextLocal(cron: Cron, from: number): number | null {
  const date = new Date(from);
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth() + 1;
  let day = date.getUTCDate();
  let hour = date.getUTCHours();
  let minute = date.getUTCMinutes();
  // Past this, nothing will ever match — `0 0 31 2 *` parses fine and is only
  // knowable as impossible here. A leap day is at most eight years away.
  const limit = year + 9;
  for (;;) {
    if (year > limit) return null;
    if (!cron.month[month]) {
      month++;
      day = 1;
      hour = 0;
      minute = 0;
      if (month > 12) {
        month = 1;
        year++;
      }
      continue;
    }
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day > days || !dayMatches(cron, new Date(Date.UTC(year, month - 1, day)))) {
      day++;
      hour = 0;
      minute = 0;
      if (day > days) {
        day = 1;
        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }
      continue;
    }
    if (!cron.hour[hour]) {
      hour++;
      minute = 0;
      if (hour > 23) {
        hour = 0;
        day++;
      }
      continue;
    }
    if (!cron.minute[minute]) {
      minute++;
      if (minute > 59) {
        minute = 0;
        hour++;
        if (hour > 23) {
          hour = 0;
          day++;
        }
      }
      continue;
    }
    return Date.UTC(year, month - 1, day, hour, minute);
  }
}

/**
 * The first instant after `from` at which `zone`'s UTC offset differs from
 * its offset at `from`, or null if there is none before `until`. Scans by the
 * day (no zone changes twice in one), then binary searches to the minute.
 */
function transitionAfter(zone: string, from: number, until: number): number | null {
  const offset = offsetAt(zone, from);
  let low = from;
  for (;;) {
    if (low >= until) return null;
    const high = Math.min(until, low + 86_400_000);
    if (offsetAt(zone, high) === offset) {
      low = high;
      continue;
    }
    let lower = low;
    let upper = high;
    while (upper - lower > MINUTE) {
      const middle = lower + Math.floor((upper - lower) / 2 / MINUTE) * MINUTE;
      if (offsetAt(zone, middle) === offset) lower = middle;
      else upper = middle;
    }
    return upper;
  }
}

/**
 * A wildcard job, on real time.
 *
 * Search local time under the offset in force at `from`. A match whose
 * instant is still under that offset is the answer; one that is not lies past
 * a transition, so restart the search at the transition under the new offset.
 * After a fall back that restart re-reads the repeated hour; after a spring
 * forward it starts past the gap.
 */
function nextWildcard(cron: Cron, zone: string, from: number): number {
  for (let guard = 0; guard < 64; guard++) {
    const offset = offsetAt(zone, from);
    const local = wall(zone, from);
    const candidate = nextLocal(cron, local - (local % MINUTE));
    if (candidate === null) break;
    const instant = candidate - offset;
    // Same offset at both ends is enough: any repeated hour in between was
    // already searched once in local time, and its second pass holds the
    // same wall-clock minutes.
    if (offsetAt(zone, instant) === offset) return instant;
    from = transitionAfter(zone, from, instant) ?? instant;
  }
  throw new CronError(`"${cron.source}" never fires`);
}

/**
 * The first instant strictly after `afterMs` that `cron` fires at in `zone`.
 *
 * Throws a `CronError` for an expression that can never fire (`0 0 31 2 *`).
 */
export function nextFire(
  cron: Cron | string,
  zone: string,
  afterMs: number,
): number {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const start = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  if (zone === "UTC") {
    const candidate = nextLocal(parsed, start);
    if (candidate === null) throw new CronError(`"${parsed.source}" never fires`);
    return candidate;
  }
  if (parsed.wildcard) return nextWildcard(parsed, zone, start);
  let local = wall(zone, start);
  local -= local % MINUTE;
  // Candidates at or before `afterMs` are the second pass through a repeated
  // hour, or the rest of a gap that already fired: skip them. An hour of
  // minutes is the most that can be skipped in a row, so this is a bound, not
  // a budget anyone should meet.
  for (let guard = 0; guard < 10_000; guard++) {
    const candidate = nextLocal(parsed, local);
    if (candidate === null) break;
    const instant = resolve(zone, candidate);
    if (instant > afterMs) return instant;
    local = candidate + MINUTE;
  }
  throw new CronError(`"${parsed.source}" never fires`);
}
