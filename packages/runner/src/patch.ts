import { normalizeRepositoryPath } from "./safe-path.js";

export function affectedPathsFromPatch(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    const raw = line.slice(4).split("\t", 1)[0];
    if (!raw || raw === "/dev/null") continue;
    const withoutPrefix = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
    try {
      paths.add(normalizeRepositoryPath(withoutPrefix));
    } catch {
      throw new Error(`Unsafe patch path: ${raw}`);
    }
  }
  if (paths.size === 0) throw new Error("Patch contains no affected repository path");
  return [...paths].sort();
}
