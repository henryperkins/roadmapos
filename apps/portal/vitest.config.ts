import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const portalRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
    fileParallelism: false,
    globals: true,
    // jsdom rewrites `import.meta.url` to an http URL, and the workspace runner's cwd is the repo
    // root, so tests that read page sources from disk take the package root from here instead.
    env: { PORTAL_ROOT: portalRoot },
    coverage: { reporter: ["text", "json-summary"] }
  },
  esbuild: { jsx: "automatic" }
});
