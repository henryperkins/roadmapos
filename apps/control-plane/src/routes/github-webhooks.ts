import type { FastifyInstance } from "fastify";
import { sha256Text } from "@roadmapos/domain";
import type { Database } from "@roadmapos/db";
import { verifyGitHubSignature } from "@roadmapos/github";
import type { ControlPlaneConfig } from "../config.js";

export type DeliveryOutcome =
  | { status: "accepted" }
  | { status: "duplicate" }
  | { status: "conflict" };

/**
 * Records the delivery and enqueues its job in one transaction.
 *
 * Two separate statements left a window where a crash after the delivery insert marked the
 * delivery permanently processed while no job existed: GitHub's redelivery would then be dismissed
 * as a duplicate and the event would be lost with no way to recover it. Committing both together
 * means a delivery is recorded only if its work is too.
 */
export async function recordDelivery(
  database: Database,
  input: { deliveryId: string; eventName: string; payloadHash: string; payload: unknown }
): Promise<DeliveryOutcome> {
  return database.sql.begin<DeliveryOutcome>(async (transaction) => {
    const inserted = await transaction<{ delivery_id: string }[]>`
      INSERT INTO github_deliveries (delivery_id, event_name, payload_hash)
      VALUES (${input.deliveryId}, ${input.eventName}, ${input.payloadHash})
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id
    `;
    if (inserted.length === 0) {
      // A repeated delivery ID carrying different content is not a duplicate; it means the ID is
      // being reused or forged, and silently discarding it would hide that.
      const [existing] = await transaction<{ payload_hash: string }[]>`
        SELECT payload_hash FROM github_deliveries WHERE delivery_id = ${input.deliveryId}
      `;
      return existing?.payload_hash === input.payloadHash ? { status: "duplicate" } : { status: "conflict" };
    }
    await transaction`
      INSERT INTO jobs (id, job_type, payload)
      VALUES (${crypto.randomUUID()}::uuid, 'github.webhook',
              ${JSON.stringify({ deliveryId: input.deliveryId, eventName: input.eventName, payload: input.payload })}::jsonb)
    `;
    return { status: "accepted" };
  });
}

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
        // Rejected before the delivery is recorded so a corrected redelivery is not swallowed.
        return reply.code(400).send({ error: "invalid_payload" });
      }
      const outcome = await recordDelivery(database, { deliveryId, eventName, payloadHash: sha256Text(text), payload });
      if (outcome.status === "duplicate") return reply.code(202).send({ duplicate: true });
      if (outcome.status === "conflict") return reply.code(409).send({ error: "delivery_id_reused_with_different_payload" });
      return reply.code(202).send({ accepted: true });
    });
  });
}
