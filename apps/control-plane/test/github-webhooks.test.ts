import { createHmac } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { createDatabase, jobs } from "@roadmapos/db";
import { eq } from "drizzle-orm";
import { resetTestDatabase } from "@roadmapos/testkit";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");

beforeEach(async () => resetTestDatabase(url));

const secret = "webhook-secret-123";

function config(databaseUrl: string) {
  return {
    databaseUrl,
    operatorTokenSha256: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    auditorTokenSha256: "b49f425a7e1f9cff3856329ada223f2f9d368f15a00cf48df16ca95986137fe8",
    artifactEncryptionKeyBase64: Buffer.alloc(32, 1).toString("base64"),
    pilotLinkSecret: "pilot-link-secret-123",
    publicBaseUrl: "http://localhost:3000",
    githubAppId: "1",
    githubPrivateKeyBase64: Buffer.from("private-key").toString("base64"),
    githubWebhookSecret: secret,
    githubReadyLabel: "roadmapos:ready"
  };
}

it("accepts one signed delivery and treats the repeated delivery id as a duplicate", async () => {
  const body = Buffer.from(JSON.stringify({
    action: "labeled",
    label: { name: "roadmapos:ready" },
    repository: { id: 1, name: "widget", owner: { login: "acme" } },
    issue: { number: 17 }
  }));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const app = await buildApp(config(url));
  const headers = {
    "content-type": "application/json",
    "x-github-delivery": "delivery-1",
    "x-github-event": "issues",
    "x-hub-signature-256": signature
  };
  const first = await app.inject({ method: "POST", url: "/github/webhooks", headers, payload: body });
  const second = await app.inject({ method: "POST", url: "/github/webhooks", headers, payload: body });
  expect(first.statusCode).toBe(202);
  expect(first.json()).toEqual({ accepted: true });
  expect(second.statusCode).toBe(202);
  expect(second.json()).toEqual({ duplicate: true });

  const database = createDatabase(url);
  const queued = await database.db.select().from(jobs).where(eq(jobs.jobType, "github.webhook"));
  expect(queued).toHaveLength(1);
  await database.close();
  await app.close();
});

it("rejects an unsigned or tampered delivery without recording it", async () => {
  const body = Buffer.from(JSON.stringify({ action: "labeled" }));
  const app = await buildApp(config(url));
  const unsigned = await app.inject({
    method: "POST",
    url: "/github/webhooks",
    headers: { "content-type": "application/json", "x-github-delivery": "delivery-2", "x-github-event": "issues" },
    payload: body
  });
  expect(unsigned.statusCode).toBe(401);

  const wrongSignature = `sha256=${createHmac("sha256", "other-secret").update(body).digest("hex")}`;
  const tampered = await app.inject({
    method: "POST",
    url: "/github/webhooks",
    headers: { "content-type": "application/json", "x-github-delivery": "delivery-3", "x-github-event": "issues", "x-hub-signature-256": wrongSignature },
    payload: body
  });
  expect(tampered.statusCode).toBe(401);

  const database = createDatabase(url);
  const queued = await database.db.select().from(jobs).where(eq(jobs.jobType, "github.webhook"));
  expect(queued).toHaveLength(0);
  await database.close();
  await app.close();
});

it("still parses JSON on the internal API after installing the raw webhook parser", async () => {
  const app = await buildApp(config(url));
  const created = await app.inject({
    method: "POST",
    url: "/internal/pilots",
    headers: { authorization: "Bearer hi" },
    payload: { name: "Pilot A" }
  });
  expect(created.statusCode).toBe(201);
  await app.close();
});
