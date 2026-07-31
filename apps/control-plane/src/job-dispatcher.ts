import { z } from "zod";
import type { PlanService } from "./services/plan-service.js";
import type { WebhookRouter } from "./services/webhook-router.js";
import type { ActionCoordinator } from "./services/action-coordinator.js";
import { handleGitHubWebhook } from "./jobs/github-webhook-handler.js";
import { handlePlanGenerate } from "./jobs/plan-job-handler.js";
import { handleExecuteAction, handleProposeAction } from "./jobs/run-job-handler.js";

const WebhookJobPayloadSchema = z.object({
  deliveryId: z.string().min(1),
  eventName: z.string().min(1),
  payload: z.unknown()
});

export interface JobDependencies {
  planService: PlanService;
  webhookRouter: WebhookRouter;
  coordinator: ActionCoordinator;
  readyLabel: string;
}

export const DISPATCHED_JOB_TYPES = [
  "github.webhook",
  "plan.generate",
  "interactive.prompt_next",
  "run.propose_action",
  "run.execute_action"
];

export async function dispatchJob(jobType: string, payload: unknown, dependencies: JobDependencies): Promise<void> {
  switch (jobType) {
    case "github.webhook": {
      const job = WebhookJobPayloadSchema.parse(payload);
      await handleGitHubWebhook(job.eventName, job.payload, dependencies.webhookRouter, dependencies.readyLabel);
      return;
    }
    case "plan.generate":
      await handlePlanGenerate(payload, dependencies.planService);
      return;
    case "interactive.prompt_next":
      // An interactive run waits for the maintainer's first `/roadmapos next`; the job exists so the
      // bootstrap path is symmetric across conditions and observable in the queue.
      return;
    case "run.propose_action":
      await handleProposeAction(payload, dependencies.coordinator);
      return;
    case "run.execute_action":
      await handleExecuteAction(payload, dependencies.coordinator);
      return;
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}
