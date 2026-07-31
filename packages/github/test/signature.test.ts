import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { verifyGitHubSignature } from "../src/index.js";

it("accepts an exact sha256 signature and rejects tampering", () => {
  const body = Buffer.from('{"action":"labeled"}');
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  expect(verifyGitHubSignature(body, signature, "secret")).toBe(true);
  expect(verifyGitHubSignature(Buffer.from('{"action":"deleted"}'), signature, "secret")).toBe(false);
  expect(verifyGitHubSignature(body, undefined, "secret")).toBe(false);
  expect(verifyGitHubSignature(body, "sha1=deadbeef", "secret")).toBe(false);
});
