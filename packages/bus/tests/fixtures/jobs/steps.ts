/** Handlers for the end-to-end fixture. Deliberately slow, so a worker can be
 * killed while it is genuinely holding the step. */
export async function slow(ctx: {
  input: { text?: string; ms?: number };
}) {
  await new Promise((resolve) => setTimeout(resolve, Number(ctx.input.ms ?? 0)));
  const slug = String(ctx.input.text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { slug, host: process.env.BQL_BUS_WORKER ?? "unknown" };
}
