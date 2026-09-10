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
