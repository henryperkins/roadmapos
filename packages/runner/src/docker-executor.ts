import { runProcess, type ProcessResult } from "./process.js";

export class DockerCommandExecutor {
  constructor(private readonly image: string) {}

  async run(workspaceRoot: string, argv: string[], timeoutSeconds: number): Promise<ProcessResult> {
    if (argv.length === 0) throw new Error("Validation argv cannot be empty");
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    return runProcess({
      executable: "docker",
      args: [
        "run", "--rm",
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "256",
        "--memory", "4g",
        "--cpus", "2",
        "--user", `${String(uid)}:${String(gid)}`,
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
        "--mount", `type=bind,source=${workspaceRoot},target=/workspace`,
        "--workdir", "/workspace",
        this.image,
        ...argv
      ],
      timeoutMs: timeoutSeconds * 1000
    });
  }
}
