import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type VersionedPackageJson = {
  version?: string;
};

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export const versionPackageRelativePaths = [
  "package.json",
  "apps/backend/package.json",
  "apps/desktop/package.json",
  "apps/evidence-web/package.json",
  "apps/extension/package.json",
  "apps/mcp/package.json",
  "packages/shared/package.json",
  "packages/viewer-core/package.json",
  "packages/viewer-react/package.json"
] as const;

// The native desktop app's crates inherit `[workspace.package] version`; Cargo.lock records it too.
export const cargoManifestRelativePath = "apps/desktop/Cargo.toml";
export const cargoLockRelativePath = "apps/desktop/Cargo.lock";

export const versionFileRelativePaths = [
  ...versionPackageRelativePaths,
  cargoManifestRelativePath,
  cargoLockRelativePath
] as const;

export function resolveRepoPath(...segments: string[]): string {
  return join(repoRoot, ...segments);
}

export function readJsonFile<T>(relativePath: string): T {
  const absolutePath = resolveRepoPath(relativePath);
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

export function writeJsonFile(relativePath: string, value: unknown): void {
  writeFileSync(resolveRepoPath(relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

export function normalizeReleaseVersion(input: string): string {
  const normalized = input.startsWith("v") ? input.slice(1) : input;

  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Expected a semantic version like 1.2.3 or v1.2.3, received: ${input}`);
  }

  return normalized;
}

export function getWorkspaceVersion(): string {
  const packageJson = readJsonFile<VersionedPackageJson>("package.json");

  if (!packageJson.version) {
    throw new Error("Root package.json is missing a version field.");
  }

  return normalizeReleaseVersion(packageJson.version);
}

export function getPackageVersion(relativePath: (typeof versionPackageRelativePaths)[number]): string {
  const packageJson = readJsonFile<VersionedPackageJson>(relativePath);

  if (!packageJson.version) {
    throw new Error(`${relativePath} is missing a version field.`);
  }

  return normalizeReleaseVersion(packageJson.version);
}

// `version = "…"` among the lines after `[workspace.package]`, before the next table header.
const workspacePackageVersionPattern = /(^\[workspace\.package\][ \t]*\n(?:(?!\[)[^\n]*\n)*?version\s*=\s*")([^"]*)(")/m;

export function readCargoWorkspaceVersion(manifest: string): string | null {
  return workspacePackageVersionPattern.exec(manifest)?.[2] ?? null;
}

export function setCargoWorkspaceVersion(manifest: string, version: string): string {
  if (!workspacePackageVersionPattern.test(manifest)) {
    throw new Error(`${cargoManifestRelativePath} has no [workspace.package] version.`);
  }

  return manifest.replace(workspacePackageVersionPattern, `$1${version}$3`);
}

// Workspace members are the lockfile packages without a `source` (registry or git) line.
export function setCargoLockWorkspaceVersions(lock: string, version: string): string {
  return lock
    .split("\n[[package]]\n")
    .map((block) =>
      block.startsWith("name = ") && !/^source = /m.test(block)
        ? block.replace(/^version = "[^"]*"$/m, `version = "${version}"`)
        : block
    )
    .join("\n[[package]]\n");
}

export function getCargoWorkspaceVersion(): string {
  const version = readCargoWorkspaceVersion(readFileSync(resolveRepoPath(cargoManifestRelativePath), "utf8"));

  if (!version) {
    throw new Error(`${cargoManifestRelativePath} is missing a [workspace.package] version.`);
  }

  return normalizeReleaseVersion(version);
}

export function writeCargoWorkspaceVersion(version: string): void {
  const manifestPath = resolveRepoPath(cargoManifestRelativePath);
  writeFileSync(manifestPath, setCargoWorkspaceVersion(readFileSync(manifestPath, "utf8"), version));

  const lockPath = resolveRepoPath(cargoLockRelativePath);
  writeFileSync(lockPath, setCargoLockWorkspaceVersions(readFileSync(lockPath, "utf8"), version));
}
