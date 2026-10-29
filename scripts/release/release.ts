import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  getWorkspaceVersion,
  normalizeReleaseVersion,
  resolveRepoPath,
  versionFileRelativePaths
} from "./workspace-version";

type ReleaseIncrement = "patch" | "minor" | "major";

const rawVersion = process.argv[2];

const currentVersion = getWorkspaceVersion();

assertCleanWorkingTree();
assertMainBranch();

run("git", ["fetch", "origin", "main", "--tags"]);
assertMainMatchesOrigin();

const nextVersion = rawVersion ? normalizeReleaseVersion(rawVersion) : await promptForReleaseVersion();
const tagName = `v${nextVersion}`;

if (nextVersion === currentVersion) {
  fail(`Workspace is already at ${nextVersion}.`);
}

assertTagDoesNotExist(tagName);

run("bun", ["run", "release:set-version", nextVersion]);
run("bun", ["install"]);
run("bun", ["run", "release:check-version", tagName]);

const releaseFiles = [...versionFileRelativePaths, "bun.lock"].filter((relativePath) =>
  existsSync(resolveRepoPath(relativePath))
);

run("git", ["add", ...releaseFiles]);

if (!hasStagedChanges()) {
  fail("Release version bump did not create any staged changes.");
}

run("git", ["commit", "-m", `release: ${tagName}`]);
run("git", ["push", "origin", "main"]);
run("git", ["tag", tagName]);
run("git", ["push", "origin", tagName]);

console.info(`Created and pushed ${tagName}. The release workflow will build and publish the GitHub release.`);

async function promptForReleaseVersion(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Usage: bun run release <version>");
  }

  const latestTagVersion = getLatestReleaseTagVersion();
  const patchVersion = bumpVersion(latestTagVersion, "patch");
  const minorVersion = bumpVersion(latestTagVersion, "minor");
  const majorVersion = bumpVersion(latestTagVersion, "major");
  const rl = createInterface({ input, output });

  try {
    console.info(`Latest release tag: v${latestTagVersion}`);
    console.info("Select release version:");
    console.info(`1. bump patch  -> v${patchVersion}`);
    console.info(`2. bump minor  -> v${minorVersion}`);
    console.info(`3. bump major  -> v${majorVersion}`);
    console.info("4. custom");

    while (true) {
      const choice = (await rl.question("Choose 1, 2, 3, or 4: ")).trim();
      if (choice === "1") return patchVersion;
      if (choice === "2") return minorVersion;
      if (choice === "3") return majorVersion;
      if (choice === "4") {
        const customVersion = (await rl.question("Enter release version: ")).trim();
        try {
          return normalizeReleaseVersion(customVersion);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      } else {
        console.error("Expected 1, 2, 3, or 4.");
      }
    }
  } finally {
    rl.close();
  }
}

function getLatestReleaseTagVersion(): string {
  const tags = capture("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"])
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => {
      try {
        return normalizeReleaseVersion(tag);
      } catch {
        return null;
      }
    })
    .filter((version): version is string => version !== null);

  if (tags.length === 0) {
    fail("No release tags found. Use bun run release <version> for the first release.");
  }

  return tags.sort(compareVersions).at(-1) ?? fail("No release tags found.");
}

function bumpVersion(version: string, increment: ReleaseIncrement): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((value) => Number.parseInt(value, 10));
  if (increment === "major") return `${major + 1}.0.0`;
  if (increment === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((value) => Number.parseInt(value, 10));
  const rightParts = right.split(".").map((value) => Number.parseInt(value, 10));

  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

function assertCleanWorkingTree(): void {
  const status = capture("git", ["status", "--porcelain"]);
  if (status.trim()) {
    fail("Working tree must be clean before starting a release.");
  }
}

function assertMainBranch(): void {
  const branch = capture("git", ["branch", "--show-current"]).trim();
  if (branch !== "main") {
    fail(`Release must be started from main, current branch is ${branch || "<detached>"}.`);
  }
}

function assertMainMatchesOrigin(): void {
  const localMain = capture("git", ["rev-parse", "HEAD"]).trim();
  const originMain = capture("git", ["rev-parse", "origin/main"]).trim();

  if (localMain !== originMain) {
    fail("Local main must match origin/main before starting a release.");
  }
}

function assertTagDoesNotExist(tag: string): void {
  const localTag = spawnSync("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], {
    cwd: resolveRepoPath(),
    stdio: "ignore"
  });
  if (localTag.status === 0) {
    fail(`Local tag ${tag} already exists.`);
  }

  const remoteTag = spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
    cwd: resolveRepoPath(),
    stdio: "ignore"
  });
  if (remoteTag.status === 0) {
    fail(`Remote tag ${tag} already exists.`);
  }
  if (remoteTag.status !== 2) {
    fail(`Unable to check whether remote tag ${tag} exists.`);
  }
}

function hasStagedChanges(): boolean {
  const result = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: resolveRepoPath(),
    stdio: "ignore"
  });

  return result.status === 1;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: resolveRepoPath(),
    env: process.env,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: resolveRepoPath(),
    env: process.env,
    encoding: "utf8"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
