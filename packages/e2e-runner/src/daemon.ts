#!/usr/bin/env node
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "./cli";
import { startWorker } from "./daemon/worker";

const usage = `jl-e2e-runner: claims runs for a runner pool and executes them

  jl-e2e-runner start --api https://api.example --token <registration token> [--work-dir dir]
                      [--concurrency 1] [--headed] [--once] [--state path]

The registration token is used once; the worker credential is stored in
~/.config/jittle-lamp/runner/<api host>.json (mode 600). Later starts need only --api.
Environment: JL_API_ORIGIN, JL_RUNNER_TOKEN, JL_RUNNER_WORK_DIR, JL_RUNNER_CONCURRENCY.`;

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command !== "start") {
    console.log(usage);
    return args.command === "help" ? 0 : 2;
  }
  const flag = (name: string) => args.flags.get(name)?.at(-1);
  const apiOrigin = flag("api") ?? process.env.JL_API_ORIGIN;
  if (!apiOrigin) {
    console.error("jl-e2e-runner start needs --api or JL_API_ORIGIN");
    return 2;
  }
  const token = flag("token") ?? process.env.JL_RUNNER_TOKEN;
  await startWorker({
    apiOrigin,
    ...(token ? { registrationToken: token } : {}),
    ...(flag("state") ? { statePath: resolve(flag("state") as string) } : {}),
    workDir: resolve(flag("work-dir") ?? process.env.JL_RUNNER_WORK_DIR ?? join(homedir(), ".cache", "jl-e2e-runner")),
    concurrency: Number(flag("concurrency") ?? process.env.JL_RUNNER_CONCURRENCY ?? 1),
    headed: flag("headed") === "true",
    once: flag("once") === "true",
    allowClaudeCode: flag("allow-claude-code") === "true"
  });
  return 0;
}

if (import.meta.main || process.argv[1]?.endsWith("daemon.js") || process.argv[1]?.endsWith("daemon.ts")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(4);
    }
  );
}
