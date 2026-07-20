import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

const PilotLinkPayloadSchema = z.object({
  subject: z.enum(["effort_confirmation", "monitoring_confirmation", "trust_survey", "review_ready", "quality_assessment"]),
  subjectId: z.string().min(1),
  githubUserId: z.string().regex(/^\d+$/),
  expiresAt: z.number().int().positive()
});
export type PilotLinkPayload = z.infer<typeof PilotLinkPayloadSchema>;

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body, "utf8").digest();
}

export function signPilotLink(payload: PilotLinkPayload, secret: string): string {
  const body = encode(canonicalJson(PilotLinkPayloadSchema.parse(payload)));
  return `${body}.${signature(body, secret).toString("base64url")}`;
}

export function verifyPilotLink(token: string, secret: string, now = Date.now()): PilotLinkPayload {
  const [body, provided] = token.split(".");
  if (!body || !provided) throw new Error("Malformed signed link");
  const expected = signature(body, secret);
  const actual = Buffer.from(provided, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid signed link");
  }
  const payload = PilotLinkPayloadSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  if (payload.expiresAt < now) throw new Error("Link has expired");
  return payload;
}
