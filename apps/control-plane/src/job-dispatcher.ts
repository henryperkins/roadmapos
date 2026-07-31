import { z } from "zod";
import type { PlanService } from "./services/plan-service.js";
import type { WebhookRouter } from "./services/webhook-router.js";
import type { ActionCoordinator } from "./services/action-coordinator.js";
import type { EscalationService } from "./services/escalation-service.js";
import type { PullRequestService } from "./services/pull-request-service.js";
import { handleGitHubWebhook } from "./jobs/github-webhook-handler.js";
import { handlePlanGenerate } from "./jobs/plan-job-handler.js";
import { handleExecuteAction, handleProposeAction } from "./jobs/run-job-handler.js";

const WebhookJobPayloadSchema = z.object({
  deliveryId: z.string().min(1),
  eventName: z.string().min(1),
  payload: z.unknown()
});

const CreateEscalationPayloadSchema = z.object({ checkpointId: z.string().uuid() });
const FinalizePullRequestPayloadSchema = z.object({
  runId: z.string().uuid(),
  proposalId: z.string().uuid(),
  title: z.string().min(1).optional()
});
const ApplyRevisionPayloadSchema = z.object({ checkpointId: z.string().uuid(), operatorId: z.string().min(1) });

export interface JobDependencies {
  planService: PlanService;
  webhookRouter: WebhookRouter;
  coordinator: ActionCoordinator;
  escalationService: EscalationService;
  pullRequestService: PullRequestService;
  readyLabel: string;
}

export const DISPATCHED_JOB_TYPES = [
  "github.webhook",
  "plan.generate",
  "interactive.prompt_next",
  "run.propose_action",
  "run.execute_action",
  "run.create_escalation",
  "run.finalize_pr",
  "run.apply_revision_decision"
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
    case "run.create_escalation":
      await dependencies.escalationService.create(CreateEscalationPayloadSchema.parse(payload).checkpointId);
      return;
    case "run.finalize_pr": {
      const job = FinalizePullRequestPayloadSchema.parse(payload);
      // The model-supplied pull-request body is ignored; the body is derived from durable evidence.
      await dependencies.pullRequestService.openDraft(job.runId, job.title ?? "RoadmapOS draft change", job.proposalId);
      return;
    }
    case "run.apply_revision_decision": {
      const job = ApplyRevisionPayloadSchema.parse(payload);
      await dependencies.planService.applyRevisionDecision(job.checkpointId, job.operatorId);
      return;
    }
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}
