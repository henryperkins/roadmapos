import { describe, expect, it } from "vitest";
import { signPilotLink, verifyPilotLink } from "../src/index.js";

describe("signed pilot links", () => {
  it("rejects tampering and expiration", () => {
    const token = signPilotLink(
      { subject: "effort_confirmation", subjectId: "abc", githubUserId: "42", expiresAt: 2_000 },
      "secret"
    );
    expect(verifyPilotLink(token, "secret", 1_000).subjectId).toBe("abc");
    expect(() => verifyPilotLink(`${token}x`, "secret", 1_000)).toThrow();
    expect(() => verifyPilotLink(token, "secret", 2_001)).toThrow("Link has expired");
  });

  it("round-trips the quality-assessment form subject", () => {
    const token = signPilotLink(
      { subject: "quality_assessment", subjectId: "run-123", githubUserId: "42", expiresAt: 2_000 },
      "secret"
    );
    expect(verifyPilotLink(token, "secret", 1_000).subject).toBe("quality_assessment");
  });
});
