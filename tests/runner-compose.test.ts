import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

// deploy/runner/compose.yaml: Docker compose gives `environment:` precedence over `env_file:`, so
// an `environment:` entry for a variable runner.env sets silently replaces the operator's value
// (JL_RUNNER_CONCURRENCY in runner.env used to have no effect).

const runnerDir = join(import.meta.dir, "..", "deploy", "runner");

type ComposeService = {
  env_file?: string | string[];
  environment?: Record<string, unknown> | string[];
};

const compose = Bun.YAML.parse(readFileSync(join(runnerDir, "compose.yaml"), "utf8")) as {
  services: Record<string, ComposeService>;
};

const environmentNames = (service: ComposeService): string[] => {
  const environment = service.environment;
  if (!environment) return [];
  if (Array.isArray(environment)) return environment.map((entry) => entry.split("=")[0] ?? entry);
  return Object.keys(environment);
};

describe("runner compose file", () => {
  it("reads runner.env and never overrides a variable runner.env sets", () => {
    const sample = parseEnv(readFileSync(join(runnerDir, "runner.env.sample"), "utf8"));
    expect(Object.keys(sample)).toContain("JL_RUNNER_CONCURRENCY");
    const runner = compose.services.runner;
    if (!runner) throw new Error("Expected the runner service");
    expect([runner.env_file].flat()).toContain("runner.env");
    const overridden = environmentNames(runner).filter((name) => name in sample);
    expect(overridden).toEqual([]);
  });
});
