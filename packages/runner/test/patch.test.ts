import { expect, it } from "vitest";
import { affectedPathsFromPatch } from "../src/index.js";

it("extracts safe paths and rejects traversal", () => {
  expect(affectedPathsFromPatch("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n")).toEqual(["src/a.ts"]);
  expect(() => affectedPathsFromPatch("diff --git a/a b/../../secret\n--- a/a\n+++ b/../../secret\n")).toThrow("Unsafe patch path");
});

it("treats /dev/null as an absent side and requires at least one path", () => {
  expect(affectedPathsFromPatch("--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+a\n")).toEqual(["src/new.ts"]);
  expect(() => affectedPathsFromPatch("no diff headers here")).toThrow("no affected repository path");
});
