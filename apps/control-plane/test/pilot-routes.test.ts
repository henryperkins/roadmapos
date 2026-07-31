import { beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase } from "@roadmapos/testkit";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");

beforeEach(async () => resetTestDatabase(url));

describe("pilot routes", () => {
  it("allows operators to create a pilot and rejects auditors", async () => {
    const app = await buildApp({
      databaseUrl: url,
      operatorTokenSha256: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
      auditorTokenSha256: "b49f425a7e1f9cff3856329ada223f2f9d368f15a00cf48df16ca95986137fe8",
      artifactEncryptionKeyBase64: Buffer.alloc(32, 1).toString("base64"),
      pilotLinkSecret: "link-secret-value",
      publicBaseUrl: "http://localhost:3000",
      githubAppId: "1",
      githubPrivateKeyBase64: Buffer.from("private-key").toString("base64"),
      githubWebhookSecret: "webhook-secret-123",
      githubReadyLabel: "roadmapos:ready"
    });
    const created = await app.inject({
      method: "POST",
      url: "/internal/pilots",
      headers: { authorization: "Bearer hi" },
      payload: { name: "Pilot A" }
    });
    expect(created.statusCode).toBe(201);

    const denied = await app.inject({
      method: "POST",
      url: "/internal/pilots",
      headers: { authorization: "Bearer bye" },
      payload: { name: "Pilot B" }
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});
