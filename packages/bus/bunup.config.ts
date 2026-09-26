import { defineConfig } from "bunup";

/**
 * The library bundle. One entry per subpath in `exports`, plus the binary.
 *
 * The dashboard is built separately by Vite into `dist/dashboard`, so this
 * runs *first*: bunup cleans `dist` on the way in, and the other order would
 * quietly delete the dashboard that was just built.
 *
 * Nothing published points at this bundle any more — `bql.sh` ships TypeScript source, and the
 * only thing the tarball needs from `dist` is the dashboard the CLI serves. So `prepack` runs
 * `build:dashboard`, not this, and bunup's isolated-declaration diagnostics (warnings here, errors
 * on a clean runner) stay out of the release path. Keep it for a JS bundle when one is wanted.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/client/bus.ts", "src/cli/index.ts"],
  format: ["esm"],
  target: "bun",
  dts: true,
});
