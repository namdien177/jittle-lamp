const { chmodSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = process.cwd();
const gitMetadataPath = join(repoRoot, ".git");
const preCommitHookPath = join(repoRoot, ".githooks", "pre-commit");

if (process.env.CI) {
	console.log("Skipping git hook install in CI.");
	process.exit(0);
}

if (!existsSync(gitMetadataPath)) {
	console.log("Skipping git hook install: .git metadata not found.");
	process.exit(0);
}

if (existsSync(preCommitHookPath)) {
	chmodSync(preCommitHookPath, 0o755);
}

const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
	cwd: repoRoot,
	stdio: "inherit",
});

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

console.log("Configured git hooks to use .githooks");
