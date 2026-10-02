import { parseTranscriptDocument } from "@jittle-lamp/shared";

// Duplicate dialog logic (design.md §7 "Duplicate"): literal find/replace over title and transcript,
// a highlighted preview, and how many steps keep their instructionKey (those inherit the source's
// step scripts, so the copy replays them on its first run).

export type Replacement = { find: string; replace: string };

export type PreviewSegment = { text: string; replaced: false } | { text: string; replaced: true; original: string };

// Rows with an empty "find" are ignored; later rows with the same "find" lose to the first.
export function activeReplacements(rows: readonly Replacement[]): Replacement[] {
  const seen = new Set<string>();
  const result: Replacement[] = [];
  for (const row of rows) {
    if (row.find.length === 0 || seen.has(row.find)) continue;
    seen.add(row.find);
    result.push({ find: row.find, replace: row.replace });
  }
  return result;
}

// Applied in order, each row over the result of the previous one (the backend's
// `text.split(find).join(replace)` chain), so the preview matches the duplicate exactly. Replaced
// text keeps its highlight even when a later row rewrites it.
export function replacementSegments(text: string, rows: readonly Replacement[]): PreviewSegment[] {
  let segments: PreviewSegment[] = text.length > 0 ? [{ text, replaced: false }] : [];
  for (const replacement of activeReplacements(rows)) {
    const next: PreviewSegment[] = [];
    for (const segment of segments) {
      const parts = segment.text.split(replacement.find);
      if (parts.length === 1) {
        next.push(segment);
        continue;
      }
      parts.forEach((part, index) => {
        if (index > 0 && replacement.replace.length > 0) {
          next.push({ text: replacement.replace, replaced: true, original: segment.replaced ? segment.original : replacement.find });
        }
        if (part.length > 0) next.push(segment.replaced ? { text: part, replaced: true, original: segment.original } : { text: part, replaced: false });
      });
    }
    segments = mergePlainSegments(next);
  }
  return segments;
}

function mergePlainSegments(segments: readonly PreviewSegment[]): PreviewSegment[] {
  const merged: PreviewSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && !last.replaced && !segment.replaced) merged[merged.length - 1] = { text: last.text + segment.text, replaced: false };
    else merged.push(segment);
  }
  return merged;
}

export function applyReplacements(text: string, rows: readonly Replacement[]): string {
  return replacementSegments(text, rows)
    .map((segment) => segment.text)
    .join("");
}

export function countReplacements(text: string, rows: readonly Replacement[]): number {
  let current = text;
  let count = 0;
  for (const replacement of activeReplacements(rows)) {
    count += current.split(replacement.find).length - 1;
    current = current.split(replacement.find).join(replacement.replace);
  }
  return count;
}

export function defaultDuplicateTitle(title: string): string {
  return `${title} (copy)`;
}

export type InheritEstimate = { unchanged: number; total: number };

// Steps of the copy whose instructionKey also exists in the source. The server decides; this is the
// live estimate shown while the user edits replacements.
export function estimateInheritedSteps(sourceTranscript: string, nextTranscript: string): InheritEstimate {
  const keys = (text: string) => parseTranscriptDocument(text).cases.flatMap((testCase) => testCase.steps.map((step) => step.instructionKey));
  const sourceKeys = new Set(keys(sourceTranscript));
  const nextKeys = keys(nextTranscript);
  return { unchanged: nextKeys.filter((key) => sourceKeys.has(key)).length, total: nextKeys.length };
}

// Comma-separated tag input → tag list without blanks or repeats.
export function parseTagInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    )
  ];
}

// `?duplicate=id1,id2` on the test-cases route.
export function parseDuplicateParam(value: string | null): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    )
  ].slice(0, 100);
}
