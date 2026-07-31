import { runProcess, type ProcessResult } from "./process.js";

export class DockerCommandExecutor {
  /**
   * `image` should be digest-pinned (name@sha256:...). A mutable tag lets the contents of the
   * validation environment change between two runs that the pilot reports as comparable.
   */
  constructor(private readonly image: string) {
    if (!image.includes("@sha256:")) {
      // Not fatal in development, but the pilot's comparability claim depends on it.
      process.emitWarning(`RoadmapOS validation image ${image} is not digest-pinned`, "RoadmapOSConfigWarning");
    }
  }

  /**
   * `snapshotRoot` must be a source-only copy with no `.git`. The bind mount is read-write so
   * validation can build, but it must never reach repository metadata: the host later commits and
   * pushes from the real checkout with an installation token, and anything the container could
   * write into `.git` — config, refs, the index — would steer that privileged operation.
   */
  async run(snapshotRoot: string, argv: string[], timeoutSeconds: number): Promise<ProcessResult> {
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
        "--mount", `type=bind,source=${snapshotRoot},target=/workspace`,
        "--workdir", "/workspace",
        this.image,
        ...argv
      ],
      timeoutMs: timeoutSeconds * 1000
    });
  }
}
