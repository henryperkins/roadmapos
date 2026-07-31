import { spawn } from "node:child_process";

export interface ProcessResult { exitCode: number; stdout: string; stderr: string; durationMs: number }

/** Beyond this a single stream is truncated; a runaway command must not exhaust worker memory. */
export const MAX_CAPTURED_OUTPUT_BYTES = 2_000_000;

function capture(limit: number) {
  let text = "";
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: string): void {
      if (truncated) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > limit) {
        truncated = true;
        text += `\n[output truncated at ${String(limit)} bytes]`;
        return;
      }
      text += chunk;
    },
    get value(): string {
      return text;
    }
  };
}

export async function runProcess(input: {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  redactions?: string[];
  maxOutputBytes?: number;
}): Promise<ProcessResult> {
  const started = Date.now();
  const limit = input.maxOutputBytes ?? MAX_CAPTURED_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      env: input.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout kills the whole tree rather than only the direct
      // child — a validation command that forks leaves orphans otherwise.
      detached: true
    });
    const stdout = capture(limit);
    const stderr = capture(limit);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout.push(chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr.push(chunk); });

    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
    }, input.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup("SIGKILL");
      const redact = (value: string) => (input.redactions ?? []).reduce((result, secret) => secret ? result.split(secret).join("[REDACTED]") : result, value);
      const suffix = timedOut ? `\n[terminated after ${String(input.timeoutMs)} ms]` : "";
      resolve({
        exitCode: timedOut ? 124 : code ?? 137,
        stdout: redact(stdout.value),
        stderr: redact(stderr.value + suffix),
        durationMs: Date.now() - started
      });
    });
  });
}
