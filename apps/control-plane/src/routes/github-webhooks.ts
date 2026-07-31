import type { FastifyInstance } from "fastify";
import { sha256Text } from "@roadmapos/domain";
import { enqueueJob, type Database } from "@roadmapos/db";
import { verifyGitHubSignature } from "@roadmapos/github";
import type { ControlPlaneConfig } from "../config.js";

/**
 * The webhook route needs the raw request body to verify GitHub's HMAC, but the rest of the control
 * plane needs parsed JSON. Fastify scopes content-type parsers to the encapsulating plugin, so the
 * buffer parser is installed inside `register` rather than on the root instance.
 */
export async function registerGitHubWebhookRoute(app: FastifyInstance, database: Database, config: ControlPlaneConfig): Promise<void> {
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });

    scope.post("/github/webhooks", async (request, reply) => {
      const body = request.body as Buffer;
      const deliveryId = String(request.headers["x-github-delivery"] ?? "");
      const eventName = String(request.headers["x-github-event"] ?? "");
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      if (!deliveryId || !eventName || !verifyGitHubSignature(body, signature, config.githubWebhookSecret)) {
        return reply.code(401).send({ error: "invalid_webhook" });
      }
      const text = body.toString("utf8");
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        // Reject before recording the delivery so a corrected redelivery is not swallowed as a duplicate.
        return reply.code(400).send({ error: "invalid_payload" });
      }
      const payloadHash = sha256Text(text);
      const inserted = await database.sql`
        INSERT INTO github_deliveries (delivery_id, event_name, payload_hash)
        VALUES (${deliveryId}, ${eventName}, ${payloadHash})
        ON CONFLICT (delivery_id) DO NOTHING
        RETURNING delivery_id
      `;
      if (inserted.length === 0) return reply.code(202).send({ duplicate: true });
      await enqueueJob(database, "github.webhook", { deliveryId, eventName, payload });
      return reply.code(202).send({ accepted: true });
    });
  });
}
