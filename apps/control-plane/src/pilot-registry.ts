import { createHash, randomBytes, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { appendAuditEvent, internalAccessTokens, matchedPairs, participants, pilotStudies, repositories, repositoryPolicyVersions, workItems, type Database } from "@roadmapos/db";
import { sha256Canonical } from "@roadmapos/domain";
import { parseRepositoryPolicy } from "@roadmapos/policy";

export class PilotRegistry {
  constructor(private readonly database: Database) {}

  async createPilot(input: string | { id?: string; name: string }): Promise<string> {
    const name = typeof input === "string" ? input : input.name;
    const id = typeof input === "string" ? crypto.randomUUID() : input.id ?? crypto.randomUUID();
    await this.database.db.insert(pilotStudies).values({ id, name, status: "draft" });
    await appendAuditEvent(this.database, { pilotId: id, eventType: "pilot.created", actorType: "operator", actorId: "operator", payload: { name } });
    return id;
  }

  async registerParticipant(input: {
    id?: string;
    pilotId: string;
    githubUserId: string;
    githubLogin: string;
    studyRole: "maintainer" | "operator" | "auditor";
  }): Promise<string> {
    const id = input.id ?? crypto.randomUUID();
    await this.database.db.insert(participants).values({
      id,
      pilotId: input.pilotId,
      githubUserId: BigInt(input.githubUserId),
      githubLogin: input.githubLogin,
      studyRole: input.studyRole
    });
    await appendAuditEvent(this.database, {
      pilotId: input.pilotId,
      eventType: "participant.registered",
      actorType: "operator",
      actorId: "operator",
      payload: { participantId: id, githubLogin: input.githubLogin, studyRole: input.studyRole }
    });
    return id;
  }

  /**
   * Mints an internal bearer token bound to one participant. Only the SHA-256 is stored, and the
   * plaintext is returned once — there is no way to recover it or to reassign the token later.
   */
  async issueInternalToken(input: { participantId: string; pilotId: string; label: string }): Promise<{ id: string; token: string }> {
    const token = randomBytes(32).toString("base64url");
    const id = crypto.randomUUID();
    await this.database.db.insert(internalAccessTokens).values({
      id,
      participantId: input.participantId,
      tokenSha256: createHash("sha256").update(token, "utf8").digest("hex"),
      label: input.label
    });
    await appendAuditEvent(this.database, {
      pilotId: input.pilotId,
      eventType: "participant.token_issued",
      actorType: "operator",
      actorId: "operator",
      payload: { participantId: input.participantId, tokenId: id, label: input.label }
    });
    return { id, token };
  }

  async registerRepository(input: {
    id?: string; pilotId: string; githubRepositoryId: string; installationId: string; owner: string; name: string; defaultBranch: string;
  }): Promise<string> {
    const id = input.id ?? crypto.randomUUID();
    await this.database.db.insert(repositories).values({
      id,
      pilotId: input.pilotId,
      githubRepositoryId: BigInt(input.githubRepositoryId),
      installationId: BigInt(input.installationId),
      owner: input.owner,
      name: input.name,
      defaultBranch: input.defaultBranch
    });
    await appendAuditEvent(this.database, { pilotId: input.pilotId, eventType: "repository.registered", actorType: "operator", actorId: "operator", payload: { repositoryId: id, owner: input.owner, name: input.name } });
    return id;
  }

  async snapshotPolicy(input: { pilotId: string; repositoryId: string; sourceCommitSha: string; source: string; actorId: string }) {
    const policy = parseRepositoryPolicy(input.source);
    const policyHash = sha256Canonical(policy);
    const id = crypto.randomUUID();
    await this.database.db.insert(repositoryPolicyVersions).values({ id, repositoryId: input.repositoryId, sourceCommitSha: input.sourceCommitSha, policyJson: policy, policyHash, createdBy: input.actorId });
    await appendAuditEvent(this.database, { pilotId: input.pilotId, eventType: "policy.snapshotted", actorType: "operator", actorId: input.actorId, payload: { repositoryId: input.repositoryId, policyVersionId: id, policyHash } });
    return { id, policyHash, policy };
  }

  async createMatchedPair(input: {
    pairId?: string;
    itemAId?: string;
    itemBId?: string;
    pilotId: string;
    repositoryId: string;
    governanceBearing: boolean;
    matchingRecord: unknown;
    itemA: { issueNumber: number; nodeId: string; title: string; acceptanceCriteria: string[]; effortBand: string; governanceExposure: string };
    itemB: { issueNumber: number; nodeId: string; title: string; acceptanceCriteria: string[]; effortBand: string; governanceExposure: string };
  }): Promise<string> {
    const itemAId = input.itemAId ?? crypto.randomUUID();
    const itemBId = input.itemBId ?? crypto.randomUUID();
    const pairId = input.pairId ?? crypto.randomUUID();
    await this.database.db.transaction(async (transaction) => {
      await transaction.insert(workItems).values([
        { id: itemAId, repositoryId: input.repositoryId, githubIssueNumber: input.itemA.issueNumber, githubIssueNodeId: input.itemA.nodeId, title: input.itemA.title, acceptanceCriteria: input.itemA.acceptanceCriteria, expectedEffortBand: input.itemA.effortBand, expectedGovernanceExposure: input.itemA.governanceExposure },
        { id: itemBId, repositoryId: input.repositoryId, githubIssueNumber: input.itemB.issueNumber, githubIssueNodeId: input.itemB.nodeId, title: input.itemB.title, acceptanceCriteria: input.itemB.acceptanceCriteria, expectedEffortBand: input.itemB.effortBand, expectedGovernanceExposure: input.itemB.governanceExposure }
      ]);
      await transaction.insert(matchedPairs).values({ id: pairId, pilotId: input.pilotId, repositoryId: input.repositoryId, workItemAId: itemAId, workItemBId: itemBId, governanceBearing: input.governanceBearing, matchingRecord: input.matchingRecord });
    });
    return pairId;
  }

  async assignPair(
    pairId: string,
    conditionDraw: () => number = () => randomInt(2),
    orderTieBreakDraw: () => number = () => randomInt(2)
  ) {
    const result = await this.database.db.transaction(async (transaction) => {
      const [pair] = await transaction.select().from(matchedPairs).where(eq(matchedPairs.id, pairId)).for("update");
      if (!pair) throw new Error("Pair not found");
      if (pair.assignedAt) throw new Error("Pair is already assigned");

      const prior = await transaction.select({ assignmentRecord: matchedPairs.assignmentRecord })
        .from(matchedPairs)
        .where(eq(matchedPairs.pilotId, pair.pilotId));
      const firstCounts = prior.reduce((counts, row) => {
        const record = row.assignmentRecord as { firstCondition?: "governed_orchestration" | "interactive_copilot" } | null;
        if (record?.firstCondition) counts[record.firstCondition] += 1;
        return counts;
      }, { governed_orchestration: 0, interactive_copilot: 0 });

      const orderTieBreakValue = firstCounts.governed_orchestration === firstCounts.interactive_copilot
        ? orderTieBreakDraw()
        : null;
      if (orderTieBreakValue !== null && orderTieBreakValue !== 0 && orderTieBreakValue !== 1) {
        throw new Error("Order tie-break draw must be 0 or 1");
      }
      const firstCondition = firstCounts.governed_orchestration < firstCounts.interactive_copilot
        ? "governed_orchestration"
        : firstCounts.interactive_copilot < firstCounts.governed_orchestration
          ? "interactive_copilot"
          : orderTieBreakValue === 0 ? "governed_orchestration" : "interactive_copilot";

      const conditionDrawValue = conditionDraw();
      if (conditionDrawValue !== 0 && conditionDrawValue !== 1) throw new Error("Condition draw must be 0 or 1");
      const itemACondition = conditionDrawValue === 0 ? "governed_orchestration" : "interactive_copilot";
      const itemBCondition = itemACondition === "governed_orchestration" ? "interactive_copilot" : "governed_orchestration";
      const record = {
        conditionDraw: conditionDrawValue,
        orderTieBreakDraw: orderTieBreakValue,
        orderAllocation: firstCounts.governed_orchestration === firstCounts.interactive_copilot ? "random_tie_break" : "blocked_balance",
        itemACondition,
        itemBCondition,
        firstCondition,
        itemAOrder: itemACondition === firstCondition ? 1 : 2,
        itemBOrder: itemBCondition === firstCondition ? 1 : 2,
        assignedAt: new Date().toISOString()
      } as const;
      const assignmentHash = sha256Canonical(record);
      await transaction.update(workItems).set({ condition: record.itemACondition, executionOrder: record.itemAOrder }).where(eq(workItems.id, pair.workItemAId));
      await transaction.update(workItems).set({ condition: record.itemBCondition, executionOrder: record.itemBOrder }).where(eq(workItems.id, pair.workItemBId));
      await transaction.update(matchedPairs).set({ assignmentRecord: record, assignmentHash, assignedAt: new Date(record.assignedAt) }).where(eq(matchedPairs.id, pairId));
      return { pilotId: pair.pilotId, ...record, assignmentHash };
    });
    await appendAuditEvent(this.database, { pilotId: result.pilotId, eventType: "pair.assigned", actorType: "system", actorId: "assignment-service", payload: { pairId, assignmentHash: result.assignmentHash, firstCondition: result.firstCondition } });
    const { pilotId: _pilotId, ...publicResult } = result;
    return publicResult;
  }

  async createFixturePair() {
    const pilotId = await this.createPilot({ name: "fixture" });
    const repositoryId = await this.registerRepository({ pilotId, githubRepositoryId: "1", installationId: "2", owner: "acme", name: `fixture-${crypto.randomUUID()}`, defaultBranch: "main" });
    const pairId = await this.createMatchedPair({
      pilotId,
      repositoryId,
      governanceBearing: true,
      matchingRecord: { expectedComplexity: "low" },
      itemA: { issueNumber: 1, nodeId: "I_1", title: "A", acceptanceCriteria: ["A passes"], effortBand: "30_to_60", governanceExposure: "protected test fixture" },
      itemB: { issueNumber: 2, nodeId: "I_2", title: "B", acceptanceCriteria: ["B passes"], effortBand: "30_to_60", governanceExposure: "protected test fixture" }
    });
    return { pilotId, repositoryId, pairId };
  }
}
