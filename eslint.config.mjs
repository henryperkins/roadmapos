import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/coverage/**", "eslint.config.mjs", "vitest.workspace.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      // Async functions are used for Fastify plugin/handler interface conformance
      // (register hooks, route handlers) even when a given body has nothing to await.
      "@typescript-eslint/require-await": "off",
      // Allow the "omit a key via rest" destructure and intentionally-unused _-prefixed bindings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ]
    }
  }
);
