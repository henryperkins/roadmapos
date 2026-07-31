import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { internalAccessTokens, participants, type Database } from "@roadmapos/db";

export type ParticipantRole = "operator" | "auditor";
/** `admin` bootstraps pilots and participants; it can never write governance evidence. */
export type InternalRole = ParticipantRole | "admin";

/**
 * The immutable identity behind an internal session. Every governance record an operator or
 * auditor writes is attributed to `participantId` rather than to a shared role token, and
 * `pilotId` scopes what that session may read or change.
 */
export interface InternalParticipant {
  participantId: string;
  pilotId: string;
  githubUserId: string;
  githubLogin: string;
  role: ParticipantRole;
}

declare module "fastify" {
  interface FastifyRequest {
    internalRole?: InternalRole;
    internalParticipant?: InternalParticipant;
  }
}

export function hashInternalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function resolveInternalParticipant(database: Database, token: string): Promise<InternalParticipant | null> {
  if (!token) return null;
  const [row] = await database.db
    .select({
      participantId: participants.id,
      pilotId: participants.pilotId,
      githubUserId: participants.githubUserId,
      githubLogin: participants.githubLogin,
      studyRole: participants.studyRole
    })
    .from(internalAccessTokens)
    .innerJoin(participants, eq(participants.id, internalAccessTokens.participantId))
    .where(and(eq(internalAccessTokens.tokenSha256, hashInternalToken(token)), isNull(internalAccessTokens.revokedAt)));
  if (!row) return null;
  if (row.studyRole !== "operator" && row.studyRole !== "auditor") return null;
  return {
    participantId: row.participantId,
    pilotId: row.pilotId,
    githubUserId: row.githubUserId.toString(),
    githubLogin: row.githubLogin,
    role: row.studyRole
  };
}

function matchesAdminToken(token: string, expectedHex: string): boolean {
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function registerInternalAuth(app: FastifyInstance, database: Database, adminTokenSha256: string): Promise<void> {
  app.decorateRequest("internalRole");
  app.decorateRequest("internalParticipant");
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/internal/")) return;
    const value = request.headers.authorization;
    const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
    const participant = await resolveInternalParticipant(database, token);
    if (participant) {
      request.internalParticipant = participant;
      request.internalRole = participant.role;
      return;
    }
    if (token && matchesAdminToken(token, adminTokenSha256)) {
      request.internalRole = "admin";
      return;
    }
    return reply.code(401).send({ error: "unauthorized" });
  });
}

export function requireRole(request: FastifyRequest, role: InternalRole): void {
  if (request.internalRole !== role) {
    const error = new Error("forbidden") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}

/** Returns the bound participant, refusing anything that is not the required role. */
export function requireParticipant(request: FastifyRequest, role: ParticipantRole): InternalParticipant {
  requireRole(request, role);
  const participant = request.internalParticipant;
  if (!participant) {
    const error = new Error("forbidden") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  return participant;
}
