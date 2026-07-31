import { z } from "zod";
import { parseRoadmapOsCommand, type RoadmapOsCommand } from "@roadmapos/github";

export const IssueLabeledPayloadSchema = z.object({
  action: z.literal("labeled"),
  label: z.object({ name: z.string() }),
  repository: z.object({ id: z.number(), name: z.string(), owner: z.object({ login: z.string() }) }),
  issue: z.object({ number: z.number().int().positive() })
});
export type IssueLabeledPayload = z.infer<typeof IssueLabeledPayloadSchema>;

export const IssueCommentPayloadSchema = z.object({
  action: z.literal("created"),
  repository: z.object({ id: z.number(), name: z.string(), owner: z.object({ login: z.string() }) }),
  issue: z.object({ number: z.number().int().positive() }),
  comment: z.object({ id: z.number(), body: z.string(), user: z.object({ id: z.number(), login: z.string() }) })
});
export type IssueCommentPayload = z.infer<typeof IssueCommentPayloadSchema>;

export interface GitHubWebhookDependencies {
  startReadyIssue(payload: IssueLabeledPayload): Promise<void>;
  routeCommand(payload: IssueCommentPayload, command: RoadmapOsCommand): Promise<void>;
}

/**
 * Turns one verified delivery into at most one supervised effect. Anything that is not a ready
 * label or a well-formed `/roadmapos` command is ignored rather than guessed at.
 */
export async function handleGitHubWebhook(
  eventName: string,
  payload: unknown,
  dependencies: GitHubWebhookDependencies,
  readyLabel: string
): Promise<void> {
  if (eventName === "issues") {
    const parsed = IssueLabeledPayloadSchema.safeParse(payload);
    if (parsed.success && parsed.data.label.name === readyLabel) {
      await dependencies.startReadyIssue(parsed.data);
    }
    return;
  }
  if (eventName === "issue_comment") {
    const parsed = IssueCommentPayloadSchema.safeParse(payload);
    if (!parsed.success) return;
    const command = parseRoadmapOsCommand(parsed.data.comment.body);
    if (command) await dependencies.routeCommand(parsed.data, command);
  }
}
