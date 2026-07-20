import { sha256Canonical } from "@roadmapos/domain";
import type { RepositoryPolicy } from "./schema.js";

export interface GitHubProtectionSnapshot {
  branchProtectionEnabled: boolean;
  requiredApprovals: number;
}

export interface EffectivePolicy {
  repository: RepositoryPolicy;
  github: GitHubProtectionSnapshot;
  policyHash: string;
}

export function buildEffectivePolicy(repository: RepositoryPolicy, github: GitHubProtectionSnapshot): EffectivePolicy {
  return { repository, github, policyHash: sha256Canonical({ repository, github }) };
}
