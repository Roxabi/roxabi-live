import path from "node:path";
import { defineConfig } from "vitest/config";

// Isolated test config — does NOT pull in the React/Tailwind build plugins.
// Default environment is node (Web Crypto is a Node global ≥20); the zk session
// suite opts into jsdom via a per-file `// @vitest-environment jsdom` directive.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
