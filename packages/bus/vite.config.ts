import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { mint } from "./src/bus/tokens";

/**
 * In production the bus serves the dashboard and injects a read-only token
 * itself. The dev server has to do the same job, or every reload would be an
 * unauthenticated one — so it mints the same kind of token from the same
 * signing key the local bus is using.
 */
function injectReaderToken(): Plugin {
  return {
    name: "bql-bus-reader-token",
    transformIndexHtml(html) {
      let key: string;
      try {
        key = readFileSync(
          process.env.BUS_STATE ?? ".bql-bus/signing-key",
          "utf8",
        ).trim();
      } catch {
        return html; // No local bus yet; the page will report 401 plainly.
      }
      const token = mint(
        {
          sub: "dashboard",
          scope: "reader",
          workspace: "default",
          publish: [],
          subscribe: [],
          exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        },
        key,
      );
      return html.replace(
        "</head>",
        `<script>window.__BUS_TOKEN=${JSON.stringify(token)}</script></head>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), injectReaderToken()],
  // The library bundle owns `dist/`, so the dashboard lives beneath it. Both
  // ship in the package, and the bus serves `--assets dist/dashboard`.
  build: { outDir: "dist/dashboard", emptyOutDir: true },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/dashboard", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_PORT ?? 5173),
    // Never fight another app for a port: take the next free one instead.
    strictPort: false,
    proxy: {
      "/api": {
        target: process.env.BUS_URL || "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
});
