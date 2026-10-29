import {
  getWorkspaceVersion,
  normalizeReleaseVersion,
  readJsonFile,
  versionPackageRelativePaths,
  writeCargoWorkspaceVersion,
  writeJsonFile
} from "./workspace-version";

type VersionedPackageJson = {
  version: string;
  [key: string]: unknown;
};

const rawVersion = process.argv[2];

if (!rawVersion) {
  console.error("Usage: bun run release:set-version <version>");
  process.exit(1);
}

const nextVersion = normalizeReleaseVersion(rawVersion);
const currentVersion = getWorkspaceVersion();

for (const relativePath of versionPackageRelativePaths) {
  const packageJson = readJsonFile<VersionedPackageJson>(relativePath);
  writeJsonFile(relativePath, {
    ...packageJson,
    version: nextVersion
  });
}

writeCargoWorkspaceVersion(nextVersion);

console.info(`Updated workspace package versions from ${currentVersion} to ${nextVersion}.`);
console.info("Run `bun install` before committing so bun.lock stays in sync with the version bump.");
