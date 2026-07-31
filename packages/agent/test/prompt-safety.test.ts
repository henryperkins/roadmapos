import { describe, expect, it } from "vitest";
import { assertPromptSafe } from "../src/index.js";

describe("assertPromptSafe", () => {
  it("rejects common credential material", () => {
    expect(() => { assertPromptSafe("OPENAI_API_KEY=sk-example-secret"); }).toThrow("credential-like material");
    expect(() => { assertPromptSafe("ghs_abcdefghijklmnopqrstuvwxyz123456"); }).toThrow("credential-like material");
    expect(() => { assertPromptSafe("-----BEGIN PRIVATE KEY-----"); }).toThrow("credential-like material");
  });

  it("rejects an oversized prompt", () => {
    expect(() => { assertPromptSafe("a".repeat(1_500_001)); }).toThrow("exceeds 1.5 MB");
  });

  it("accepts normal public repository context", () => {
    expect(() => { assertPromptSafe("src/parser.ts validates empty input"); }).not.toThrow();
  });
});
