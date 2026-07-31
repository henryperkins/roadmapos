import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PilotRegistry } from "../pilot-registry.js";
import { requireRole } from "../auth.js";

export async function registerPilotRoutes(app: FastifyInstance, registry: PilotRegistry): Promise<void> {
  app.post("/internal/pilots", async (request, reply) => {
    requireRole(request, "admin");
    const body = z.object({ name: z.string().min(1) }).parse(request.body);
    const id = await registry.createPilot({ name: body.name });
    return reply.code(201).send({ id });
  });

  app.post("/internal/pairs/:pairId/assign", async (request) => {
    requireRole(request, "admin");
    const { pairId } = z.object({ pairId: z.string().uuid() }).parse(request.params);
    return registry.assignPair(pairId);
  });
}
