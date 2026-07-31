export interface ValidationCommand {
  id: string;
  argv: string[];
  timeoutSeconds: number;
}

export interface WorkspaceRequest {
  runId: string;
  cloneUrl: string;
  installationToken: string;
  baseSha: string;
  branchName: string;
  readablePaths: string[];
  validationCommands: ValidationCommand[];
}

export interface WorkspaceHandle {
  runId: string;
  root: string;
  branchName: string;
  readablePaths: string[];
  validationCommands: ValidationCommand[];
}

export interface ReadonlyFile { path: string; content: string; sha256: string }
export interface PatchResult { affectedPaths: string[]; stagedDiff: string }
export interface ValidationResult { commandId: string; exitCode: number; stdout: string; stderr: string; durationMs: number }
export interface CommitResult { commitSha: string; branchName: string }

export interface WorkspaceRunner {
  prepare(input: WorkspaceRequest): Promise<WorkspaceHandle>;
  readFiles(handle: WorkspaceHandle, paths: string[]): Promise<ReadonlyFile[]>;
  applyPatch(handle: WorkspaceHandle, patch: string): Promise<PatchResult>;
  runValidation(handle: WorkspaceHandle, commandId: string): Promise<ValidationResult>;
  commitAndPush(handle: WorkspaceHandle, message: string, installationToken: string): Promise<CommitResult>;
}
