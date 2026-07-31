import type { CommitResult, PatchResult, ReadonlyFile, ValidationResult, WorkspaceHandle, WorkspaceRequest, WorkspaceRunner } from "@roadmapos/runner";

export class FakeWorkspaceRunner implements WorkspaceRunner {
  readonly appliedPatches: string[] = [];
  readonly validations: string[] = [];
  readonly commits: string[] = [];
  readonly reads: string[][] = [];

  async prepare(input: WorkspaceRequest): Promise<WorkspaceHandle> {
    return { runId: input.runId, root: `/tmp/${input.runId}`, branchName: input.branchName, readablePaths: input.readablePaths, validationCommands: input.validationCommands };
  }

  async readFiles(_handle: WorkspaceHandle, paths: string[]): Promise<ReadonlyFile[]> {
    this.reads.push(paths);
    return paths.map((path) => ({ path, content: `fixture:${path}`, sha256: "a".repeat(64) }));
  }

  async applyPatch(_handle: WorkspaceHandle, patch: string): Promise<PatchResult> {
    this.appliedPatches.push(patch);
    return { affectedPaths: ["src/a.ts"], stagedDiff: patch };
  }

  async runValidation(_handle: WorkspaceHandle, commandId: string): Promise<ValidationResult> {
    this.validations.push(commandId);
    return { commandId, exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 };
  }

  async commitAndPush(handle: WorkspaceHandle, message: string): Promise<CommitResult> {
    this.commits.push(message);
    return { commitSha: "c".repeat(40), branchName: handle.branchName };
  }
}
