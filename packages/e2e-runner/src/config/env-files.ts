import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Names the runner reads from env files. Anything else in a `.env` (database URLs, cloud keys of the
// host app) is ignored so it can never reach the browser child process or a report.
const runnerKeyPattern =
  /^(?:JL_[A-Z0-9_]+|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|AI_GATEWAY_API_KEY|XAI_API_KEY|OPENAI_COMPATIBLE_BASE_URL|OPENAI_COMPATIBLE_API_KEY|E2E_TELEMETRY_DISABLED)$/;

export type EnvFile = { path: string; values: Record<string, string> };

export function isRunnerEnvKey(name: string): boolean {
  return runnerKeyPattern.test(name);
}

export function readEnvFile(path: string): EnvFile | null {
  if (!existsSync(path)) return null;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && isRunnerEnvKey(key)) values[key] = value;
  }
  return { path, values };
}

// `.env`, `.env.e2e`, then every `--env-file`, as design.md §9.2 orders them.
export function loadEnvFiles(cwd: string, explicit: readonly string[]): EnvFile[] {
  const candidates = [resolve(cwd, ".env"), resolve(cwd, ".env.e2e"), ...explicit.map((path) => resolve(cwd, path))];
  const files: EnvFile[] = [];
  for (const path of candidates) {
    const file = readEnvFile(path);
    if (file) files.push(file);
    else if (explicit.some((candidate) => resolve(cwd, candidate) === path)) {
      throw new Error(`Env file not found: ${path}`);
    }
  }
  return files;
}
