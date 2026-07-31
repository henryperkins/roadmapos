import { expect, it } from "vitest";
import { assertReadablePath, normalizeRepositoryPath } from "../src/index.js";

it("rejects traversal, absolute paths, and .git", () => {
  for (const path of ["../secret", "/etc/passwd", ".git/config", "src/../../secret"]) {
    expect(() => assertReadablePath(path, ["src/**"])).toThrow();
  }
});

it("allows a matching repository path", () => {
  expect(assertReadablePath("src/parser.ts", ["src/**"])).toBe("src/parser.ts");
});

it("rejects a path outside the readable policy", () => {
  expect(() => assertReadablePath("docs/design.md", ["src/**"])).toThrow("outside readable policy");
});

it("normalizes separators without escaping the repository", () => {
  expect(normalizeRepositoryPath("src\\nested\\a.ts")).toBe("src/nested/a.ts");
  expect(normalizeRepositoryPath("./src/a.ts")).toBe("src/a.ts");
  expect(() => normalizeRepositoryPath("..")).toThrow("Unsafe repository path");
});
