import type { TestRunSummary } from "@jittle-lamp/shared";

// Pure model of the case page (roadmap §3.4): the left pane's view, the run the right pane shows,
// the header menu, and the routes the page links to.

// The left pane shows the case one of three ways; the right pane always shows a run.
export type CaseView = "flow" | "steps" | "text";

export type CaseViewSegment = { id: CaseView; label: string };

export const viewSegments: readonly CaseViewSegment[] = [
  { id: "flow", label: "Flow" },
  { id: "steps", label: "Steps" },
  { id: "text", label: "Text" }
];

// Flow is the default for any case with steps; editing happens in Steps, and a case without
// steps has nothing to draw.
export function defaultView(input: { editing: boolean; steps: number; flowAvailable: boolean }): CaseView {
  if (input.editing) return "steps";
  if (input.flowAvailable && input.steps > 0) return "flow";
  return "steps";
}

// Cases that reuse other cases, query a database or call an API read best as a diagram.
const flowStepTypes: ReadonlySet<string> = new Set(["use", "query", "api"]);
export function hasFlowSteps(steps: ReadonlyArray<{ type: string; disabled: boolean }>): boolean {
  return steps.some((step) => !step.disabled && flowStepTypes.has(step.type));
}

// The run the right pane shows: the picked one while it is still listed, else the newest.
export function shownRun<T extends Pick<TestRunSummary, "id" | "queuedAt">>(runs: readonly T[], selectedRunId: string | null): T | null {
  const picked = selectedRunId === null ? undefined : runs.find((run) => run.id === selectedRunId);
  return picked ?? latestRun(runs);
}

// One line per run in the picker: outcome or status, when it was queued, which version it ran.
export function runPickerLabel(run: Pick<TestRunSummary, "status" | "outcome" | "queuedAt" | "transcriptVersion">, relative: (epochMs: number) => string): string {
  return `${run.outcome ?? run.status} · ${relative(run.queuedAt)} · v${run.transcriptVersion}`;
}

// Runs come newest first; the latest is the first that is not superseded by a retry.
export function latestRun<T extends Pick<TestRunSummary, "queuedAt">>(runs: readonly T[]): T | null {
  let latest: T | null = null;
  for (const run of runs) {
    if (!latest || run.queuedAt > latest.queuedAt) latest = run;
  }
  return latest;
}

export function caseHref(id: string): string {
  return `/test-cases/${encodeURIComponent(id)}`;
}

export function runHref(id: string): string {
  return `/test-runs/${encodeURIComponent(id)}`;
}

// `/test-cases/:id?edit=1` opens the editor in edit mode (what "Write steps myself" links to).
export function editingFromSearch(search: string): boolean {
  return new URLSearchParams(search).get("edit") === "1";
}

export type CaseMenuAction = "rename" | "tags" | "links" | "duplicate" | "archive" | "versions" | "export" | "clear-scripts";

export const caseMenuItems: ReadonlyArray<{ id: CaseMenuAction; label: string; destructive?: boolean }> = [
  { id: "rename", label: "Rename" },
  { id: "tags", label: "Tags" },
  { id: "links", label: "Links" },
  { id: "duplicate", label: "Duplicate" },
  { id: "versions", label: "Versions" },
  { id: "export", label: "Export .md" },
  { id: "clear-scripts", label: "Clear scripts", destructive: true },
  { id: "archive", label: "Archive", destructive: true }
];

export function exportFileName(key: string): string {
  return `${key.toLowerCase()}.transcript.md`;
}
