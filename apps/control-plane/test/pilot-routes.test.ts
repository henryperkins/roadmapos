import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@roadmapos/db";
import { FIXTURE_OPERATOR_TOKEN, resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");

beforeEach(async () => resetTestDatabase(url));

const ADMIN_TOKEN = "admin-bootstrap";

function config(databaseUrl: string) {
  return {
    databaseUrl,
    adminTokenSha256: createHash("sha256").update(ADMIN_TOKEN, "utf8").digest("hex"),
    artifactEncryptionKeyBase64: Buffer.alloc(32, 1).toString("base64"),
    pilotLinkSecret: "link-secret-value",
    publicBaseUrl: "http://localhost:3000",
    githubAppId: "1",
    githubPrivateKeyBase64: Buffer.from("private-key").toString("base64"),
    githubWebhookSecret: "webhook-secret-123",
    githubReadyLabel: "roadmapos:ready"
  };
}

describe("pilot routes", () => {
  it("allows the bootstrap admin to create a pilot and rejects an unknown token", async () => {
    const app = await buildApp(config(url));
    const created = await app.inject({
      method: "POST",
      url: "/internal/pilots",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: "Pilot A" }
    });
    expect(created.statusCode).toBe(201);

    const denied = await app.inject({
      method: "POST",
      url: "/internal/pilots",
      headers: { authorization: "Bearer bye" },
      payload: { name: "Pilot B" }
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it("refuses pilot bootstrap to a participant-bound operator session", async () => {
    const database = createDatabase(url);
    await seedExecutionFixture(database);
    const app = await buildApp(config(url));
    const denied = await app.inject({
      method: "POST",
      url: "/internal/pilots",
      headers: { authorization: `Bearer ${FIXTURE_OPERATOR_TOKEN}` },
      payload: { name: "Pilot C" }
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
    await database.close();
  });
});
