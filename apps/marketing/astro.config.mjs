import path from "node:path";
import { fileURLToPath } from "node:url";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// Monorepo root — so Vite may read the shared `brand/` CSS that global.css
// @imports from outside this app's directory, and Astro reads root .env.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  site: "https://live.roxabi.dev",
  envDir: repoRoot,
  integrations: [sitemap()],
  vite: {
    server: {
      // Allow importing the shared design system from `brand/` at the repo root.
      fs: { allow: [repoRoot] },
      // Dev-only: proxy /api to the local Worker (future waitlist / public API).
      proxy: {
        "/api": {
          target: "http://localhost:8787",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ""),
        },
      },
    },
  },
});
