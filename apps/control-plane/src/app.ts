import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { createDatabase } from "@roadmapos/db";
import { registerInternalAuth } from "./auth.js";
import { ControlPlaneConfigSchema, type ControlPlaneConfig } from "./config.js";
import { PilotRegistry } from "./pilot-registry.js";
import { registerPilotRoutes } from "./routes/pilots.js";

export async function buildApp(rawConfig: ControlPlaneConfig) {
  const config = ControlPlaneConfigSchema.parse(rawConfig);
  const app = Fastify({ logger: false });
  await app.register(sensible);
  const database = createDatabase(config.databaseUrl);
  app.addHook("onClose", async () => database.close());
  await registerInternalAuth(app, config);
  await registerPilotRoutes(app, new PilotRegistry(database));
  app.get("/health", async () => ({ ok: true }));
  return app;
}
