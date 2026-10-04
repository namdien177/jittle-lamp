import { z } from "zod/v4";

import {
  extractStepReferences,
  lintTestCase,
  loginProfileArg,
  parseTestCaseTranscript,
  serializeStepLine,
  type MacroParam,
  type ParsedTestCase
} from "./test-case";

// Exploration imports (design.md §7 "General instructions"): instructions in plain language, or a
// spreadsheet row, are tried on a real browser with `e2e explore`, and what the agent did becomes
// a transcript in the system's format. The runner executes; these helpers turn its record into
// the transcript, with a model when one is configured and step by step when not.

const epochMs = z.number().int().nonnegative();

export const explorationStatusSchema = z.enum(["queued", "running", "done", "failed"]);

// What `e2e explore` reports under run.explore, trimmed to what the conversion and the UI use.
export const explorationRecordSchema = z.object({
  goal: z.string(),
  ended: z.enum(["finished", "step-limit", "time", "stuck", "aborted"]),
  summary: z.string().nullable().default(null),
  steps: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      title: z.string(),
      instruction: z.string(),
      status: z.enum(["passed", "failed", "blocked", "exhausted"]),
      summary: z.string().nullable().default(null),
      // e2e's code for a step that did not pass, e.g. AUTH_CREDENTIAL_UNAVAILABLE.
      errorCode: z.string().nullable().default(null)
    })
  ),
  findings: z
    .array(
      z.object({
        kind: z.enum(["issue", "warning"]),
        severity: z.number().int().min(1).max(5),
        title: z.string(),
        expected: z.string(),
        actual: z.string()
      })
    )
    .default([])
});

// Runner claim: an exploration instead of a run (`/runner-pools/claim`).
export const claimedExplorationSchema = z.object({
  explorationId: z.string().min(1),
  goal: z.string().min(1),
  maxSteps: z.number().int().min(1).max(12),
  timeoutMs: z.number().int().positive(),
  leaseExpiresAt: epochMs
});

// GET /test-explorations/:id/config for the worker holding the lease: the environment, the
// credential profiles the instructions name, and the model.
export const explorationConfigSchema = z.object({
  // Profile names the instructions use that the organisation has no login credential for. The
  // runner fails before exploring instead of letting the agent guess an account.
  missingProfiles: z.array(z.string()).default([]),
  environment: z.object({
    name: z.string().min(1),
    baseUrl: z.string(),
    variables: z.record(z.string(), z.string()),
    agentInstructions: z.string().nullable(),
    dataLocale: z.string().nullable().default(null)
  }),
  credentials: z.array(z.object({ profile: z.string().min(1), fields: z.record(z.string(), z.string()), loginField: z.string().regex(/^[a-z][a-z0-9_]*$/).nullable().default(null),
      secretFields: z.record(z.string(), z.string()) })),
  model: z.object({ act: z.string().nullable(), judge: z.string().nullable(), apiKeys: z.record(z.string(), z.string()) }).nullable()
});

export const explorationResultRequestSchema = z.object({
  status: z.enum(["done", "failed"]),
  explore: explorationRecordSchema.nullable(),
  error: z.string().max(4000).nullable().default(null)
});

export const explorationOutcomeSchema = z.enum(["passed", "blocked", "failed", "incomplete"]);

export const importItemExplorationSchema = z.object({
  status: explorationStatusSchema,
  // What the exploration proved; only `passed` is written as a test from what the agent did.
  outcome: explorationOutcomeSchema.nullable().default(null),
  environmentName: z.string().nullable(),
  // The pool that serves it, and its online runners while the item is queued (null otherwise).
  runnerPoolName: z.string().nullable().default(null),
  runnersOnline: z.number().int().nonnegative().nullable().default(null),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  ended: explorationRecordSchema.shape.ended.nullable(),
  steps: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative()
});

export type ExplorationStatus = z.infer<typeof explorationStatusSchema>;
export type ExplorationOutcome = z.infer<typeof explorationOutcomeSchema>;
export type ExplorationRecord = z.infer<typeof explorationRecordSchema>;
export type ClaimedExploration = z.infer<typeof claimedExplorationSchema>;
export type ExplorationConfig = z.infer<typeof explorationConfigSchema>;
export type ExplorationResultRequest = z.infer<typeof explorationResultRequestSchema>;
export type ImportItemExploration = z.infer<typeof importItemExplorationSchema>;

// "General instructions": one case per `# Title` section, or per paragraph when there are no
// headings. A section's first line is its title when it has no heading.
export function splitInstructions(text: string): Array<{ title: string; instructions: string }> {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) return [];
  const toCase = (block: string, heading: string | null) => {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const body = lines.join("\n").trim();
    const title = (heading ?? lines.find((line) => line.trim().length > 0) ?? "").replace(/^#+\s*/, "").trim();
    return { title: title.length > 120 ? `${title.slice(0, 117)}...` : title, instructions: body };
  };
  if (/^#\s+\S/m.test(normalized)) {
    return normalized
      .split(/^(?=#\s+\S)/m)
      .map((section) => section.trim())
      .filter((section) => section.length > 0)
      .map((section) => {
        const [first = "", ...rest] = section.split("\n");
        const heading = /^#\s+/.test(first) ? first : null;
        return toCase(heading ? rest.join("\n") : section, heading);
      })
      .filter((item) => item.instructions.length > 0 || item.title.length > 0);
  }
  return normalized
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => toCase(block, null));
}

// The goal handed to `e2e explore`: the instructions, told to follow them rather than hunt bugs.
export function explorationGoal(input: { title: string; instructions: string }): string {
  return [
    `Follow these test instructions exactly as a QA tester would, one user action per step, and check the expected results: ${input.title}.`,
    input.instructions,
    "Do not explore beyond them. Report a finding only when an expected result does not hold."
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

// Whether the agent showed the instructions work. A blocked or failed step, an issue finding, a
// run that ran out of steps or time, or no steps at all is not a pass, whatever the closing
// summary says (production: e2e reported `ended: finished` with the sign-in step blocked by
// AUTH_CREDENTIAL_UNAVAILABLE).
export function explorationOutcome(record: ExplorationRecord): { outcome: ExplorationOutcome; reason: string | null } {
  const stepReason = (step: ExplorationRecord["steps"][number]) =>
    `step ${step.index} "${step.title}" ${step.status}${step.errorCode ? ` (${step.errorCode})` : ""}`;
  const blocked = record.steps.find((step) => step.status === "blocked");
  if (blocked) return { outcome: "blocked", reason: stepReason(blocked) };
  if (record.ended === "aborted" || record.ended === "stuck") return { outcome: "blocked", reason: `the exploration ${record.ended}` };
  const failed = record.steps.find((step) => step.status === "failed");
  if (failed) return { outcome: "failed", reason: stepReason(failed) };
  const issue = record.findings.find((finding) => finding.kind === "issue");
  if (issue) return { outcome: "failed", reason: `issue found: ${issue.title}` };
  const exhausted = record.steps.find((step) => step.status === "exhausted");
  if (exhausted) return { outcome: "incomplete", reason: stepReason(exhausted) };
  if (record.ended !== "finished") return { outcome: "incomplete", reason: `the exploration stopped at its ${record.ended}` };
  if (record.steps.length === 0) return { outcome: "incomplete", reason: "the agent took no steps" };
  return { outcome: "passed", reason: null };
}

// Without a passing exploration nothing the agent did is written as a test: the item keeps the
// instructions as written, expected outcome included, and says why it was not written.
export function explorationDraftTranscript(input: {
  title: string;
  instructions: string;
  environmentName: string | null;
  outcome: ExplorationOutcome;
  reason: string | null;
}): string {
  const lines = [`# ${input.title}`];
  if (input.environmentName) lines.push(`Env: ${input.environmentName}`);
  lines.push("Tags: source:exploration", "");
  const why = `Exploration ${input.outcome}${input.reason ? `: ${input.reason}` : ""}. Not written from the exploration; review the instructions below.`;
  lines.push(serializeStepLine({ tag: "Note", args: [], text: why, disabled: false }));
  for (const line of input.instructions.split("\n").map((text) => text.trim()).filter((text) => text.length > 0)) {
    lines.push(serializeStepLine({ tag: "Note", args: [], text: line, disabled: false }));
  }
  return `${lines.join("\n")}\n`;
}

export type TranscriptGrounding = {
  // Organisation macros plus the runner's built-in ones (withBuiltinMacroSignatures).
  macros: ReadonlyArray<{ name: string; params: MacroParam[] }>;
  // Login credential profiles the exploration was given.
  profiles: readonly string[];
};

function usedProfiles(testCase: ParsedTestCase): string[] {
  const profiles = new Set<string>();
  for (const step of testCase.steps) {
    if (step.disabled) continue;
    if (step.type === "login") {
      const profile = loginProfileArg(step.args);
      if (profile) profiles.add(profile);
    }
    for (const ref of extractStepReferences([step.text, ...step.args.map((arg) => arg.value)]).credentialRefs) {
      const dot = ref.lastIndexOf(".");
      profiles.add(dot === -1 ? ref : ref.slice(0, dot));
    }
  }
  return [...profiles].filter((profile) => !profile.includes("{"));
}

// Problems that make a written transcript unusable: parse errors, lint errors (an unknown macro,
// a [Login] without a profile...) and credential profiles the exploration was not given.
export function transcriptProblems(text: string, grounding: TranscriptGrounding): string[] {
  const { testCase, diagnostics } = parseTestCaseTranscript(text);
  const problems = diagnostics.map((diagnostic) => `line ${diagnostic.line}: ${diagnostic.message}`);
  if (testCase.steps.filter((step) => !step.disabled && step.type !== "note").length === 0) problems.push("no executable steps");
  for (const finding of lintTestCase(testCase, { macros: grounding.macros })) {
    if (finding.severity === "error") problems.push(`${finding.line ? `line ${finding.line}: ` : ""}${finding.message}`);
  }
  const allowed = new Set(grounding.profiles.map((profile) => profile.toLowerCase()));
  for (const profile of usedProfiles(testCase)) {
    if (!allowed.has(profile.toLowerCase())) problems.push(`credential profile ${profile} was not part of the exploration`);
  }
  return [...new Set(problems)];
}

export function explorationTranscriptPrompt(input: {
  title: string;
  instructions: string;
  environmentName: string | null;
  record: ExplorationRecord;
  grounding?: TranscriptGrounding;
}): string {
  const steps = input.record.steps.map(
    (step) => `${step.index}. [${step.status}] ${step.title}: ${step.instruction}${step.summary ? `\n   observed: ${step.summary}` : ""}`
  );
  const findings = input.record.findings.map((finding) => `- ${finding.kind} (severity ${finding.severity}): ${finding.title}. Expected: ${finding.expected}. Actual: ${finding.actual}`);
  return [
    "Write one end-to-end test case as a Jittle Lamp transcript document from these instructions and what an agent did when it followed them on the real app.",
    "Format: a '# Title' line, then one step per line. Use [Open] <path> to navigate, [Act] <one user intent> for actions,",
    "[Assert] <specific expected result> for checks, and '## Checkpoint: <name>' headings to group asserts.",
    "Allowed step tags: [Open], [Act], [Assert], [Wait], [Screenshot], [Extract: name], [Note], and these macros only:",
    ...(input.grounding?.macros ?? []).map((macro) => `  [${macro.name}: ${macro.params.map((param) => param.name).join(", ") || "no params"}]`),
    input.grounding && input.grounding.profiles.length > 0
      ? `Sign in only with [Login: <PROFILE>] and only these credential profiles: ${input.grounding.profiles.join(", ")}.`
      : "No credential profile was given; do not write [Login] steps.",
    "Never write passwords or secrets. Use the visible labels the agent saw, not selectors.",
    "Do not add steps for stopping, waiting for the reader or finishing the test.",
    "Use {person.name}, {person.email}, {phone.number} or {location.address} where the instructions ask for made-up personal data.",
    "Keep the steps the instructions ask for; drop detours. Return only the transcript, without code fences or commentary.",
    "",
    `Title: ${input.title}`,
    ...(input.environmentName ? [`Environment: ${input.environmentName}`] : []),
    "Instructions:",
    input.instructions || "(none)",
    "",
    `What the agent did (ended: ${input.record.ended}):`,
    ...(steps.length > 0 ? steps : ["(no steps)"]),
    ...(input.record.summary ? ["", `Closing assessment: ${input.record.summary}`] : []),
    ...(findings.length > 0 ? ["", "Findings:", ...findings] : [])
  ].join("\n");
}

// For a passing exploration without a usable model transcript: one Act per explored step, then
// the closing assessment as an Assert. Reviewers tighten it in the review queue.
export function explorationFallbackTranscript(input: { title: string; record: ExplorationRecord; environmentName: string | null }): string {
  const lines = [`# ${input.title}`];
  if (input.environmentName) lines.push(`Env: ${input.environmentName}`);
  lines.push("Tags: source:exploration", "");
  for (const step of input.record.steps) {
    if (step.status === "blocked") continue;
    lines.push(serializeStepLine({ tag: "Act", args: [], text: step.instruction.replace(/\s+/g, " ").trim() || step.title, disabled: false }));
  }
  lines.push("", "## Checkpoint: Instructions followed");
  const outcome = input.record.summary?.replace(/\s+/g, " ").trim();
  lines.push(serializeStepLine({ tag: "Assert", args: [], text: outcome && outcome.length > 0 ? outcome : `${input.title} completed`, disabled: false }));
  return `${lines.join("\n")}\n`;
}

export function summarizeExploration(record: ExplorationRecord | null): Pick<ImportItemExploration, "ended" | "steps" | "findings" | "outcome"> {
  return {
    ended: record?.ended ?? null,
    steps: record?.steps.length ?? 0,
    findings: record?.findings.length ?? 0,
    outcome: record ? explorationOutcome(record).outcome : null
  };
}
