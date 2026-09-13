/**
 * Dashboard assets embedded into a compiled binary.
 *
 * **Generated.** `scripts/build-binary.ts` rewrites this file with one
 * `import … with { type: "file" }` per built asset, compiles, and restores the
 * stub below. It is committed empty rather than generated on demand because a
 * *dynamic* import of a computed path is exactly what `bun build --compile`
 * cannot follow — the imports have to be statically visible, and that means a
 * real file on disk at compile time.
 *
 * Empty here means "serve the dashboard from disk", which is what `bun run`
 * from a checkout wants anyway.
 */
export const EMBEDDED_ASSETS: Record<string, string> = {};
