import { posix } from "node:path";
import { minimatch } from "minimatch";

export function normalizeRepositoryPath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  return normalized;
}

export function assertReadablePath(value: string, patterns: string[]): string {
  const normalized = normalizeRepositoryPath(value);
  if (!patterns.some((pattern) => minimatch(normalized, pattern, { dot: true }))) {
    throw new Error(`Path is outside readable policy: ${normalized}`);
  }
  return normalized;
}
