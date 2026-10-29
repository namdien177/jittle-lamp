import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceVersion, normalizeReleaseVersion, resolveRepoPath } from "./workspace-version";

// Copies the DMG made by scripts/release/package-macos-desktop.sh to release-artifacts/ under the
// release asset name. The native app has no in-app updater, so no update metadata is published.
const version = process.argv[2] ? normalizeReleaseVersion(process.argv[2]) : getWorkspaceVersion();
const bundlePath = resolveRepoPath("apps", "desktop", "target", "bundle");
const releaseArtifactsPath = resolveRepoPath("release-artifacts");
const isSigned = process.env.JL_MACOS_SIGNED === "true";
const dmgName = `jittle-lamp-desktop-${version}-macos-arm64.dmg`;

if (!existsSync(join(bundlePath, dmgName))) {
  const found = existsSync(bundlePath) ? readdirSync(bundlePath).join(", ") || "nothing" : "no bundle directory";
  throw new Error(`Expected ${dmgName} in ${bundlePath} (found ${found}).`);
}

const releaseName = `jittle-lamp-desktop-v${version}-macos-arm64-${isSigned ? "signed" : "unsigned"}.dmg`;

mkdirSync(releaseArtifactsPath, { recursive: true });
copyFileSync(join(bundlePath, dmgName), join(releaseArtifactsPath, releaseName));

console.info(`Collected desktop release asset as ${join(releaseArtifactsPath, releaseName)}`);
