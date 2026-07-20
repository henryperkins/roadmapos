import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Canonical } from "../src/index.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively without sorting arrays", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 1 }, list: [3, 1] })).toBe(
      '{"a":{"x":1,"y":2},"list":[3,1],"z":1}'
    );
  });

  it("rejects non-JSON values", () => {
    expect(() => canonicalJson({ bad: undefined })).toThrow("Unsupported JSON value");
  });

  it("returns the same hash for equivalent object key order", () => {
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(
      sha256Canonical({ a: 1, b: 2 })
    );
  });
});
