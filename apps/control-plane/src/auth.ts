import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlPlaneConfig } from "./config.js";

export type InternalRole = "operator" | "auditor";

declare module "fastify" {
  interface FastifyRequest { internalRole?: InternalRole }
}

function matches(token: string, expectedHex: string): boolean {
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function registerInternalAuth(app: FastifyInstance, config: ControlPlaneConfig): Promise<void> {
  app.decorateRequest("internalRole");
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/internal/")) return;
    const value = request.headers.authorization;
    const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
    if (matches(token, config.operatorTokenSha256)) request.internalRole = "operator";
    else if (matches(token, config.auditorTokenSha256)) request.internalRole = "auditor";
    else return reply.code(401).send({ error: "unauthorized" });
  });
}

export function requireRole(request: FastifyRequest, role: InternalRole): void {
  if (request.internalRole !== role) {
    const error = new Error("forbidden") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}
