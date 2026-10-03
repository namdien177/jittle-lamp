import { z } from "zod/v4";

import { serializeStepLine } from "./test-case";

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
      summary: z.string().nullable().default(null)
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
  environment: z.object({
    name: z.string().min(1),
    baseUrl: z.string(),
    variables: z.record(z.string(), z.string()),
    agentInstructions: z.string().nullable(),
    dataLocale: z.string().nullable().default(null)
  }),
  credentials: z.array(z.object({ profile: z.string().min(1), fields: z.record(z.string(), z.string()), secretFields: z.record(z.string(), z.string()) })),
  model: z.object({ act: z.string().nullable(), judge: z.string().nullable(), apiKeys: z.record(z.string(), z.string()) }).nullable()
});

export const explorationResultRequestSchema = z.object({
  status: z.enum(["done", "failed"]),
  explore: explorationRecordSchema.nullable(),
  error: z.string().max(4000).nullable().default(null)
});

export const importItemExplorationSchema = z.object({
  status: explorationStatusSchema,
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

export function explorationTranscriptPrompt(input: { title: string; instructions: string; environmentName: string | null; record: ExplorationRecord }): string {
  const steps = input.record.steps.map(
    (step) => `${step.index}. [${step.status}] ${step.title}: ${step.instruction}${step.summary ? `\n   observed: ${step.summary}` : ""}`
  );
  const findings = input.record.findings.map((finding) => `- ${finding.kind} (severity ${finding.severity}): ${finding.title}. Expected: ${finding.expected}. Actual: ${finding.actual}`);
  return [
    "Write one end-to-end test case as a Jittle Lamp transcript document from these instructions and what an agent did when it followed them on the real app.",
    "Format: a '# Title' line, then one step per line. Use [Open] <path> to navigate, [Act] <one user intent> for actions,",
    "[Assert] <specific expected result> for checks, and '## Checkpoint: <name>' headings to group asserts.",
    "Refer to logins as [Login: <PROFILE>] and never write passwords or secrets. Use the visible labels the agent saw, not selectors.",
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

// Without a model: one Act per step the agent completed, then the closing assessment as an
// Assert. Reviewers tighten it in the review queue.
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

export function summarizeExploration(record: ExplorationRecord | null): Pick<ImportItemExploration, "ended" | "steps" | "findings"> {
  return { ended: record?.ended ?? null, steps: record?.steps.length ?? 0, findings: record?.findings.length ?? 0 };
}
