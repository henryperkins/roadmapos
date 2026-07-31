import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { createDatabase } from "@roadmapos/db";
import { OpenAIAgentGateway } from "@roadmapos/agent";
import { registerInternalAuth } from "./auth.js";
import { ControlPlaneConfigSchema, type ControlPlaneConfig } from "./config.js";
import { PilotRegistry } from "./pilot-registry.js";
import { registerPilotRoutes } from "./routes/pilots.js";
import { registerGitHubWebhookRoute } from "./routes/github-webhooks.js";
import { registerOperatorCheckpointRoutes } from "./routes/operator-checkpoints.js";
import { CheckpointService } from "./services/checkpoint-service.js";

/**
 * Test-only seams. Production always constructs the checkpoint service from the database, the
 * configured agent gateway, and the artifact encryption key; a test may inject a service built on
 * the deterministic fake so no provider request is made.
 */
export interface BuildAppOverrides {
  checkpointService?: CheckpointService;
}

export async function buildApp(rawConfig: ControlPlaneConfig & BuildAppOverrides) {
  const config = ControlPlaneConfigSchema.parse(rawConfig);
  const app = Fastify({ logger: false });
  await app.register(sensible);
  const database = createDatabase(config.databaseUrl);
  app.addHook("onClose", async () => database.close());
  const checkpointService = rawConfig.checkpointService
    ?? new CheckpointService(database, new OpenAIAgentGateway(process.env.OPENAI_MODEL ?? "gpt-5"), config.artifactEncryptionKeyBase64);
  await registerInternalAuth(app, database, config.adminTokenSha256);
  await registerPilotRoutes(app, new PilotRegistry(database));
  await registerOperatorCheckpointRoutes(app, database, checkpointService);
  await registerGitHubWebhookRoute(app, database, config);
  app.get("/health", async () => ({ ok: true }));
  return app;
}
