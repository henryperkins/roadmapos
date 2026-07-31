import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { sha256Text } from "@roadmapos/domain";
import { affectedPathsFromPatch } from "./patch.js";
import { runProcess } from "./process.js";
import { assertReadablePath } from "./safe-path.js";
import type { CommitResult, PatchResult, ReadonlyFile, ValidationResult, WorkspaceHandle, WorkspaceRequest, WorkspaceRunner } from "./types.js";
import type { DockerCommandExecutor } from "./docker-executor.js";
import { assertContainedRealPath, assertGitStateAuthorized, readGitState } from "./workspace-guard.js";

/**
 * Hands git a token through a single-use askpass helper. The token never reaches argv, a remote
 * URL, or the process environment of anything but git itself, and the helper is deleted afterwards.
 */
async function withGitCredential<T>(token: string, operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "roadmapos-askpass-"));
  const script = join(directory, "askpass.sh");
  await writeFile(script, '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "x-access-token" ;; *) printf "%s" "$ROADMAPOS_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
  await chmod(script, 0o700);
  try {
    return await operation({ ...process.env, GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: "0", ROADMAPOS_GIT_TOKEN: token });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class LocalWorkspaceRunner implements WorkspaceRunner {
  /** Set by prepare(), so a later privileged Git operation can re-verify what it was authorized on. */
  private readonly expectations = new Map<string, { cloneUrl: string; baseSha: string; branchName: string }>();

  constructor(private readonly root: string, private readonly docker: DockerCommandExecutor) {}

  async prepare(input: WorkspaceRequest): Promise<WorkspaceHandle> {
    // Opaque, strictly-parsed identifier: `resolve(root, runId)` with an unvalidated runId can
    // escape the workspace root, and this path is about to be recursively deleted.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.runId)) {
      throw new Error(`Run identifier is not a UUID: ${input.runId}`);
    }
    const workspace = resolve(this.root, input.runId);
    if (workspace !== join(resolve(this.root), input.runId)) {
      throw new Error(`Workspace path escapes the runner root: ${input.runId}`);
    }
    const handle: WorkspaceHandle = {
      runId: input.runId,
      root: workspace,
      branchName: input.branchName,
      readablePaths: input.readablePaths,
      validationCommands: input.validationCommands
    };

    if (await directoryExists(join(workspace, ".git"))) {
      // A checkout survived a worker restart. Recovering it is only safe when it still holds the
      // same branch and descends from the recorded base SHA; otherwise it is evidence, not scratch
      // space, and must not be silently discarded.
      const branch = await runProcess({ executable: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: workspace, timeoutMs: 10_000 });
      const ancestry = await runProcess({ executable: "git", args: ["merge-base", "--is-ancestor", input.baseSha, "HEAD"], cwd: workspace, timeoutMs: 10_000 });
      if (branch.exitCode === 0 && branch.stdout.trim() === input.branchName && ancestry.exitCode === 0) {
        this.expectations.set(input.runId, { cloneUrl: input.cloneUrl, baseSha: input.baseSha, branchName: input.branchName });
        return handle;
      }
      throw new Error(
        `Existing workspace for run ${input.runId} does not match branch ${input.branchName} at base ${input.baseSha}; operator recovery is required`
      );
    }

    // Asserted before a recursive delete: a symlinked component would otherwise let the delete
    // reach outside the runner root entirely.
    if (await pathExists(workspace)) await assertContainedRealPath(this.root, workspace);
    await rm(workspace, { recursive: true, force: true });
    await withGitCredential(input.installationToken, async (env) => {
      const clone = await runProcess({ executable: "git", args: ["clone", "--no-checkout", input.cloneUrl, workspace], env, timeoutMs: 120_000, redactions: [input.installationToken] });
      if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr}`);
    });
    const checkout = await runProcess({ executable: "git", args: ["checkout", "--detach", input.baseSha], cwd: workspace, timeoutMs: 60_000 });
    if (checkout.exitCode !== 0) throw new Error(`git checkout failed: ${checkout.stderr}`);
    const branch = await runProcess({ executable: "git", args: ["switch", "-c", input.branchName], cwd: workspace, timeoutMs: 60_000 });
    if (branch.exitCode !== 0) throw new Error(`git branch failed: ${branch.stderr}`);
    await runProcess({ executable: "git", args: ["config", "user.name", "RoadmapOS Bot"], cwd: workspace, timeoutMs: 10_000 });
    await runProcess({ executable: "git", args: ["config", "user.email", "roadmapos-bot@users.noreply.github.com"], cwd: workspace, timeoutMs: 10_000 });
    this.expectations.set(input.runId, { cloneUrl: input.cloneUrl, baseSha: input.baseSha, branchName: input.branchName });
    return handle;
  }

  async readFiles(handle: WorkspaceHandle, paths: string[]): Promise<ReadonlyFile[]> {
    const result: ReadonlyFile[] = [];
    for (const candidate of paths) {
      const path = assertReadablePath(candidate, handle.readablePaths);
      const absolute = resolve(handle.root, path);
      // Every component is resolved, not just the leaf: a lexical prefix check passes for
      // `src/link/secret` where `src/link` is a symlink pointing out of the workspace.
      await assertContainedRealPath(handle.root, absolute);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Path is not a regular file: ${path}`);
      if (stat.size > 200_000) throw new Error(`File exceeds 200 KB: ${path}`);
      const content = await readFile(absolute, "utf8");
      result.push({ path, content, sha256: sha256Text(content) });
    }
    return result;
  }

  async applyPatch(handle: WorkspaceHandle, patch: string): Promise<PatchResult> {
    const affectedPaths = affectedPathsFromPatch(patch);
    for (const path of affectedPaths) assertReadablePath(path, handle.readablePaths);
    const patchFile = join(handle.root, `.roadmapos-${crypto.randomUUID()}.patch`);
    await writeFile(patchFile, patch, "utf8");
    try {
      const check = await runProcess({ executable: "git", args: ["apply", "--check", patchFile], cwd: handle.root, timeoutMs: 30_000 });
      if (check.exitCode !== 0) throw new Error(`Patch check failed: ${check.stderr}`);
      const apply = await runProcess({ executable: "git", args: ["apply", "--index", patchFile], cwd: handle.root, timeoutMs: 30_000 });
      if (apply.exitCode !== 0) throw new Error(`Patch apply failed: ${apply.stderr}`);
      const diff = await runProcess({ executable: "git", args: ["diff", "--cached", "--binary"], cwd: handle.root, timeoutMs: 30_000 });
      return { affectedPaths, stagedDiff: diff.stdout };
    } finally {
      await rm(patchFile, { force: true });
    }
  }

  /**
   * Validation runs on a disposable source-only snapshot. `git worktree`/`checkout-index` writes
   * the tracked content without `.git`, so repository-controlled build and test code cannot reach
   * the remote configuration, refs or index that the later token-bearing push depends on. The
   * snapshot is destroyed afterwards whatever the command did to it.
   */
  async runValidation(handle: WorkspaceHandle, commandId: string): Promise<ValidationResult> {
    const command = handle.validationCommands.find((candidate) => candidate.id === commandId);
    if (!command) throw new Error(`Unknown validation command ID: ${commandId}`);
    const snapshot = await mkdtemp(join(tmpdir(), "roadmapos-validate-"));
    try {
      const exported = await runProcess({
        executable: "git",
        args: ["checkout-index", "--all", "--force", `--prefix=${snapshot}${sep}`],
        cwd: handle.root,
        timeoutMs: 120_000
      });
      if (exported.exitCode !== 0) throw new Error(`Unable to export a validation snapshot: ${exported.stderr}`);
      if (await pathExists(join(snapshot, ".git"))) throw new Error("Validation snapshot unexpectedly contains .git");
      const result = await this.docker.run(snapshot, command.argv, command.timeoutSeconds);
      return { commandId, ...result };
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
  }

  async commitAndPush(handle: WorkspaceHandle, message: string, installationToken: string): Promise<CommitResult> {
    const expectation = this.expectations.get(handle.runId);
    if (!expectation) throw new Error("Workspace was not prepared in this process; refusing a privileged Git operation");
    // Re-establish, immediately before the token is used, that this is still the authorized
    // checkout: same real path, same origin, same branch, still descended from the base SHA.
    const facts = await assertGitStateAuthorized({
      root: handle.root,
      branchName: expectation.branchName,
      baseSha: expectation.baseSha,
      cloneUrl: expectation.cloneUrl
    });
    const commit = await runProcess({ executable: "git", args: ["commit", "-m", message], cwd: facts.realRoot, timeoutMs: 60_000 });
    if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
    const after = await readGitState({ root: facts.realRoot, branchName: expectation.branchName, baseSha: expectation.baseSha, cloneUrl: expectation.cloneUrl });
    if (after.originUrl !== expectation.cloneUrl) throw new Error("Workspace origin changed during the commit");
    await withGitCredential(installationToken, async (env) => {
      // The push target and refspec are constructed by the host from the authorized values, never
      // read back from whatever `origin` currently happens to be.
      const push = await runProcess({
        executable: "git",
        args: ["push", "--set-upstream", expectation.cloneUrl, `refs/heads/${expectation.branchName}:refs/heads/${expectation.branchName}`],
        cwd: facts.realRoot,
        env,
        timeoutMs: 120_000,
        redactions: [installationToken]
      });
      if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);
    });
    return { commitSha: after.head, branchName: expectation.branchName };
  }
}
