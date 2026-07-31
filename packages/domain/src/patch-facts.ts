import { posix } from "node:path";
import { sha256Text } from "./hash.js";

/**
 * Normalizes a repository-relative path and refuses anything that leaves the repository or reaches
 * Git metadata. This is the single authoritative implementation; the policy evaluator and the
 * workspace runner both use it, so what policy judges and what git applies cannot diverge.
 */
export function normalizeRepositoryPath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  return normalized;
}

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

const DEPENDENCY_MANIFESTS = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  "requirements.txt", "pipfile", "pipfile.lock", "pyproject.toml", "poetry.lock", "setup.py", "setup.cfg",
  "go.mod", "go.sum", "cargo.toml", "cargo.lock", "gemfile", "gemfile.lock",
  "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "composer.lock", "mix.exs", "podfile", "podfile.lock"
]);

const SECURITY_SENSITIVE_SEGMENTS = ["auth", "authn", "authz", "session", "credential", "password", "secret", "token", "permission", "acl", "security", "crypto"];

function isDependencyManifest(path: string): boolean {
  const base = posix.basename(path).toLowerCase();
  return DEPENDENCY_MANIFESTS.has(base) || base.endsWith(".csproj") || base.endsWith(".fsproj");
}

function isSecuritySensitive(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.startsWith(".github/workflows/") || lower.startsWith(".github/actions/")) return true;
  if (lower === "dockerfile" || lower.startsWith("dockerfile.") || lower.endsWith("/dockerfile")) return true;
  if (posix.basename(lower).startsWith(".env")) return true;
  return SECURITY_SENSITIVE_SEGMENTS.some((segment) => lower.split(/[/._-]/).includes(segment));
}

export interface DerivedPatchFacts {
  /** Line endings normalized so the hash is stable across platforms. */
  normalizedPatch: string;
  patchSha256: string;
  affectedPaths: string[];
  touchesDependencyManifest: boolean;
  dependencyManifests: string[];
  touchesSecuritySensitivePath: boolean;
  securitySensitivePaths: string[];
}

/**
 * Reads what a patch actually does, from the patch itself. Everything a policy decision depends on
 * is derived here rather than taken from the model's description of its own change.
 */
export function derivePatchFacts(patch: string): DerivedPatchFacts {
  const normalizedPatch = patch.replaceAll("\r\n", "\n");
  const affectedPaths = affectedPathsFromPatch(normalizedPatch);
  const dependencyManifests = affectedPaths.filter(isDependencyManifest);
  const securitySensitivePaths = affectedPaths.filter(isSecuritySensitive);
  return {
    normalizedPatch,
    patchSha256: sha256Text(normalizedPatch),
    affectedPaths,
    touchesDependencyManifest: dependencyManifests.length > 0,
    dependencyManifests,
    touchesSecuritySensitivePath: securitySensitivePaths.length > 0,
    securitySensitivePaths
  };
}

export interface ClaimDiscrepancy {
  field: "affectedPaths";
  declared: string;
  derived: string;
}

export interface ClaimUnderstatement {
  field: "changesDependencies" | "changesSecurityBehavior";
  derivedEvidence: string;
}

/**
 * The set of files a patch touches is checkable and is the primary authorization input, so a
 * description that disagrees with the diff is rejected outright: a patch that declares
 * `src/parser.ts` while editing `src/auth/session.ts` never reaches an operator as if it were
 * the former.
 */
export function findClaimDiscrepancies(
  claims: { affectedPaths: string[] },
  derived: DerivedPatchFacts
): ClaimDiscrepancy[] {
  const declaredPaths = [...claims.affectedPaths].sort();
  if (declaredPaths.join(" ") === derived.affectedPaths.join(" ")) return [];
  return [{ field: "affectedPaths", declared: declaredPaths.join(", "), derived: derived.affectedPaths.join(", ") }];
}

/**
 * Where the model understated a policy-relevant effect that the diff reveals. These are not
 * rejections: a model cannot be expected to know every path pattern a repository treats as
 * sensitive. The derived fact simply wins, which can only make the resulting decision stricter,
 * and the understatement is recorded so the operator sees claim and evidence side by side.
 */
export function findClaimUnderstatements(
  claims: { changesDependencies: boolean; changesSecurityBehavior: boolean },
  derived: DerivedPatchFacts
): ClaimUnderstatement[] {
  const understatements: ClaimUnderstatement[] = [];
  if (!claims.changesDependencies && derived.touchesDependencyManifest) {
    understatements.push({ field: "changesDependencies", derivedEvidence: derived.dependencyManifests.join(", ") });
  }
  if (!claims.changesSecurityBehavior && derived.touchesSecuritySensitivePath) {
    understatements.push({ field: "changesSecurityBehavior", derivedEvidence: derived.securitySensitivePaths.join(", ") });
  }
  return understatements;
}
