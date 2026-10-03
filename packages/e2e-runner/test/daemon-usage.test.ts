import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { usage } from "../src/daemon";
import { defaultStatePath } from "../src/daemon/worker";
import { runnerPackageDir } from "../src/paths";

describe("jl-e2e-runner help", () => {
  test("names the state file the worker really uses", () => {
    const path = defaultStatePath("https://api.jittlelamp.example");
    expect(dirname(path)).toBe(join(homedir(), ".config", "jittle-lamp", "runner"));
    expect(basename(path)).toStartWith("api.jittlelamp.example-");
    expect(basename(path)).toContain(hostname().replace(/[^A-Za-z0-9.-]/g, "_"));
    expect(usage).toContain("~/.config/jittle-lamp/runner/<api host>-<host name>.json");
    expect(usage).not.toContain("<api host>.json");
  });
});

// Exercise the shipped daemon in Bun and, when installed, Node. The Node
// bundle must not run the CLI entrypoint imported only for argument parsing.
describe("bundled runner entrypoint", () => {
  const node = Bun.which("node");
  const runtimes: [string, string][] = [["Bun", process.execPath]];
  if (node) runtimes.push(["Node", node]);
  let buildDir: string;
  beforeAll(async () => {
    buildDir = mkdtempSync(join(runnerPackageDir, ".entrypoint-test-"));
    const result = await Bun.build({
      entrypoints: [join(runnerPackageDir, "src/cli.ts"), join(runnerPackageDir, "src/daemon.ts")],
      outdir: buildDir,
      naming: "[name].js",
      target: "node",
      external: ["e2e", "@e2e-dev/web", "playwright", "playwright-core", "ai-sdk-provider-claude-code"]
    });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  });
  afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

  test.each(runtimes)("%s: help belongs to the daemon", async (_name, runtime) => {
    const child = Bun.spawn([runtime, join(buildDir, "daemon.js"), "help"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toStartWith("jl-e2e-runner: claims runs");
    expect(stdout).not.toContain("jl-e2e run <file.transcript.md>");
  });

  test.each(runtimes)("%s: start reaches the daemon's configuration validation", async (_name, runtime) => {
    const child = Bun.spawn([runtime, join(buildDir, "daemon.js"), "start"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, JL_API_ORIGIN: "" } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("jl-e2e-runner start needs --api or JL_API_ORIGIN");
  });
});
