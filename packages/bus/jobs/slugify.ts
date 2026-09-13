/**
 * A dagr `bun` handler. It is unremarkable on purpose: the point of the demo is
 * that this file runs on whichever machine claimed the task, not on the one
 * holding the journal.
 */
export function slugify(ctx: { input: { text?: string } }) {
  const text = String(ctx.input.text ?? "");
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { slug, length: slug.length };
}

/** Fails on a bad slug, so the demo has a failure edge worth watching. */
export function check(ctx: { input: { slug?: string; expect?: string } }) {
  const { slug, expect } = ctx.input;
  if (expect !== undefined && slug !== expect)
    throw new Error(`expected '${expect}', got '${slug}'`);
  return { ok: true, slug };
}
