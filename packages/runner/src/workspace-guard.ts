import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { runProcess } from "./process.js";

export interface GitStateExpectation {
  root: string;
  branchName: string;
  baseSha: string;
  cloneUrl: string;
}

export interface GitStateFacts {
  realRoot: string;
  branch: string;
  head: string;
  originUrl: string;
  stagedDiffSha: string;
  descendsFromBase: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({ executable: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * Resolves a path with symlinks followed and asserts it is inside `root`. Used before any
 * destructive or privileged filesystem operation, because a lexical prefix check passes for a path
 * whose parent component is a symlink pointing outside the workspace.
 */
export async function assertContainedRealPath(root: string, candidate: string): Promise<string> {
  const realRoot = await realpath(resolve(root));
  const target = await realpath(resolve(candidate)).catch(() => resolve(candidate));
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw new Error(`Path escapes the workspace: ${candidate}`);
  }
  return target;
}

/**
 * Reads the facts a privileged Git operation depends on. Validation runs on a snapshot with no
 * `.git`, but the workspace is still on shared disk, so the host verifies rather than assumes.
 */
export async function readGitState(expectation: GitStateExpectation): Promise<GitStateFacts> {
  const realRoot = await realpath(resolve(expectation.root));
  const branch = await git(realRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await git(realRoot, ["rev-parse", "HEAD"]);
  const originUrl = await git(realRoot, ["remote", "get-url", "origin"]);
  const stagedDiff = await runProcess({ executable: "git", args: ["diff", "--cached", "--binary"], cwd: realRoot, timeoutMs: 30_000 });
  const ancestry = await runProcess({ executable: "git", args: ["merge-base", "--is-ancestor", expectation.baseSha, "HEAD"], cwd: realRoot, timeoutMs: 30_000 });
  const { createHash } = await import("node:crypto");
  return {
    realRoot,
    branch,
    head,
    originUrl,
    stagedDiffSha: createHash("sha256").update(stagedDiff.stdout, "utf8").digest("hex"),
    descendsFromBase: ancestry.exitCode === 0
  };
}

/**
 * The gate every token-bearing Git operation passes. Repository-controlled validation code runs in
 * the same workspace tree, so before the host commits or pushes it re-establishes that the
 * checkout is still the one that was authorized: same real path, same remote, same branch, still
 * descended from the recorded base SHA, and the staged content still the authorized patch.
 */
export async function assertGitStateAuthorized(
  expectation: GitStateExpectation & { expectedStagedDiffSha?: string }
): Promise<GitStateFacts> {
  const facts = await readGitState(expectation);
  await assertContainedRealPath(expectation.root, facts.realRoot);
  if (facts.branch !== expectation.branchName) {
    throw new Error(`Workspace branch is ${facts.branch}, expected ${expectation.branchName}`);
  }
  if (facts.originUrl !== expectation.cloneUrl) {
    throw new Error("Workspace origin no longer points at the authorized repository");
  }
  if (!facts.descendsFromBase) {
    throw new Error(`Workspace HEAD no longer descends from the recorded base SHA ${expectation.baseSha}`);
  }
  if (expectation.expectedStagedDiffSha !== undefined && facts.stagedDiffSha !== expectation.expectedStagedDiffSha) {
    throw new Error("Staged content no longer matches the authorized patch");
  }
  return facts;
}
