import { minimatch } from "minimatch";
import type { ActionProposal } from "@roadmapos/domain";
import type { EffectivePolicy } from "./effective-policy.js";
import { PLATFORM_HARD_STOP_ACTIONS } from "./platform-hard-stops.js";

export interface ActionPolicyEvaluation {
  boundary: "none" | "repository_protected" | "platform_hard_stop";
  requiresEscalation: boolean;
  matchedRules: string[];
}

export function evaluateAction(policy: EffectivePolicy, action: ActionProposal): ActionPolicyEvaluation {
  const actionKind = (action as { kind: string }).kind;
  if (PLATFORM_HARD_STOP_ACTIONS.has(actionKind) || ![
    "read_files", "apply_patch", "run_validation", "commit_and_push", "open_draft_pr", "finish"
  ].includes(actionKind)) {
    return { boundary: "platform_hard_stop", requiresEscalation: false, matchedRules: [`platform:${actionKind}`] };
  }

  const matchedRules: string[] = [];
  if (action.kind === "apply_patch") {
    for (const path of action.affectedPaths) {
      for (const zone of policy.repository.protectedZones) {
        if (minimatch(path, zone.path, { dot: true })) matchedRules.push(`protected_zone:${zone.path}`);
      }
    }
    if (action.changesDependencies && policy.repository.dependencies.additionsRequireEscalation) {
      matchedRules.push("dependencies:additions_require_escalation");
    }
    if (action.changesPublicInterface && policy.repository.publicInterfaces.changesRequireEscalation) {
      matchedRules.push("public_interfaces:changes_require_escalation");
    }
    if (action.changesSecurityBehavior) matchedRules.push("security_behavior:agent_declared_change");
  }

  return matchedRules.length > 0
    ? { boundary: "repository_protected", requiresEscalation: true, matchedRules }
    : { boundary: "none", requiresEscalation: false, matchedRules: [] };
}
