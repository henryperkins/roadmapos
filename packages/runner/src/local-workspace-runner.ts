import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Text } from "@roadmapos/domain";
import { affectedPathsFromPatch } from "./patch.js";
import { runProcess } from "./process.js";
import { assertReadablePath } from "./safe-path.js";
import type { CommitResult, PatchResult, ReadonlyFile, ValidationResult, WorkspaceHandle, WorkspaceRequest, WorkspaceRunner } from "./types.js";
import type { DockerCommandExecutor } from "./docker-executor.js";

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

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class LocalWorkspaceRunner implements WorkspaceRunner {
  constructor(private readonly root: string, private readonly docker: DockerCommandExecutor) {}

  async prepare(input: WorkspaceRequest): Promise<WorkspaceHandle> {
    const workspace = resolve(this.root, input.runId);
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
        return handle;
      }
      throw new Error(
        `Existing workspace for run ${input.runId} does not match branch ${input.branchName} at base ${input.baseSha}; operator recovery is required`
      );
    }

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
    return handle;
  }

  async readFiles(handle: WorkspaceHandle, paths: string[]): Promise<ReadonlyFile[]> {
    const result: ReadonlyFile[] = [];
    for (const candidate of paths) {
      const path = assertReadablePath(candidate, handle.readablePaths);
      const absolute = resolve(handle.root, path);
      if (!absolute.startsWith(`${resolve(handle.root)}/`)) throw new Error(`Unsafe absolute path: ${path}`);
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

  async runValidation(handle: WorkspaceHandle, commandId: string): Promise<ValidationResult> {
    const command = handle.validationCommands.find((candidate) => candidate.id === commandId);
    if (!command) throw new Error(`Unknown validation command ID: ${commandId}`);
    const result = await this.docker.run(handle.root, command.argv, command.timeoutSeconds);
    return { commandId, ...result };
  }

  async commitAndPush(handle: WorkspaceHandle, message: string, installationToken: string): Promise<CommitResult> {
    const commit = await runProcess({ executable: "git", args: ["commit", "-m", message], cwd: handle.root, timeoutMs: 60_000 });
    if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
    const sha = await runProcess({ executable: "git", args: ["rev-parse", "HEAD"], cwd: handle.root, timeoutMs: 10_000 });
    await withGitCredential(installationToken, async (env) => {
      const push = await runProcess({ executable: "git", args: ["push", "--set-upstream", "origin", handle.branchName], cwd: handle.root, env, timeoutMs: 120_000, redactions: [installationToken] });
      if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);
    });
    return { commitSha: sha.stdout.trim(), branchName: handle.branchName };
  }
}
