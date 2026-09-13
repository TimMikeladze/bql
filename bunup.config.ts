import { defineConfig } from "bunup";

/**
 * The library bundle. One entry per subpath in `exports`, plus the binary.
 *
 * The dashboard is built separately by Vite into `dist/dashboard`, so this
 * runs *first*: bunup cleans `dist` on the way in, and the other order would
 * quietly delete the dashboard that was just built.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/client/bus.ts", "src/cli/index.ts"],
  format: ["esm"],
  target: "bun",
  dts: true,
});
