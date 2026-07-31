import { minimatch } from "minimatch";
import { normalizeRepositoryPath } from "@roadmapos/domain";

export { normalizeRepositoryPath };

export function assertReadablePath(value: string, patterns: string[]): string {
  const normalized = normalizeRepositoryPath(value);
  if (!patterns.some((pattern) => minimatch(normalized, pattern, { dot: true }))) {
    throw new Error(`Path is outside readable policy: ${normalized}`);
  }
  return normalized;
}
