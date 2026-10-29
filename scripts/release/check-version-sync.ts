import { extensionManifest } from "../../apps/extension/scripts/manifest";
import {
  cargoManifestRelativePath,
  getCargoWorkspaceVersion,
  getPackageVersion,
  getWorkspaceVersion,
  normalizeReleaseVersion,
  versionPackageRelativePaths
} from "./workspace-version";

const requestedVersion = process.argv[2] ? normalizeReleaseVersion(process.argv[2]) : null;
const workspaceVersion = getWorkspaceVersion();

const mismatches = versionPackageRelativePaths.flatMap((relativePath) => {
  const packageVersion = getPackageVersion(relativePath);
  return packageVersion === workspaceVersion
    ? []
    : [`${relativePath} has ${packageVersion}, expected ${workspaceVersion}`];
});

const cargoVersion = getCargoWorkspaceVersion();
if (cargoVersion !== workspaceVersion) {
  mismatches.push(`${cargoManifestRelativePath} [workspace.package] has ${cargoVersion}, expected ${workspaceVersion}`);
}

if (extensionManifest.version !== workspaceVersion) {
  mismatches.push(
    `apps/extension/scripts/manifest.ts resolves version ${extensionManifest.version}, expected ${workspaceVersion}`
  );
}

if (requestedVersion && requestedVersion !== workspaceVersion) {
  mismatches.push(`release input expects ${requestedVersion}, but root package.json is ${workspaceVersion}`);
}

if (mismatches.length > 0) {
  console.error("Version sync check failed:\n");
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.info(`All release versions are aligned at ${workspaceVersion}.`);
