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

// Single left-to-right pass, longest match first at each position, so replacements do not chain
// (`A→B`, `B→C` turns "AB" into "BC", not "CC").
export function replacementSegments(text: string, rows: readonly Replacement[]): PreviewSegment[] {
  const replacements = activeReplacements(rows).sort((left, right) => right.find.length - left.find.length);
  if (replacements.length === 0) return text.length > 0 ? [{ text, replaced: false }] : [];
  const segments: PreviewSegment[] = [];
  let plain = "";
  let index = 0;
  while (index < text.length) {
    const match = replacements.find((replacement) => text.startsWith(replacement.find, index));
    if (match) {
      if (plain.length > 0) segments.push({ text: plain, replaced: false });
      plain = "";
      segments.push({ text: match.replace, replaced: true, original: match.find });
      index += match.find.length;
    } else {
      plain += text[index];
      index += 1;
    }
  }
  if (plain.length > 0) segments.push({ text: plain, replaced: false });
  return segments;
}

export function applyReplacements(text: string, rows: readonly Replacement[]): string {
  return replacementSegments(text, rows)
    .map((segment) => segment.text)
    .join("");
}

export function countReplacements(text: string, rows: readonly Replacement[]): number {
  return replacementSegments(text, rows).filter((segment) => segment.replaced).length;
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
