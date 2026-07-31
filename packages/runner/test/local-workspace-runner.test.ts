import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerCommandExecutor, LocalWorkspaceRunner, runProcess, type ProcessResult } from "../src/index.js";

const TOKEN = "ghs_fixture_installation_token_value";

class FakeDockerExecutor extends DockerCommandExecutor {
  readonly invocations: Array<{ root: string; argv: string[]; timeoutSeconds: number }> = [];
  /** What the container would actually have seen, captured before the snapshot is destroyed. */
  readonly snapshotContents: string[][] = [];

  constructor() {
    super("node:22-bookworm@sha256:0000000000000000000000000000000000000000000000000000000000000000");
  }

  override async run(snapshotRoot: string, argv: string[], timeoutSeconds: number): Promise<ProcessResult> {
    this.invocations.push({ root: snapshotRoot, argv, timeoutSeconds });
    const listing = await runProcess({ executable: "find", args: [snapshotRoot, "-maxdepth", "2"], timeoutMs: 10_000 });
    this.snapshotContents.push(listing.stdout.split("\n").map((line) => line.replace(`${snapshotRoot}/`, "")));
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

const RUN_ID = "4f8f8ec8-8fea-4ccf-9a12-79080e2dd0d8";

function request(branchName = `roadmapos/${RUN_ID}`) {
  return {
    runId: RUN_ID,
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
    expect(committed.branchName).toBe(`roadmapos/${RUN_ID}`);
    expect(JSON.stringify(committed)).not.toContain(TOKEN);

    const pushed = await runProcess({ executable: "git", args: ["--git-dir", bareRepo, "rev-parse", `roadmapos/${RUN_ID}`], timeoutMs: 30_000 });
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

describe("validation isolation and privileged Git guards", () => {
  it("runs validation on a source-only snapshot that has no .git", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());
    await runner.runValidation(handle, "unit");

    const invocation = docker.invocations[0];
    expect(invocation).toBeDefined();
    expect(invocation?.root).not.toBe(handle.root);
    expect(docker.snapshotContents[0]).toContain("src/a.ts");
    expect(docker.snapshotContents[0]).not.toContain(".git");
  });

  it("destroys the validation snapshot even when the command mutates it", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());
    await runner.runValidation(handle, "unit");
    const snapshotRoot = docker.invocations[0]?.root;
    expect(snapshotRoot).toBeDefined();
    await expect(readFile(join(String(snapshotRoot), "src", "a.ts"), "utf8")).rejects.toThrow();
  });

  it("refuses to push when origin has been repointed at another remote", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());
    await runner.applyPatch(handle, PATCH);
    const attacker = join(scratch, "attacker.git");
    await runProcess({ executable: "git", args: ["init", "--bare", attacker], timeoutMs: 30_000 });
    await git(handle.root, "remote", "set-url", "origin", attacker);

    await expect(runner.commitAndPush(handle, "Update a", TOKEN))
      .rejects.toThrow("origin no longer points at the authorized repository");
  });

  it("refuses to push when the branch has been switched under it", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());
    await runner.applyPatch(handle, PATCH);
    await git(handle.root, "switch", "-c", "roadmapos/not-authorized");

    await expect(runner.commitAndPush(handle, "Update a", TOKEN))
      .rejects.toThrow("Workspace branch is roadmapos/not-authorized");
  });

  it("refuses a privileged Git operation on a workspace this process never prepared", async () => {
    const prepared = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await prepared.prepare(request());
    await prepared.applyPatch(handle, PATCH);

    const restarted = new LocalWorkspaceRunner(workspaceRoot, docker);
    await expect(restarted.commitAndPush(handle, "Update a", TOKEN))
      .rejects.toThrow("refusing a privileged Git operation");
  });
});

describe("containment and process limits", () => {
  it("refuses a run identifier that is not an opaque UUID", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    await expect(runner.prepare({ ...request(), runId: "../escape" })).rejects.toThrow("not a UUID");
    await expect(runner.prepare({ ...request(), runId: "run-1/../../etc" })).rejects.toThrow("not a UUID");
  });

  it("refuses a read whose parent component is a symlink out of the workspace", async () => {
    const runner = new LocalWorkspaceRunner(workspaceRoot, docker);
    const handle = await runner.prepare(request());
    const outside = join(scratch, "outside");
    await runProcess({ executable: "mkdir", args: ["-p", outside], timeoutMs: 10_000 });
    await writeFile(join(outside, "secret.ts"), "secret\n", "utf8");
    await runProcess({ executable: "ln", args: ["-s", outside, join(handle.root, "src", "link")], timeoutMs: 10_000 });

    await expect(runner.readFiles(handle, ["src/link/secret.ts"])).rejects.toThrow("escapes the workspace");
  });

  it("bounds captured output instead of buffering without limit", async () => {
    const result = await runProcess({
      executable: "sh",
      args: ["-c", "yes roadmapos | head -c 200000"],
      timeoutMs: 30_000,
      maxOutputBytes: 4096
    });
    expect(result.stdout.length).toBeLessThan(20_000);
    expect(result.stdout).toContain("[output truncated at 4096 bytes]");
  });

  it("terminates the whole process group on timeout rather than only the direct child", async () => {
    const started = Date.now();
    const result = await runProcess({
      executable: "sh",
      args: ["-c", "sleep 30 & sleep 30"],
      timeoutMs: 700
    });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("terminated after 700 ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
