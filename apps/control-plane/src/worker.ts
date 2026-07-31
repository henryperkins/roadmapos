import { createDatabase, claimNextJob, completeJob, failJob } from "@roadmapos/db";
import { OctokitGitHubGateway } from "@roadmapos/github";
import { OpenAIAgentGateway } from "@roadmapos/agent";
import { DockerCommandExecutor, LocalWorkspaceRunner } from "@roadmapos/runner";
import { configFromEnv } from "./config.js";
import { DISPATCHED_JOB_TYPES, dispatchJob } from "./job-dispatcher.js";
import { PlanService } from "./services/plan-service.js";
import { ApprovalService } from "./services/approval-service.js";
import { RunBootstrapService } from "./services/run-bootstrap-service.js";
import { WebhookRouter } from "./services/webhook-router.js";
import { CheckpointService } from "./services/checkpoint-service.js";
import { ActionCoordinator } from "./services/action-coordinator.js";
import { WorkspaceService } from "./services/workspace-service.js";

const config = configFromEnv();
const database = createDatabase(config.databaseUrl);
const workerId = `worker-${String(process.pid)}`;

const github = new OctokitGitHubGateway(
  config.githubAppId,
  Buffer.from(config.githubPrivateKeyBase64, "base64").toString("utf8")
);
const agent = new OpenAIAgentGateway(process.env.OPENAI_MODEL ?? "gpt-5");
const runner = new LocalWorkspaceRunner(
  process.env.WORKSPACE_ROOT ?? "/tmp/roadmapos-workspaces",
  new DockerCommandExecutor(process.env.RUNNER_DOCKER_IMAGE ?? "node:22-bookworm")
);
const approvalService = new ApprovalService(database, github);
const checkpointService = new CheckpointService(database, agent, config.artifactEncryptionKeyBase64);
const coordinator = new ActionCoordinator(
  database,
  agent,
  checkpointService,
  runner,
  github,
  config.publicBaseUrl,
  new WorkspaceService(database, github, runner),
  approvalService
);
const dependencies = {
  planService: new PlanService(database, agent, github),
  webhookRouter: new WebhookRouter(database, new RunBootstrapService(database, github), approvalService, coordinator),
  coordinator,
  readyLabel: config.githubReadyLabel
};

for (;;) {
  const job = await claimNextJob(database, workerId, [...DISPATCHED_JOB_TYPES, "fixture"]);
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    continue;
  }
  try {
    if (job.jobType !== "fixture") await dispatchJob(job.jobType, job.payload, dependencies);
    await completeJob(database, job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failJob(database, job.id, message, job.attempt < job.maxAttempts ? new Date(Date.now() + 1_000) : null);
  }
}
