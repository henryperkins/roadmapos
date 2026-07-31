import { z } from "zod";

export const RoadmapOsCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve_plan"), version: z.number().int().positive(), hashPrefix: z.string().regex(/^[a-f0-9]{12,64}$/) }),
  z.object({ kind: z.literal("revise_plan"), feedback: z.string().min(1) }),
  z.object({ kind: z.literal("next_action") }),
  z.object({ kind: z.literal("authorize_action"), proposalId: z.string().uuid() }),
  z.object({ kind: z.literal("approve_escalation"), version: z.number().int().positive(), hashPrefix: z.string().regex(/^[a-f0-9]{12,64}$/) }),
  z.object({ kind: z.literal("reject_escalation"), version: z.number().int().positive() }),
  z.object({ kind: z.literal("review_ready") }),
  z.object({ kind: z.literal("terminate"), reason: z.string().min(1) })
]);
export type RoadmapOsCommand = z.infer<typeof RoadmapOsCommandSchema>;

export function parseRoadmapOsCommand(body: string): RoadmapOsCommand | null {
  const line = body.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!line?.startsWith("/roadmapos")) return null;
  const parts = line.split(/\s+/);
  const verb = parts[1];
  let value: unknown;
  if (verb === "approve-plan" && parts.length === 4) value = { kind: "approve_plan", version: Number(parts[2]), hashPrefix: parts[3] };
  else if (verb === "revise-plan" && parts.length >= 3) value = { kind: "revise_plan", feedback: parts.slice(2).join(" ") };
  else if (verb === "next" && parts.length === 2) value = { kind: "next_action" };
  else if (verb === "do" && parts.length === 3) value = { kind: "authorize_action", proposalId: parts[2] };
  else if (verb === "approve-escalation" && parts.length === 4) value = { kind: "approve_escalation", version: Number(parts[2]), hashPrefix: parts[3] };
  else if (verb === "reject-escalation" && parts.length === 3) value = { kind: "reject_escalation", version: Number(parts[2]) };
  else if (verb === "review-ready" && parts.length === 2) value = { kind: "review_ready" };
  else if (verb === "terminate" && parts.length >= 3) value = { kind: "terminate", reason: parts.slice(2).join(" ") };
  else throw new Error("Invalid RoadmapOS command");
  return RoadmapOsCommandSchema.parse(value);
}
