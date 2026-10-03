import type { ImportBatch, ImportItem, LintFinding } from "@jittle-lamp/shared";

import { toCsv } from "./csv";

// Batch page logic (design.md §7 "Import pipeline"): duplicate classes, decision options,
// "apply to all similar", progress and the error CSV.

export type ImportDecision = ImportItem["decision"];
export type SimilarityClass = "exact" | "near" | "none";

export function similarityClass(item: Pick<ImportItem, "similar">): SimilarityClass {
  if (item.similar.some((match) => match.exact)) return "exact";
  return item.similar.length > 0 ? "near" : "none";
}

export function bestMatch(item: Pick<ImportItem, "similar">): ImportItem["similar"][number] | null {
  const exact = item.similar.find((match) => match.exact);
  if (exact) return exact;
  return [...item.similar].sort((left, right) => right.score - left.score)[0] ?? null;
}

export type DecisionOption = { value: ImportDecision; label: string };

// update and merge target the best match, so they need one.
export function decisionOptions(item: Pick<ImportItem, "similar">): DecisionOption[] {
  const match = bestMatch(item);
  const options: DecisionOption[] = [{ value: "create", label: "Create new" }];
  if (match) {
    options.push({ value: "update", label: `Update ${match.key}` });
    options.push({ value: "merge", label: `Merge into ${match.key}` });
  }
  options.push({ value: "skip", label: "Skip" });
  return options;
}

export function itemIsEditable(item: Pick<ImportItem, "state">): boolean {
  return item.state === "ready" || item.state === "pending";
}

// Applies `decision` to every editable item in the same similarity class as `source` (the
// "apply to all similar" action). Items where the decision is invalid (update without a match)
// or already set are left out.
export function applyDecisionToSimilar(
  items: readonly ImportItem[],
  source: Pick<ImportItem, "id" | "similar">,
  decision: ImportDecision
): Array<{ itemId: string; decision: ImportDecision }> {
  const kind = similarityClass(source);
  return items
    .filter((item) => item.id !== source.id && itemIsEditable(item) && similarityClass(item) === kind && item.decision !== decision)
    .filter((item) => decisionOptions(item).some((option) => option.value === decision))
    .map((item) => ({ itemId: item.id, decision }));
}

export type LintCounts = { errors: number; warnings: number; infos: number };

export function lintCounts(lint: readonly Pick<LintFinding, "severity">[]): LintCounts {
  return {
    errors: lint.filter((finding) => finding.severity === "error").length,
    warnings: lint.filter((finding) => finding.severity === "warning").length,
    infos: lint.filter((finding) => finding.severity === "info").length
  };
}

// One line on an explored item: where it is in its exploration, or what came of it.
export function explorationLabel(item: Pick<ImportItem, "exploration">): { text: string; tone: "muted" | "active" | "danger" } | null {
  const exploration = item.exploration;
  if (!exploration) return null;
  const where = exploration.environmentName ? ` on ${exploration.environmentName}` : "";
  switch (exploration.status) {
    case "queued":
      return { text: `Waiting for a runner${where}`, tone: "muted" };
    case "running":
      return { text: `Trying the instructions${where}${exploration.attempts > 1 ? ` (attempt ${exploration.attempts})` : ""}`, tone: "active" };
    case "done": {
      const findings = exploration.findings > 0 ? ` · ${exploration.findings} finding${exploration.findings === 1 ? "" : "s"}` : "";
      const note = exploration.error ? ` · ${exploration.error}` : "";
      return { text: `Explored${where}: ${exploration.steps} step${exploration.steps === 1 ? "" : "s"}${findings}${note}`, tone: exploration.error ? "danger" : "muted" };
    }
    case "failed":
      return { text: `Not explored${where}: ${exploration.error ?? "the runner gave up"}`, tone: "danger" };
  }
}

export type BatchOverview = {
  percent: number;
  active: boolean;
  exact: number;
  near: number;
  lintErrors: number;
  normalising: number;
  // Items still waiting for or in their exploration.
  exploring: number;
  toCreate: number;
  toUpdate: number;
  toMerge: number;
  toSkip: number;
};

export function batchOverview(batch: Pick<ImportBatch, "status" | "counts" | "items">): BatchOverview {
  const done = batch.counts.created + batch.counts.updated + batch.counts.skipped + batch.counts.errors;
  const total = Math.max(batch.counts.total, batch.items.length);
  const percent =
    batch.status === "done"
      ? 100
      : batch.status === "committing" && total > 0
        ? Math.min(99, Math.round((done / total) * 100))
        : batch.status === "parsing" && total > 0
          ? Math.min(99, Math.round((batch.items.filter((item) => item.state !== "pending").length / total) * 100))
          : batch.status === "ready"
            ? 100
            : 0;
  const editable = batch.items.filter(itemIsEditable);
  return {
    percent,
    active: batch.status === "parsing" || batch.status === "committing",
    exact: batch.items.filter((item) => similarityClass(item) === "exact").length,
    near: batch.items.filter((item) => similarityClass(item) === "near").length,
    lintErrors: batch.items.filter((item) => lintCounts(item.lint).errors > 0).length,
    normalising: batch.items.filter((item) => item.state === "pending").length,
    exploring: batch.items.filter((item) => item.exploration?.status === "queued" || item.exploration?.status === "running").length,
    toCreate: editable.filter((item) => item.decision === "create").length,
    toUpdate: editable.filter((item) => item.decision === "update").length,
    toMerge: editable.filter((item) => item.decision === "merge").length,
    toSkip: editable.filter((item) => item.decision === "skip").length
  };
}

// Rows the error CSV lists: failed rows and rows with lint errors.
export function importErrorRows(items: readonly ImportItem[]): ImportItem[] {
  return items.filter((item) => item.state === "error" || item.error !== null || lintCounts(item.lint).errors > 0);
}

export function importErrorsCsv(items: readonly ImportItem[]): string {
  const rows: string[][] = [["row", "external_id", "title", "state", "error", "lint_errors"]];
  for (const item of importErrorRows(items)) {
    const lint = item.lint
      .filter((finding) => finding.severity === "error")
      .map((finding) => (finding.line ? `line ${finding.line}: ${finding.message}` : finding.message))
      .join(" | ");
    rows.push([String(item.ordinal + 1), item.externalId ?? "", item.title, item.state, item.error ?? "", lint]);
  }
  return `${toCsv(rows)}\r\n`;
}
