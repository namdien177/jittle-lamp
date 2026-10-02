import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CacheMode } from "@jittle-lamp/shared";

import { isSecretCredentialField, type ResolvedRunConfig } from "../config/resolve";
import type { PlannedStep, RunPlan } from "../plan";
import type { Binding } from "../runtime/test-helpers";

// Transcript → generated e2e project (ADR 0002 decision 10): `tests/case.e2e.ts` with one e2e call
// per executable step, and `e2e.config.ts` with the target, models, cache and secrets. Both files
// hold names only; values arrive through the JL_* environment of the e2e process.

const runtimeDir = resolve(dirname(fileURLToPath(import.meta.url)), "../runtime");
const require = createRequire(import.meta.url);

// e2e keys its replay cache on the test file path and title; both stay constant so a case keeps
// its scripts across runs, run directories and machines.
export const generatedTestFile = "tests/case.e2e.ts";
export const generatedTestTitle = "case";
export const e2eProjectId = "jittle-lamp";

export type CompiledStep = {
  step: PlannedStep;
  call: "open" | "act" | "assert" | "wait" | "extract" | "screenshot" | "note" | "group";
  template: string;
  bindings: Record<string, Binding>;
};

export type GeneratedProject = {
  dir: string;
  configPath: string;
  testPath: string;
  outputDir: string;
  compiled: CompiledStep[];
  credentialProfiles: string[];
  secretNames: Array<{ name: string; env: string }>;
  targetName: string;
};

const tokenPattern = /\{([^{}\s]+(?:\{[^{}\s]+\}[^{}\s]*)?)\}/g;
const paramSafe = (value: string) => value.replace(/[^A-Za-z0-9_]/g, "_");

function substituteParams(text: string, params: Readonly<Record<string, string>>): string {
  return text.replace(/\{([^{}\s]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? (params[name] ?? match) : match
  );
}

export function compileStep(
  step: PlannedStep,
  plan: Pick<RunPlan, "credentialAliases" | "params">,
  config: Pick<ResolvedRunConfig, "vars">,
  extractedNames: ReadonlySet<string>
): CompiledStep {
  const bindings: Record<string, Binding> = {};
  const template = step.text.replace(tokenPattern, (match, token: string) => {
    if (token.startsWith("file:")) return token.slice("file:".length);
    if (token.startsWith("cred:")) {
      const ref = substituteParams(token.slice("cred:".length), plan.params);
      const dot = ref.lastIndexOf(".");
      const name = dot === -1 ? ref : ref.slice(0, dot);
      const field = (dot === -1 ? "username" : ref.slice(dot + 1)).toLowerCase();
      const profile = plan.credentialAliases[name] ?? name;
      const param = `${paramSafe(profile)}__${paramSafe(field)}`;
      if (field === "password") bindings[param] = { kind: "cred-password", profile };
      else if (isSecretCredentialField(field)) bindings[param] = { kind: "secret", name: `${profile}.${field}` };
      else bindings[param] = { kind: "cred", profile, field };
      return `{${param}}`;
    }
    if (token.includes("{")) return match;
    if (extractedNames.has(token)) {
      bindings[token] = { kind: "extracted", name: token };
      return `{${token}}`;
    }
    if (config.vars.get(token)?.secret) bindings[paramSafe(token)] = { kind: "secret", name: token };
    else bindings[paramSafe(token)] = { kind: "var", name: token };
    return `{${paramSafe(token)}}`;
  });

  const call: CompiledStep["call"] = !step.executes
    ? "group"
    : step.type === "open"
      ? "open"
      : step.type === "assert"
        ? "assert"
        : step.type === "wait"
          ? "wait"
          : step.type === "extract"
            ? "extract"
            : step.type === "screenshot"
              ? "screenshot"
              : step.type === "note"
                ? "note"
                : "act";
  return { step, call, template, bindings };
}

const q = (value: unknown) => JSON.stringify(value);

function stepMeta(step: PlannedStep): string {
  return q({
    stepId: step.stepId,
    parentStepId: step.parentStepId,
    ordinal: step.ordinal,
    kind: step.type,
    label: step.instruction.length > 0 ? step.instruction : step.type
  });
}

function callCode(compiled: CompiledStep): string {
  const bindings = q(compiled.bindings);
  const template = q(compiled.template);
  switch (compiled.call) {
    case "open":
      return `app.open(jl.fill(${template}, ${bindings}))`;
    case "act":
      return Object.keys(compiled.bindings).length > 0
        ? `agent.act(${template}, { params: jl.params(${bindings}) })`
        : `agent.act(${template})`;
    case "assert":
      return `agent.assert(jl.fill(${template}, ${bindings}))`;
    case "wait":
      return `agent.waitFor(jl.fill(${template}, ${bindings}))`;
    case "extract": {
      const name = compiled.step.args.find((arg) => arg.name === null)?.value ?? "value";
      return `agent.extract(jl.fill(${template}, ${bindings}), { schema: jl.stringSchema }).then((value) => jl.setExtracted(${q(name)}, value))`;
    }
    case "screenshot":
      return `jl.screenshot(${q(compiled.step.stepId)}, ${q(compiled.step.instruction)})`;
    case "note":
    case "group":
      return "Promise.resolve()";
  }
}

export function renderTestFile(compiled: readonly CompiledStep[], helpersPath: string): string {
  const lines: string[] = [
    "// Generated by jl-e2e from a transcript. Do not edit; edit the transcript.",
    'import { test } from "e2e";',
    `import * as jl from ${q(helpersPath)};`,
    "",
    `test(${q(generatedTestTitle)}, async ({ app, agent }) => {`
  ];
  const open: string[] = [];
  const indent = () => "  ".repeat(open.length + 1);

  for (const item of compiled) {
    // Close groups that this step is not part of.
    while (open.length > 0 && open[open.length - 1] !== item.step.parentStepId) {
      open.pop();
      lines.push(`${indent()}});`);
    }
    if (item.call === "group") {
      lines.push(`${indent()}await jl.step(${stepMeta(item.step)}, async () => {`);
      open.push(item.step.stepId);
      continue;
    }
    lines.push(`${indent()}await jl.step(${stepMeta(item.step)}, () => ${callCode(item)});`);
  }
  while (open.length > 0) {
    open.pop();
    lines.push(`${indent()}});`);
  }
  lines.push("});", "");
  return lines.join("\n");
}

export type GenerateOptions = {
  dir: string;
  plan: RunPlan;
  config: ResolvedRunConfig;
  cacheMode: CacheMode;
  cacheStoreDir: string;
  headed: boolean;
  viewport: { width: number; height: number };
  timeoutMs: number;
};

export function renderConfigFile(input: {
  targetName: string;
  // Environment identity in the cache key (design.md §9.5): the same environment reached from the
  // cloud or from a local .env shares scripts; a different port or preview URL does not matter.
  appIdentity: string;
  fallbackUrl: string;
  credentialProfiles: readonly string[];
  secretNames: ReadonlyArray<{ name: string; env: string }>;
  cacheMode: CacheMode;
  cacheStoreDir: string;
  headed: boolean;
  viewport: { width: number; height: number };
  timeoutMs: number;
}): string {
  const credentials = input.credentialProfiles
    .map(
      (profile) =>
        `    ${q(profile)}: { username: process.env[${q(`JL_CRED_${profile}_USERNAME`)}] ?? "", password: () => process.env[${q(`JL_CRED_${profile}_PASSWORD`)}] ?? "" }`
    )
    .join(",\n");
  const secrets = input.secretNames.map(({ name, env }) => `    ${q(name)}: () => process.env[${q(env)}] ?? ""`).join(",\n");
  const e2eMode = input.cacheMode === "strict" ? "read-only" : input.cacheMode;
  return [
    "// Generated by jl-e2e. Holds names only; values come from the JL_* environment.",
    'import type { E2EConfig } from "e2e";',
    `import { createJlEngine } from ${q(join(runtimeDir, "engine.ts"))};`,
    `import { createModelsFromEnv } from ${q(join(runtimeDir, "models.ts"))};`,
    `import { createProgressReporter } from ${q(join(runtimeDir, "progress-reporter.ts"))};`,
    `import { createJlCacheStore } from ${q(join(runtimeDir, "cache-store.ts"))};`,
    "",
    "const { model, judge } = await createModelsFromEnv(process.env);",
    "const context = process.env.JL_AGENT_INSTRUCTIONS;",
    "",
    "export default {",
    `  projectId: ${q(e2eProjectId)},`,
    `  tests: [${q(generatedTestFile)}],`,
    "  targets: [",
    `    { name: ${q(input.targetName)}, engine: createJlEngine({ viewport: ${q(input.viewport)}, headed: ${input.headed} }), app: { url: process.env.JL_ENV_BASE_URL || ${q(input.fallbackUrl)}, identity: ${q(input.appIdentity)} } }`,
    "  ],",
    "  agents: { default: { model, judge, ...(context ? { context } : {}) } },",
    `  cache: { mode: ${q(e2eMode)}, strict: ${input.cacheMode === "strict"}, store: createJlCacheStore({ dir: ${q(input.cacheStoreDir)}, writable: ${e2eMode === "read-write"} }) },`,
    `  credentials: {\n${credentials}\n  },`,
    `  secrets: {\n${secrets}\n  },`,
    '  trace: "on",',
    '  video: "on",',
    "  workers: 1,",
    "  retries: 0,",
    `  timeout: ${input.timeoutMs},`,
    '  output: ".e2e",',
    '  reporters: ["json", createProgressReporter(process.env.JL_PROGRESS_LOG)]',
    "} satisfies E2EConfig;",
    ""
  ].join("\n");
}

function e2eNodeModulesDir(): string {
  // The directory that contains the resolved `e2e` package, so the generated project resolves the
  // same e2e, engine and provider packages as the runner.
  return dirname(dirname(require.resolve("e2e/package.json")));
}

export function generateProject(options: GenerateOptions): GeneratedProject {
  const { dir, plan, config } = options;
  rmSync(join(dir, "tests"), { recursive: true, force: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  const nodeModules = join(dir, "node_modules");
  if (!existsSync(nodeModules)) symlinkSync(e2eNodeModulesDir(), nodeModules, "dir");

  const extractedNames = new Set<string>();
  const compiled: CompiledStep[] = [];
  for (const step of plan.steps) {
    compiled.push(compileStep(step, plan, config, extractedNames));
    if (step.type === "extract") {
      const name = step.args.find((arg) => arg.name === null)?.value;
      if (name) extractedNames.add(name);
    }
  }

  const credentialProfiles = new Set<string>();
  const secretNames = new Map<string, string>();
  for (const item of compiled) {
    for (const binding of Object.values(item.bindings)) {
      if (binding.kind === "cred-password") credentialProfiles.add(binding.profile);
      if (binding.kind === "secret") {
        const dot = binding.name.lastIndexOf(".");
        const env = dot === -1 ? `JL_VAR_${binding.name}` : `JL_CRED_${binding.name.slice(0, dot)}_${binding.name.slice(dot + 1).toUpperCase()}`;
        secretNames.set(binding.name, env);
      }
    }
  }

  const firstOpen = plan.steps.find((step) => step.type === "open" && /^https?:\/\//.test(step.instruction));
  const fallbackUrl = plan.baseUrl ?? (firstOpen ? new URL(firstOpen.instruction).origin : "http://127.0.0.1");
  const targetName = (plan.environmentName ?? "local").replace(/[^A-Za-z0-9_-]/g, "-");

  const testPath = join(dir, generatedTestFile);
  const configPath = join(dir, "e2e.config.ts");
  writeFileSync(testPath, renderTestFile(compiled, join(runtimeDir, "test-helpers.ts")));
  const secretList = [...secretNames].map(([name, env]) => ({ name, env }));
  writeFileSync(
    configPath,
    renderConfigFile({
      targetName,
      appIdentity: `jl-env:${plan.environmentName ?? new URL(fallbackUrl).host}`,
      fallbackUrl,
      credentialProfiles: [...credentialProfiles],
      secretNames: secretList,
      cacheMode: options.cacheMode,
      cacheStoreDir: options.cacheStoreDir,
      headed: options.headed,
      viewport: options.viewport,
      timeoutMs: options.timeoutMs
    })
  );

  return {
    dir,
    configPath,
    testPath,
    outputDir: join(dir, ".e2e"),
    compiled,
    credentialProfiles: [...credentialProfiles],
    secretNames: secretList,
    targetName
  };
}
