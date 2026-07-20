import { describe, expect, it } from "vitest";
import { SecretBox } from "../src/index.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("SecretBox", () => {
  it("round-trips structured data and binds associated data", () => {
    const box = new SecretBox(key);
    const sealed = box.seal({ decision: "continue" }, "checkpoint:123");
    expect(box.open(sealed, "checkpoint:123")).toEqual({ decision: "continue" });
    expect(() => box.open(sealed, "checkpoint:124")).toThrow("Unable to decrypt artifact");
  });
});
