import { minimatch } from "minimatch";
import { derivePatchFacts, findClaimDiscrepancies, findClaimUnderstatements, type ActionProposal, type ClaimUnderstatement, type DerivedPatchFacts } from "@roadmapos/domain";
import type { EffectivePolicy } from "./effective-policy.js";
import { PLATFORM_HARD_STOP_ACTIONS } from "./platform-hard-stops.js";

export interface ActionPolicyEvaluation {
  boundary: "none" | "repository_protected" | "platform_hard_stop";
  requiresEscalation: boolean;
  matchedRules: string[];
}

/** The authoritative record a checkpoint is frozen over: derived facts, not model description. */
export interface AuthoritativeActionRecord {
  action: ActionProposal;
  derived: DerivedPatchFacts | null;
  understatements: ClaimUnderstatement[];
  evaluation: ActionPolicyEvaluation;
}

export class ClaimDiscrepancyError extends Error {
  constructor(readonly discrepancies: ReturnType<typeof findClaimDiscrepancies>) {
    super(
      `The proposed patch does not match its own description: ${discrepancies
        .map((item) => `${item.field} declared "${item.declared}" but the diff shows "${item.derived}"`)
        .join("; ")}`
    );
    this.name = "ClaimDiscrepancyError";
  }
}

/**
 * Builds the record a governance checkpoint is frozen over.
 *
 * For a patch this parses the diff, rejects any description that disagrees with it, and evaluates
 * policy against the derived paths and effects. The model's account of its own change is evidence
 * for the operator to read; it is never the input that decides whether a boundary was crossed.
 */
export function buildAuthoritativeAction(policy: EffectivePolicy, action: ActionProposal): AuthoritativeActionRecord {
  if (action.kind !== "apply_patch") {
    return { action, derived: null, understatements: [], evaluation: evaluateAction(policy, action) };
  }
  const derived = derivePatchFacts(action.patch);
  const discrepancies = findClaimDiscrepancies(action, derived);
  if (discrepancies.length > 0) throw new ClaimDiscrepancyError(discrepancies);
  const authoritative: ActionProposal = {
    ...action,
    patch: derived.normalizedPatch,
    affectedPaths: derived.affectedPaths,
    // Effect claims may only escalate: a declared `true` stands, and a declared `false` is
    // overridden when the diff itself shows otherwise.
    changesDependencies: action.changesDependencies || derived.touchesDependencyManifest,
    changesSecurityBehavior: action.changesSecurityBehavior || derived.touchesSecuritySensitivePath
  };
  return { action: authoritative, derived, understatements: findClaimUnderstatements(action, derived), evaluation: evaluateAction(policy, authoritative) };
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
