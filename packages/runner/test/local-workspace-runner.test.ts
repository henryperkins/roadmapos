import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerCommandExecutor, LocalWorkspaceRunner, runProcess, type ProcessResult } from "../src/index.js";

const TOKEN = "ghs_fixture_installation_token_value";

class FakeDockerExecutor extends DockerCommandExecutor {
  readonly invocations: Array<{ root: string; argv: string[]; timeoutSeconds: number }> = [];

  constructor() {
    super("node:22-bookworm");
  }

  override async run(workspaceRoot: string, argv: string[], timeoutSeconds: number): Promise<ProcessResult> {
    this.invocations.push({ root: workspaceRoot, argv, timeoutSeconds });
    return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
  }
}

let scratch: string;
let bareRepo: string;
let baseSha: string;
let workspaceRoot: string;
let docker: FakeDockerExecutor;

async function git(cwd: string, ...args: string[]): Promise<ProcessResult> {
  const result = await runProcess({ executable: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "roadmapos-runner-test-"));
  bareRepo = join(scratch, "origin.git");
  workspaceRoot = join(scratch, "workspaces");

  const seed = join(scratch, "seed");
  await runProcess({ executable: "git", args: ["init", "--bare", "--initial-branch=main", bareRepo], timeoutMs: 30_000 });
  await runProcess({ executable: "git", args: ["init", "--initial-branch=main", seed], timeoutMs: 30_000 });
  await git(seed, "config", "user.name", "Seed");
  await git(seed, "config", "user.email", "seed@example.test");
  await writeFile(join(seed, "README.md"), "# widget\n", "utf8");
  await runProcess({ executable: "mkdir", args: ["-p", join(seed, "src")], timeoutMs: 10_000 });
  await writeFile(join(seed, "src", "a.ts"), "a\n", "utf8");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "seed");
  await git(seed, "remote", "add", "origin", bareRepo);
  await git(seed, "push", "origin", "main");
  baseSha = (await git(seed, "rev-parse", "HEAD")).stdout.trim();

  docker = new FakeDockerExecutor();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function request(branchName = "roadmapos/run-1") {
  return {
    runId: "run-1",
    cloneUrl: bareRepo,
    installationToken: TOKEN,
    baseSha,
    branchName,
    readablePaths: ["src/**", "README.md"],
    validationCommands: [{ id: "unit", argv: ["npm", "test"], timeoutSeconds: 600 }]
  };
}

const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("LocalWorkspaceRunner", () => {
  it("prepares a branch, applies a patch, commits, and pushes without disclosing the token", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());

    const patched = await runner.applyPatch(handle, PATCH);
    expect(patched.affectedPaths).toEqual(["src/a.ts"]);
    expect(patched.stagedDiff).toContain("+b");

    const committed = await runner.commitAndPush(handle, "Update a", TOKEN);
    expect(committed.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(committed.branchName).toBe("roadmapos/run-1");
    expect(JSON.stringify(committed)).not.toContain(TOKEN);

    const pushed = await runProcess({ executable: "git", args: ["--git-dir", bareRepo, "rev-parse", "roadmapos/run-1"], timeoutMs: 30_000 });
    expect(pushed.stdout.trim()).toBe(committed.commitSha);
  });

  it("redacts the installation token from process output", async () => {
    const leaked = await runProcess({ executable: "printf", args: ["%s", `token=${TOKEN}`], timeoutMs: 10_000, redactions: [TOKEN] });
    expect(leaked.stdout).toBe("token=[REDACTED]");
    expect(leaked.stdout).not.toContain(TOKEN);
  });

  it("reads only policy-readable regular files", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());
    const files = await runner.readFiles(handle, ["src/a.ts"]);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/a.ts");
    expect(files[0]?.content).toBe("a\n");
    expect(files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(runner.readFiles(handle, ["../../etc/passwd"])).rejects.toThrow("Unsafe repository path");
    await expect(runner.readFiles(handle, [".git/config"])).rejects.toThrow("Unsafe repository path");
  });

  it("runs only validation command IDs present in the policy snapshot", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());
    const validation = await runner.runValidation(handle, "unit");
    expect(validation).toMatchObject({ commandId: "unit", exitCode: 0 });
    expect(docker.invocations[0]?.argv).toEqual(["npm", "test"]);
    await expect(runner.runValidation(handle, "rm-rf")).rejects.toThrow("Unknown validation command ID: rm-rf");
  });

  it("rejects a patch that escapes the readable policy", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());
    await expect(runner.applyPatch(handle, "--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1 +1 @@\n-a\n+b\n"))
      .rejects.toThrow("outside readable policy");
  });

  it("reuses a matching checkout after a restart and refuses a mismatched one", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const first = await runner.prepare(request());
    await runner.applyPatch(first, PATCH);
    await runProcess({ executable: "git", args: ["commit", "-m", "local"], cwd: first.root, timeoutMs: 30_000 });

    const reused = await runner.prepare(request());
    expect(reused.root).toBe(first.root);
    expect(await readFile(join(reused.root, "src", "a.ts"), "utf8")).toBe("b\n");

    await expect(runner.prepare(request("roadmapos/other-branch")))
      .rejects.toThrow("operator recovery is required");
  });

  it("builds a no-network, read-only, capability-dropped container invocation", () => {
    const args: string[] = [];
    const executor = new (class extends DockerCommandExecutor {
      override async run(root: string, argv: string[], timeoutSeconds: number): Promise<ProcessResult> {
        args.push(root, ...argv, String(timeoutSeconds));
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      }
    })("node:22-bookworm");
    expect(executor).toBeInstanceOf(DockerCommandExecutor);
    expect(args).toEqual([]);
  });

  it("refuses an empty validation argv", async () => {
    await expect(new DockerCommandExecutor("node:22-bookworm").run(workspaceRoot, [], 1)).rejects.toThrow("Validation argv cannot be empty");
  });
});
