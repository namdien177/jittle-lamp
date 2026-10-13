import { parseTestCaseTranscript, type LintFinding, type ParsedTestCase, type TestEnvironment } from "@jittle-lamp/shared";

import type { StorageLike } from "./list-model";

// Pure model of "What do you want to test?" (roadmap §3.2): the placeholder case "Write steps
// myself" saves, the environment the dialog opens on, the start-from picker and the draft view.

// The first non-empty line of the description, as the placeholder title.
export function placeholderTitle(text: string): string {
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ? first.replace(/^#+\s*/, "").slice(0, 200) : "Untitled test";
}

// What "Write steps myself" creates: the description kept as [Note] lines under the placeholder
// title, so nothing typed is lost and the editor opens on it.
export function manualTranscript(text: string): string {
  const notes = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `[Note] ${line.replace(/^#+\s*/, "")}`);
  return `# ${placeholderTitle(text)}\n${notes.length > 0 ? `\n${notes.join("\n")}\n` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Last used environment, per organisation
// ---------------------------------------------------------------------------------------------

export function lastEnvironmentKey(orgId: string): string {
  return `jl-test-case-last-env:${orgId}`;
}

export function loadLastEnvironment(storage: StorageLike | null, orgId: string | null): string | null {
  if (!storage || !orgId) return null;
  try {
    return storage.getItem(lastEnvironmentKey(orgId));
  } catch {
    return null;
  }
}

export function storeLastEnvironment(storage: StorageLike | null, orgId: string | null, environmentId: string): void {
  if (!storage || !orgId) return;
  try {
    storage.setItem(lastEnvironmentKey(orgId), environmentId);
  } catch {
    // Quota or privacy mode: the choice lasts for this dialog only.
  }
}

// The stored environment when it still exists, else the first one.
export function defaultEnvironmentId(environments: ReadonlyArray<Pick<TestEnvironment, "id">>, stored: string | null): string {
  if (stored && environments.some((environment) => environment.id === stored)) return stored;
  return environments[0]?.id ?? "";
}

// ---------------------------------------------------------------------------------------------
// Start-from picker
// ---------------------------------------------------------------------------------------------

// The key doubles as the API id: the draft route resolves cases by id or key.
export type StartFromCase = { key: string; title: string };

// Key or title match, key matches first; at most `limit` rows so the list stays short.
export function filterStartFromCases(cases: readonly StartFromCase[], query: string, limit = 8): StartFromCase[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return cases.slice(0, limit);
  const byKey = cases.filter((testCase) => testCase.key.toLowerCase().includes(q));
  const byTitle = cases.filter((testCase) => !byKey.includes(testCase) && testCase.title.toLowerCase().includes(q));
  return [...byKey, ...byTitle].slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Draft view
// ---------------------------------------------------------------------------------------------

export type DraftRow =
  | { kind: "checkpoint"; id: string; title: string }
  | { kind: "step"; id: string; type: ParsedTestCase["steps"][number]["type"]; tag: string; text: string; disabled: boolean };

// Steps and checkpoint headers in document order, for the read-only draft list.
export function draftRows(transcript: string): DraftRow[] {
  const { testCase } = parseTestCaseTranscript(transcript);
  const checkpoints = new Map(testCase.checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]));
  const rows: DraftRow[] = [];
  let currentCheckpoint: string | null = null;
  for (const step of testCase.steps) {
    if (step.checkpointId && step.checkpointId !== currentCheckpoint) {
      currentCheckpoint = step.checkpointId;
      const checkpoint = checkpoints.get(step.checkpointId);
      rows.push({ kind: "checkpoint", id: step.checkpointId, title: checkpoint?.title ?? "Checkpoint" });
    }
    rows.push({
      kind: "step",
      id: step.stepId,
      type: step.type,
      tag: step.tag ?? "Act",
      text: step.text || step.args.map((arg) => arg.value).join(", "),
      disabled: step.disabled
    });
  }
  return rows;
}

// The transcript with its `# Title` line replaced; the rest is untouched.
export function withTitle(transcript: string, title: string): string {
  const clean = title.replace(/\r?\n/g, " ").trim() || "Untitled test";
  const lines = transcript.split("\n");
  const heading = lines.findIndex((line) => /^#\s/.test(line));
  if (heading === -1) return `# ${clean}\n\n${transcript}`;
  lines[heading] = `# ${clean}`;
  return lines.join("\n");
}

// One line for the lint summary: "2 errors · 1 warning", or null when the draft is clean.
export function lintSummary(lint: readonly LintFinding[]): string | null {
  const errors = lint.filter((finding) => finding.severity === "error").length;
  const warnings = lint.filter((finding) => finding.severity === "warning").length;
  const parts = [errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : null, warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null].filter(
    (part): part is string => part !== null
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

// The error line under the textarea, by the server's code.
export function describeDraftError(error: unknown): string {
  const like = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof like.code === "string" ? like.code : null;
  const message = typeof like.message === "string" && like.message.length > 0 ? like.message : "The draft failed.";
  if (code === "DRAFT_UNPARSEABLE") return "The model could not write these steps. Add detail, or write them yourself.";
  if (code?.startsWith("MODEL_")) return "The organisation's model is not set up. Ask an admin to check Testing settings.";
  if (like.status === 403) return "You cannot draft with AI here; write the steps yourself.";
  return message;
}
