import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CacheMode } from "@jittle-lamp/shared";

import { queryNameArg, queryProfileArg } from "@jittle-lamp/shared";

import { isSecretCredentialField, type ResolvedRunConfig } from "../config/resolve";
import type { PlannedStep, RunPlan } from "../plan";
import { e2ePackageDir, runtimeDir } from "../paths";
import type { Binding } from "../runtime/test-helpers";

// Transcript → generated e2e project (ADR 0002 decision 10): `tests/case.e2e.ts` with one e2e call
// per executable step, and `e2e.config.ts` with the target, models, cache and secrets. Both files
// hold names only; values arrive through the JL_* environment of the e2e process.


// e2e keys its replay cache on the test file path and title; both stay constant so a case keeps
// its scripts across runs, run directories and machines.
export const generatedTestFile = "tests/case.e2e.ts";
export const generatedTestTitle = "case";
export const e2eProjectId = "jittle-lamp";

export type CompiledStep = {
  step: PlannedStep;
  call: "open" | "act" | "assert" | "wait" | "extract" | "screenshot" | "note" | "group" | "query";
  template: string;
  bindings: Record<string, Binding>;
  // The step replays its API script first and falls back to the call above (roadmap §2.4).
  api?: boolean;
  // [Query] steps: the profile after alias resolution.
  queryProfile?: string;
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
  // Postgres profiles the [Query] steps name (aliases resolved); the config registers the
  // lookup_data tool when there are any.
  queryProfiles: string[];
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
  config: Pick<ResolvedRunConfig, "vars"> & Partial<Pick<ResolvedRunConfig, "credentials" | "loginFields">>,
  extractedNames: ReadonlySet<string>
): CompiledStep {
  const bindings: Record<string, Binding> = {};
  const template = step.text.replace(tokenPattern, (match, token: string) => {
    if (token.startsWith("file:")) return token.slice("file:".length);
    if (token.startsWith("cred:")) {
      const ref = substituteParams(token.slice("cred:".length), plan.params);
      const dot = ref.lastIndexOf(".");
      const name = dot === -1 ? ref : ref.slice(0, dot);
      const profile = plan.credentialAliases[name] ?? name;
      const field = (dot === -1 ? config.loginFields?.get(profile) ?? "username" : ref.slice(dot + 1)).toLowerCase();
      const param = `${paramSafe(profile)}__${paramSafe(field)}`;
      const secret = config.credentials?.get(profile)?.get(field)?.secret ?? isSecretCredentialField(field);
      if (field === "password" && secret) bindings[param] = { kind: "cred-password", profile };
      else if (secret) bindings[param] = { kind: "secret", name: `${profile}.${field}` };
      else bindings[param] = { kind: "cred", profile, field };
      return `{${param}}`;
    }
    if (token.includes("{")) return match;
    // `{name}` of an earlier [Extract]/binding.
    if (extractedNames.has(token)) {
      bindings[token] = { kind: "extracted", name: token };
      return `{${token}}`;
    }
    // `{student.id}` or `{alias.field}`: a field of a bound value or a [Use] block's output (roadmap
    // §2.6). The param name is made identifier-safe for e2e; the binding keeps the dotted name.
    if (token.includes(".") && extractedNames.has(token.split(".")[0] ?? "")) {
      bindings[paramSafe(token)] = { kind: "extracted", name: token };
      return `{${paramSafe(token)}}`;
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
                : step.type === "query"
                  ? "query"
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
  const code = uiCallCode(compiled);
  if (compiled.api !== true) return code;
  return `jl.replayApiOrFallback(${q(compiled.step.stepId)}, () => ${code})`;
}

function uiCallCode(compiled: CompiledStep): string {
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
      // The deterministic check replays before any judge call (runtime/assert-check.ts).
      return `jl.assertWithCheck(${q(compiled.step.stepId)}, ${q(compiled.step.instructionKey)}, ${template}, ${bindings}, { agent, screen, browser })`;
    case "wait":
      return `agent.waitFor(jl.fill(${template}, ${bindings}))`;
    case "extract": {
      const name = compiled.step.args.find((arg) => arg.name === null)?.value ?? "value";
      return `agent.extract(jl.fill(${template}, ${bindings}), { schema: jl.stringSchema }).then((value) => jl.setExtracted(${q(name)}, value, ${q(compiled.step.useAlias)}))`;
    }
    case "screenshot":
      return `jl.screenshot(${q(compiled.step.stepId)}, ${q(compiled.step.instruction)})`;
    case "query": {
      const profile = queryProfileArg(compiled.step.args) ?? "";
      const name = queryNameArg(compiled.step.args);
      return `jl.query(${q(compiled.step.stepId)}, ${q({ profile: compiled.queryProfile ?? profile, instruction: compiled.template, binding: compiled.step.binding ?? null, name, instructionKey: compiled.step.instructionKey })}, ${bindings})`;
    }
    case "note":
    case "group":
      return "Promise.resolve()";
  }
}

// `skipStepIds`: steps a reused run stands in for (api/reuse.ts); they are left out of the file.
export function renderTestFile(compiled: readonly CompiledStep[], helpersPath: string, skipStepIds: ReadonlySet<string> = new Set()): string {
  const lines: string[] = [
    "// Generated by jl-e2e from a transcript. Do not edit; edit the transcript.",
    'import { test } from "@e2e-dev/web";',
    `import * as jl from ${q(helpersPath)};`,
    "",
    `test(${q(generatedTestTitle)}, async ({ app, agent, screen, browser }) => {`
  ];
  const open: string[] = [];
  const indent = () => "  ".repeat(open.length + 1);

  for (const item of compiled) {
    if (skipStepIds.has(item.step.stepId)) continue;
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
  // Steps that call `jl.replayApiOrFallback` (api/modes.ts) and steps a reused run replaces.
  apiStepIds?: ReadonlySet<string>;
  skipStepIds?: ReadonlySet<string>;
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
  queryProfiles?: readonly string[];
}): string {
  const queryProfiles = input.queryProfiles ?? [];
  const credentials = input.credentialProfiles
    .map(
      (profile) =>
        `    ${q(profile)}: { username: process.env[${q(`JL_LOGIN_${profile}_IDENTIFIER`)}] ?? process.env[${q(`JL_CRED_${profile}_USERNAME`)}] ?? "", password: () => process.env[${q(`JL_CRED_${profile}_PASSWORD`)}] ?? "" }`
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
    ...(queryProfiles.length > 0 ? [`import { createLookupDataTool, queryToolEnabled } from ${q(join(runtimeDir, "query-tool.ts"))};`] : []),
    "",
    "const { model, judge } = await createModelsFromEnv(process.env);",
    "const context = process.env.JL_AGENT_INSTRUCTIONS;",
    // lookup_data (roadmap §5.2): read-only data lookups for Act steps, profiles by name only.
    ...(queryProfiles.length > 0
      ? [`const tools = queryToolEnabled(process.env, ${q(queryProfiles)}) ? { lookup_data: createLookupDataTool({ profiles: ${q(queryProfiles)} }) } : {};`]
      : ["const tools = {};"]),
    "",
    "export default {",
    `  projectId: ${q(e2eProjectId)},`,
    `  tests: [${q(generatedTestFile)}],`,
    "  targets: [",
    `    { name: ${q(input.targetName)}, engine: createJlEngine({ viewport: ${q(input.viewport)}, headed: ${input.headed} }), app: { url: process.env.JL_ENV_BASE_URL || ${q(input.fallbackUrl)}, identity: ${q(input.appIdentity)} } }`,
    "  ],",
    "  agents: { default: { model, judge, ...(context ? { context } : {}), ...(Object.keys(tools).length > 0 ? { tools } : {}) } },",
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

export function e2eNodeModulesDir(): string {
  // The directory that contains the resolved `e2e` package, so the generated project resolves the
  // same e2e, engine and provider packages as the runner.
  return dirname(e2ePackageDir);
}

export function generateProject(options: GenerateOptions): GeneratedProject {
  const { dir, plan, config } = options;
  rmSync(join(dir, "tests"), { recursive: true, force: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  const nodeModules = join(dir, "node_modules");
  if (!existsSync(nodeModules)) symlinkSync(e2eNodeModulesDir(), nodeModules, process.platform === "win32" ? "junction" : "dir");

  const extractedNames = new Set<string>();
  const compiled: CompiledStep[] = [];
  const queryProfiles = new Set<string>();
  for (const step of plan.steps) {
    const item = compileStep(step, plan, config, extractedNames);
    if (step.type === "query" && step.executes) {
      const named = queryProfileArg(step.args);
      const profile = named ? plan.credentialAliases[named] ?? named : "";
      if (profile) {
        item.queryProfile = profile;
        queryProfiles.add(profile);
      }
      // `{student}` and `{student.rows}` exist from here (roadmap §5.1).
      if (step.binding) {
        extractedNames.add(step.binding);
        extractedNames.add(`${step.binding}.rows`);
      }
    }
    compiled.push(options.apiStepIds?.has(step.stepId) ? { ...item, api: true } : item);
    if (step.type === "extract") {
      const name = step.args.find((arg) => arg.name === null)?.value;
      if (name) extractedNames.add(name);
    }
    if ((step.type === "query" || step.type === "api") && step.binding) extractedNames.add(step.binding);
    if (step.type === "use" && step.alias) extractedNames.add(step.alias);
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
  writeFileSync(testPath, renderTestFile(compiled, join(runtimeDir, "test-helpers.ts"), options.skipStepIds ?? new Set()));
  const secretList = [...secretNames].map(([name, env]) => ({ name, env }));
  writeFileSync(
    configPath,
    renderConfigFile({
      targetName,
      appIdentity: `jl-env:${plan.environmentName ?? new URL(fallbackUrl).hostname}`,
      fallbackUrl,
      credentialProfiles: [...credentialProfiles],
      secretNames: secretList,
      cacheMode: options.cacheMode,
      cacheStoreDir: options.cacheStoreDir,
      headed: options.headed,
      viewport: options.viewport,
      timeoutMs: options.timeoutMs,
      queryProfiles: [...queryProfiles]
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
    targetName,
    queryProfiles: [...queryProfiles]
  };
}
