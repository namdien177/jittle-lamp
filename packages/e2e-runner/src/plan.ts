import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeTestCaseFingerprint,
  expandMacros,
  extractStepReferences,
  isFakeDataToken,
  lintTestCase,
  loginProfileArg,
  macroDefinitionSchema,
  parseTestCaseTranscript,
  sha256Hex,
  type BlockedReason,
  type ExpandedStep,
  type LintFinding,
  type MacroDefinition,
  type ParsedTestCase,
  type TranscriptStep
} from "@jittle-lamp/shared";

import { isSecretVariable, resolveCredentialProfile, type ResolvedRunConfig } from "./config/resolve";
import { generateFakeData } from "./fake-data";

// A RunPlan is the transcript resolved against macros and configuration: the steps the engine
// executes, with variables substituted and secrets replaced by named placeholders the runner fills
// itself. Values of secrets never appear in the plan's text.

export type SecretRef = { placeholder: string; name: string; value: string };

export type PlannedStep = ExpandedStep & {
  // Instruction with {var} and public credential fields substituted; secret refs as placeholders.
  instruction: string;
  secrets: SecretRef[];
  // Macro calls are group headers; their expanded children execute.
  executes: boolean;
};

export type RunPlan = {
  testCase: ParsedTestCase;
  title: string;
  fingerprint: string;
  environmentName: string | null;
  baseUrl: string | null;
  agentInstructions: string | null;
  params: Record<string, string>;
  // Values made up for this run ({person.name} → "Jordan Lee"); also in params.
  generated: Record<string, string>;
  steps: PlannedStep[];
  lint: LintFinding[];
  missing: string[];
  blockedReason: BlockedReason | null;
  blockedMessage: string | null;
  credentialAliases: Record<string, string>;
  macros: Array<Pick<MacroDefinition, "name" | "version">>;
};

const builtinMacroDir = resolve(dirname(fileURLToPath(import.meta.url)), "../macros");

// Macro files are transcript documents: the title is the macro name, `Params:` declares parameters.
// A local macro's version is derived from its text so an edit invalidates its expanded scripts.
export function parseMacroFile(text: string): MacroDefinition {
  const { testCase } = parseTestCaseTranscript(text);
  const body = text
    .split("\n")
    .filter((line) => !/^#\s/.test(line.trim()) && !/^(params|description)\s*:/i.test(line.trim()))
    .join("\n")
    .trim();
  return macroDefinitionSchema.parse({
    name: testCase.title,
    version: Number.parseInt(sha256Hex(body).slice(0, 7), 16) + 1,
    params: testCase.metadata.params.map((param) => ({
      name: param.name,
      required: param.required,
      default: param.default,
      kind: param.name.toLowerCase() === "profile" ? "credential" : "text"
    })),
    transcript: body
  });
}

export function loadMacroDir(dir: string): MacroDefinition[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".transcript.md") || name.endsWith(".md"))
    .sort()
    .map((name) => parseMacroFile(readFileSync(join(dir, name), "utf8")));
}

// Project macros override the built-in ones by name.
export function loadMacros(projectDirs: readonly string[]): MacroDefinition[] {
  const byName = new Map<string, MacroDefinition>();
  for (const macro of loadMacroDir(builtinMacroDir)) byName.set(macro.name.toLowerCase(), macro);
  for (const dir of projectDirs) for (const macro of loadMacroDir(dir)) byName.set(macro.name.toLowerCase(), macro);
  return [...byName.values()];
}

const referencePattern = /\{([^{}\s]+)\}/g;

function renderInstruction(
  step: ExpandedStep,
  config: ResolvedRunConfig,
  aliases: Map<string, string>,
  extracted: ReadonlySet<string>,
  missing: Set<string>,
  missingKinds: Set<"variable" | "credential">
): { instruction: string; secrets: SecretRef[] } {
  const secrets: SecretRef[] = [];
  const instruction = step.text.replace(referencePattern, (match, token: string) => {
    if (token.startsWith("file:")) return match;
    if (token.startsWith("cred:")) {
      const ref = token.slice("cred:".length);
      const dot = ref.lastIndexOf(".");
      const profileName = dot === -1 ? ref : ref.slice(0, dot);
      const field = dot === -1 ? "username" : ref.slice(dot + 1).toLowerCase();
      const profile = aliases.get(profileName) ?? profileName;
      const value = config.credentials.get(profile)?.get(field);
      if (!value) {
        missing.add(`credential('${profileName}').${field}`);
        missingKinds.add("credential");
        return match;
      }
      if (!value.secret) return value.value;
      const placeholder = `{{secret:${profile}.${field}}}`;
      if (!secrets.some((secret) => secret.placeholder === placeholder)) {
        secrets.push({ placeholder, name: `${profile}.${field}`, value: value.value });
      }
      return placeholder;
    }
    const value = config.vars.get(token);
    // Values read by an earlier [Extract] exist only while the run executes.
    if (!value && extracted.has(token)) return match;
    if (!value) {
      missing.add(`vars.${token}`);
      missingKinds.add("variable");
      return match;
    }
    if (!value.secret) return value.value;
    const placeholder = `{{secret:vars.${token}}}`;
    if (!secrets.some((secret) => secret.placeholder === placeholder)) secrets.push({ placeholder, name: `vars.${token}`, value: value.value });
    return placeholder;
  });
  return { instruction, secrets };
}

export function buildRunPlan(input: {
  transcript: string;
  config: ResolvedRunConfig;
  macros: readonly MacroDefinition[];
  params?: Readonly<Record<string, string>>;
  previousSteps?: readonly Pick<TranscriptStep, "stepId" | "instructionKey">[];
}): RunPlan {
  const { testCase, diagnostics } = parseTestCaseTranscript(input.transcript, input.previousSteps ? { previousSteps: input.previousSteps } : {});
  const lint = lintTestCase(testCase, {
    macros: input.macros,
    environmentVariables: [...input.config.vars.keys()]
  });

  const base = {
    testCase,
    title: testCase.title,
    fingerprint: computeTestCaseFingerprint(testCase),
    environmentName: input.config.environmentName?.value ?? null,
    baseUrl: input.config.baseUrl?.value ?? null,
    agentInstructions: input.config.agentInstructions,
    macros: input.macros.map((macro) => ({ name: macro.name, version: macro.version }))
  };

  const blocking = lint.filter((finding) => finding.severity === "error");
  if (diagnostics.length > 0 || blocking.length > 0) {
    const messages = [...diagnostics.map((d) => `line ${d.line}: ${d.message}`), ...blocking.map((f) => `line ${f.line ?? "?"}: ${f.message}`)];
    return {
      ...base,
      params: {},
      generated: {},
      steps: [],
      lint,
      missing: [],
      blockedReason: "TRANSCRIPT_INVALID",
      blockedMessage: messages.join("\n"),
      credentialAliases: {}
    };
  }

  const expanded = expandMacros(testCase.steps, input.macros);
  if (expanded.errors.length > 0) {
    return {
      ...base,
      params: {},
      generated: {},
      steps: [],
      lint,
      missing: [],
      blockedReason: "MACRO_ERROR",
      blockedMessage: expanded.errors.map((error) => error.message).join("\n"),
      credentialAliases: {}
    };
  }

  // Case params: run params, then the config chain, then the case's declared defaults
  // (design.md §9.2). Dataset rows arrive as run params.
  const params: Record<string, string> = {};
  for (const param of testCase.metadata.params) {
    const configured = input.config.vars.get(param.name);
    if (configured) params[param.name] = configured.value;
    else if (param.default !== null) params[param.name] = param.default;
  }
  Object.assign(params, input.params ?? {});
  // Generated values for {person.name} and friends that nothing above defines.
  const generatedTokens = new Set<string>();
  for (const step of expanded.steps) {
    for (const name of extractStepReferences([step.text, ...step.args.map((arg) => arg.value)]).variables) {
      if (isFakeDataToken(name) && !input.config.vars.has(name) && !Object.prototype.hasOwnProperty.call(params, name)) generatedTokens.add(name);
    }
  }
  const generated = generateFakeData(generatedTokens, { locale: input.config.dataLocale });
  Object.assign(params, generated);
  const config: ResolvedRunConfig = {
    ...input.config,
    vars: new Map([
      ...input.config.vars,
      ...Object.entries(params)
        .filter(([name]) => !input.config.vars.has(name))
        .map(([name, value]) => [name, { value, source: "param" as const, secret: isSecretVariable(name) }] as const)
    ])
  };
  // Only public values are ever substituted into instruction text.
  const publicParams = Object.fromEntries(Object.entries(params).filter(([name]) => !config.vars.get(name)?.secret));

  const missing = new Set<string>();
  const missingKinds = new Set<"variable" | "credential">();
  const aliases = new Map<string, string>();

  // Resolve credential profiles named by [Login: X] and {cred:X.field} (after param substitution).
  const profileNames = new Set<string>();
  for (const step of expanded.steps) {
    for (const ref of extractStepReferences([substituteParams(step.text, publicParams), ...step.args.map((arg) => substituteParams(arg.value, publicParams))]).credentialRefs) {
      const dot = ref.lastIndexOf(".");
      profileNames.add(dot === -1 ? ref : ref.slice(0, dot));
    }
    if (step.type === "login") {
      const profile = loginProfileArg(step.args);
      if (profile) profileNames.add(substituteParams(profile, publicParams));
    }
  }
  for (const name of profileNames) {
    if (name.includes("{")) continue;
    const resolved = resolveCredentialProfile(config, name);
    if (resolved) aliases.set(name, resolved.profile);
    else {
      missing.add(`credential('${name}')`);
      missingKinds.add("credential");
    }
  }

  const extracted = new Set<string>();
  const steps: PlannedStep[] = expanded.steps.map((step) => {
    const withParams = { ...step, text: substituteParams(step.text, publicParams), args: step.args.map((arg) => ({ ...arg, value: substituteParams(arg.value, publicParams) })) };
    const rendered = renderInstruction(withParams, config, aliases, extracted, missing, missingKinds);
    if (step.type === "extract" && !step.disabled) {
      const name = step.args.find((arg) => arg.name === null)?.value;
      if (name) extracted.add(name);
    }
    const executes = !(step.type === "macro" || step.type === "login") || step.macroVersion === null;
    return { ...step, instruction: rendered.instruction, secrets: rendered.secrets, executes };
  });

  if (steps.some((step) => step.executes && step.type === "open" && step.instruction.startsWith("/")) && !base.baseUrl) {
    missing.add("env.baseUrl");
    missingKinds.add("variable");
  }

  const missingList = [...missing].sort();
  const blockedReason: BlockedReason | null = missingList.length === 0 ? null : missingKinds.has("credential") ? "MISSING_CREDENTIAL" : "MISSING_VARIABLE";

  return {
    ...base,
    params: publicParams,
    generated,
    steps,
    lint,
    missing: missingList,
    blockedReason,
    blockedMessage: blockedReason ? `Missing: ${missingList.join(", ")}` : null,
    credentialAliases: Object.fromEntries([...aliases].filter(([name, profile]) => name !== profile))
  };
}

function substituteParams(text: string, params: Readonly<Record<string, string>>): string {
  return text.replace(referencePattern, (match, token: string) => (Object.prototype.hasOwnProperty.call(params, token) ? (params[token] ?? match) : match));
}
