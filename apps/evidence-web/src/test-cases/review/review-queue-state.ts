import type { TestCaseSummary } from "@jittle-lamp/shared";

// Review queue (design.md §7): selection state and keyboard map. `a` approve, `x` reject (asks for a
// reason), `e` edit, `shift+a` approve every case without lint warnings or errors, `j`/`k` or the
// arrow keys to move. Pure so the page and the tests share it.

export type ReviewQueueState = {
  ids: string[];
  selectedId: string | null;
  rejecting: boolean;
};

export type ReviewQueueAction =
  | { type: "sync"; ids: readonly string[] }
  | { type: "move"; delta: 1 | -1 }
  | { type: "select"; id: string }
  | { type: "removed"; ids: readonly string[] }
  | { type: "start-reject" }
  | { type: "cancel-reject" };

export function initialReviewQueueState(ids: readonly string[] = []): ReviewQueueState {
  return { ids: [...ids], selectedId: ids[0] ?? null, rejecting: false };
}

export function reviewQueueReducer(state: ReviewQueueState, action: ReviewQueueAction): ReviewQueueState {
  switch (action.type) {
    case "sync": {
      const ids = [...action.ids];
      if (state.selectedId && ids.includes(state.selectedId)) return { ...state, ids };
      // The selected case left the queue (approved elsewhere): keep the position, not the id.
      const previousIndex = state.selectedId ? state.ids.indexOf(state.selectedId) : 0;
      const nextId = ids[Math.min(Math.max(previousIndex, 0), ids.length - 1)] ?? null;
      return { ids, selectedId: nextId, rejecting: false };
    }
    case "move": {
      if (state.ids.length === 0) return state;
      const index = state.selectedId ? state.ids.indexOf(state.selectedId) : -1;
      const nextIndex = Math.min(Math.max(index + action.delta, 0), state.ids.length - 1);
      return { ...state, selectedId: state.ids[nextIndex] ?? null, rejecting: false };
    }
    case "select":
      return state.ids.includes(action.id) ? { ...state, selectedId: action.id, rejecting: false } : state;
    case "removed": {
      const removed = new Set(action.ids);
      const ids = state.ids.filter((id) => !removed.has(id));
      if (!state.selectedId || !removed.has(state.selectedId)) return { ...state, ids, rejecting: false };
      // Select the next case after the removed one, or the previous when it was last.
      const index = state.ids.indexOf(state.selectedId);
      const after = state.ids.slice(index + 1).find((id) => !removed.has(id));
      const before = state.ids
        .slice(0, index)
        .reverse()
        .find((id) => !removed.has(id));
      return { ids, selectedId: after ?? before ?? null, rejecting: false };
    }
    case "start-reject":
      return state.selectedId ? { ...state, rejecting: true } : state;
    case "cancel-reject":
      return { ...state, rejecting: false };
  }
}

export type ReviewCommand = "approve" | "reject" | "edit" | "approve-clean" | "next" | "previous" | "cancel";

export type ReviewKeyInput = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  // Focus is in an input, textarea, select or contenteditable element.
  editableTarget: boolean;
};

export function reviewKeyCommand(input: ReviewKeyInput, options: { canApprove: boolean; rejecting: boolean }): ReviewCommand | null {
  if (input.metaKey || input.ctrlKey || input.altKey) return null;
  if (input.key === "Escape") return options.rejecting ? "cancel" : null;
  if (input.editableTarget || options.rejecting) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === "j" || key === "ArrowDown") return "next";
  if (key === "k" || key === "ArrowUp") return "previous";
  if (key === "e" && !input.shiftKey) return "edit";
  if (!options.canApprove) return null;
  if (key === "a") return input.shiftKey ? "approve-clean" : "approve";
  if (key === "x" && !input.shiftKey) return "reject";
  return null;
}

// Cases that `shift+a` approves: no lint errors and no warnings.
export function cleanCaseIds(items: readonly Pick<TestCaseSummary, "id" | "lintErrors" | "lintWarnings">[]): string[] {
  return items.filter((item) => item.lintErrors === 0 && item.lintWarnings === 0).map((item) => item.id);
}

// The editor belongs to the test-case list page; the review queue only links to it.
export function caseEditorHref(id: string): string {
  return `/test-cases?case=${encodeURIComponent(id)}`;
}

// `shift+a` never approves directly: it opens this confirmation (null when nothing qualifies).
export function approveCleanPrompt(
  items: readonly Pick<TestCaseSummary, "id" | "lintErrors" | "lintWarnings">[]
): { ids: string[]; title: string; confirmLabel: string; description: string } | null {
  const ids = cleanCaseIds(items);
  if (ids.length === 0) return null;
  return {
    ids,
    title: `Approve ${ids.length} case${ids.length === 1 ? "" : "s"}?`,
    confirmLabel: `Approve ${ids.length}`,
    description: `Every case in the queue without lint errors or warnings (${ids.length} of ${items.length}) becomes active and runnable.`
  };
}
