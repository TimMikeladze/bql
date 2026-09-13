/**
 * Subject addressing: dot-separated tokens, with `*` for exactly one token and
 * `>` for one or more trailing tokens.
 *
 *   orders.eu.created        a concrete subject
 *   orders.*.created         matches orders.eu.created, not orders.eu.w.created
 *   orders.>                 matches both
 *
 * The NATS convention, chosen because people already know it. Matching runs
 * against the small set of subscriptions rather than against the message log,
 * so it never needs to be expressible in SQL.
 */

const TOKEN = /^[A-Za-z0-9_-]+$/;
export const MAX_TOKENS = 16;
export const MAX_SUBJECT_BYTES = 512;

export class SubjectError extends Error {
  constructor(message: string) {
    super(message);
    // Without this the class is indistinguishable from Error by name, which is
    // how a bad subject once reached a caller as a 500 instead of a 400.
    this.name = "SubjectError";
  }
}

/** A concrete subject: no wildcards, at least one token. */
export function assertSubject(subject: string): string {
  if (subject.length === 0 || subject.length > MAX_SUBJECT_BYTES)
    throw new SubjectError("subject must be 1..512 characters");
  const tokens = subject.split(".");
  if (tokens.length > MAX_TOKENS)
    throw new SubjectError(`subject may have at most ${MAX_TOKENS} tokens`);
  for (const token of tokens) {
    if (token === "*" || token === ">")
      throw new SubjectError("a published subject may not contain wildcards");
    if (!TOKEN.test(token))
      throw new SubjectError(
        `invalid subject token '${token}': use letters, digits, _ and -`,
      );
  }
  return subject;
}

/** A pattern: tokens, `*`, and an optional trailing `>`. */
export function assertPattern(pattern: string): string {
  if (pattern.length === 0 || pattern.length > MAX_SUBJECT_BYTES)
    throw new SubjectError("pattern must be 1..512 characters");
  const tokens = pattern.split(".");
  if (tokens.length > MAX_TOKENS)
    throw new SubjectError(`pattern may have at most ${MAX_TOKENS} tokens`);
  tokens.forEach((token, index) => {
    if (token === ">") {
      if (index !== tokens.length - 1)
        throw new SubjectError("'>' is only allowed as the final token");
      return;
    }
    if (token === "*") return;
    if (!TOKEN.test(token))
      throw new SubjectError(
        `invalid pattern token '${token}': use letters, digits, _, -, * or >`,
      );
  });
  return pattern;
}

export function matches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let index = 0; index < p.length; index++) {
    const token = p[index];
    // `>` swallows the rest, but only if there is a rest to swallow.
    if (token === ">") return s.length > index;
    if (index >= s.length) return false;
    if (token === "*") continue;
    if (token !== s[index]) return false;
  }
  return p.length === s.length;
}

/**
 * A SQL `GLOB` that is *sound but not exact*: it never excludes a subject the
 * pattern would match, so it is safe as a cheap narrowing predicate before the
 * exact token match above. A pattern whose leading tokens are literal turns
 * into an index-friendly prefix; anything else falls back to matching
 * everything, which is correct, just not selective.
 */
export function narrowingGlob(pattern: string): string {
  const tokens = pattern.split(".");
  const literal: string[] = [];
  for (const token of tokens) {
    if (token === "*" || token === ">") break;
    literal.push(token);
  }
  if (literal.length === 0) return "*";
  const exact = literal.length === tokens.length;
  // GLOB metacharacters cannot appear in a validated token, so the prefix needs
  // no escaping.
  return exact ? literal.join(".") : `${literal.join(".")}.*`;
}
