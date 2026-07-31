import { spawn } from "node:child_process";

export interface ProcessResult { exitCode: number; stdout: string; stderr: string; durationMs: number }

export async function runProcess(input: {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  redactions?: string[];
}): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      env: input.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const redact = (value: string) => (input.redactions ?? []).reduce((result, secret) => secret ? result.split(secret).join("[REDACTED]") : result, value);
      resolve({ exitCode: code ?? 137, stdout: redact(stdout), stderr: redact(stderr), durationMs: Date.now() - started });
    });
  });
}
