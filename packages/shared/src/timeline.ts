import type { ActionMergeGroup, NetworkSubtype, SessionArchive } from "./session";

export type TimelineKind = "lifecycle" | "interaction" | "network" | "console" | "error";
export type TimelineSection = "actions" | "console" | "network";

export type TimelineItem = {
  id: string;
  offsetMs: number;
  seq: number;
  at: string;
  kind: TimelineKind;
  section: TimelineSection;
  label: string;
  subtype?: NetworkSubtype;
  tags?: string[];
  payload:
    | SessionArchive["sections"]["actions"][number]["payload"]
    | SessionArchive["sections"]["console"][number]["payload"]
    | SessionArchive["sections"]["network"][number]["payload"];
};

export type VisibleActionRow = {
  id: string;
  memberActionIds: string[];
};

export function deriveAnchorMs(archive: SessionArchive): number {
  const timestamps = [archive.createdAt, ...archive.sections.actions.map((entry) => entry.at)];

  for (const action of archive.sections.actions) {
    if (action.payload.kind === "lifecycle" && action.payload.phase === "recording") {
      return new Date(action.at).getTime();
    }
  }

  let earliest = Infinity;
  for (const timestamp of timestamps) {
    const value = new Date(timestamp).getTime();
    if (value < earliest) earliest = value;
  }

  return earliest === Infinity ? 0 : earliest;
}

export function buildTimeline(archive: SessionArchive): TimelineItem[] {
  const anchorMs = deriveAnchorMs(archive);

  const items: TimelineItem[] = [
    ...archive.sections.actions.map((entry) => ({
      id: entry.id,
      offsetMs: new Date(entry.at).getTime() - anchorMs,
      seq: entry.seq,
      at: entry.at,
      kind: entry.payload.kind,
      section: "actions" as const,
      label: buildActionLabel(entry.payload),
      tags: entry.tags,
      payload: entry.payload
    })),
    ...archive.sections.console.map((entry) => ({
      id: entry.id,
      offsetMs: new Date(entry.at).getTime() - anchorMs,
      seq: entry.seq,
      at: entry.at,
      kind: "console" as const,
      section: "console" as const,
      label: entry.payload.message,
      payload: entry.payload
    })),
    ...archive.sections.network.map((entry) => ({
      id: entry.id,
      offsetMs: new Date(entry.at).getTime() - anchorMs,
      seq: entry.seq,
      at: entry.at,
      kind: "network" as const,
      section: "network" as const,
      label: `${entry.payload.method} ${entry.payload.url}`,
      subtype: entry.subtype,
      payload: entry.payload
    }))
  ];

  items.sort((a, b) => a.offsetMs - b.offsetMs || a.seq - b.seq);
  return items;
}

export function buildSectionTimeline(
  archive: SessionArchive,
  section: TimelineSection,
  subtypeFilter: NetworkSubtype | "all" = "all",
  networkSearchQuery = ""
): TimelineItem[] {
  let mixed = buildTimeline(archive).filter((item) => item.section === section);
  if (section === "actions") {
    mixed = mixed.filter((item) => item.kind === "interaction" || item.kind === "error");
  }

  if (section === "network" && subtypeFilter !== "all") {
    mixed = mixed.filter((item) => item.subtype === subtypeFilter);
  }

  if (section === "network" && networkSearchQuery.trim()) {
    mixed = mixed.filter((item) => matchesNetworkSearch(item, networkSearchQuery));
  }

  return mixed;
}

export function findActiveIndex(items: ReadonlyArray<TimelineItem>, currentTimeMs: number): number {
  let result = -1;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item !== undefined && item.offsetMs <= currentTimeMs) {
      result = i;
    } else {
      break;
    }
  }
  return result;
}

export function formatOffset(offsetMs: number): string {
  const prefix = offsetMs < 0 ? "-" : "";
  const abs = Math.abs(offsetMs);
  const totalSeconds = Math.floor(abs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${prefix}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function buildVisibleActionRows(
  archive: SessionArchive,
  mergeGroups: ReadonlyArray<ActionMergeGroup>
): VisibleActionRow[] {
  const actionItems = buildSectionTimeline(archive, "actions");
  const rows: VisibleActionRow[] = [];
  const seenGroupIds = new Set<string>();
  const mergedMemberIds = new Set(mergeGroups.flatMap((group) => group.memberIds));

  for (const item of actionItems) {
    const group = mergeGroups.find((candidate) => candidate.memberIds.includes(item.id));
    if (group) {
      if (seenGroupIds.has(group.id)) {
        continue;
      }
      seenGroupIds.add(group.id);
      rows.push({
        id: group.id,
        memberActionIds: [...group.memberIds]
      });
      continue;
    }

    if (mergedMemberIds.has(item.id)) {
      continue;
    }

    rows.push({
      id: item.id,
      memberActionIds: [item.id]
    });
  }

  return rows;
}

export function buildVisibleActionRangeSelection(
  archive: SessionArchive,
  mergeGroups: ReadonlyArray<ActionMergeGroup>,
  anchorId: string,
  targetId: string
): string[] {
  const visibleRows = buildVisibleActionRows(archive, mergeGroups);
  const visibleIds = visibleRows.map((row) => row.id);
  const anchorIdx = visibleIds.indexOf(anchorId);
  const targetIdx = visibleIds.indexOf(targetId);

  if (anchorIdx === -1 || targetIdx === -1) {
    return [];
  }

  const lo = Math.min(anchorIdx, targetIdx);
  const hi = Math.max(anchorIdx, targetIdx);
  return visibleIds.slice(lo, hi + 1);
}

export function getContiguousMergeableActionIds(
  archive: SessionArchive,
  mergeGroups: ReadonlyArray<ActionMergeGroup>,
  selectedIds: Iterable<string>
): string[] {
  const visibleRows = buildVisibleActionRows(archive, mergeGroups);
  const selected = new Set(selectedIds);
  const selectedRows = visibleRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => selected.has(row.id));

  if (selectedRows.length !== selected.size) {
    return [];
  }

  if (selectedRows.length < 2) {
    return [];
  }

  if (selectedRows.some(({ row }) => row.memberActionIds.length !== 1)) {
    return [];
  }

  const firstIndex = selectedRows[0]?.index ?? -1;
  const lastIndex = selectedRows.at(-1)?.index ?? -1;

  if (firstIndex === -1 || lastIndex === -1) {
    return [];
  }

  if (lastIndex - firstIndex + 1 !== selectedRows.length) {
    return [];
  }

  return selectedRows.map(({ row }) => row.memberActionIds[0]!).filter(Boolean);
}

function buildActionLabel(
  payload:
    | SessionArchive["sections"]["actions"][number]["payload"]
): string {
  switch (payload.kind) {
    case "lifecycle":
      return `${payload.phase}: ${payload.detail}`;
    case "interaction":
      return buildInteractionLabel(payload);
    case "error":
      return payload.message;
  }
}

function buildInteractionLabel(payload: SessionArchive["sections"]["actions"][number]["payload"]): string {
  if (payload.kind !== "interaction") {
    return "";
  }

  const targetText = payload.target?.textPreview ?? payload.valuePreview;
  const targetType = describeInteractionTarget(payload);
  const selector = payload.selector ?? payload.target?.selector;

  switch (payload.type) {
    case "click":
      if (targetText) {
        return `Click "${truncateLabelText(targetText)}" ${targetType}`;
      }
      return selector ? `click ${selector}` : "click";

    case "input":
      if (targetText) {
        return `Input "${truncateLabelText(targetText)}" ${targetType}`;
      }
      return selector ? `input ${selector}` : "input";

    case "submit":
      if (targetText) {
        return `Submit "${truncateLabelText(targetText)}" ${targetType}`;
      }
      return selector ? `submit ${selector}` : "submit";

    case "keyboard":
      if (targetText) {
        return `Key ${payload.key} in "${truncateLabelText(targetText)}" ${targetType}`;
      }
      return selector ? `keyboard ${selector}` : "keyboard";

    case "selection":
      return `Highlight "${truncateLabelText(payload.selectedText)}"`;

    case "navigation":
      return payload.title ? `Navigate to "${truncateLabelText(payload.title)}"` : `navigation ${payload.url}`;
  }
}

function describeInteractionTarget(payload: Extract<SessionArchive["sections"]["actions"][number]["payload"], { kind: "interaction" }>): string {
  const target = payload.target;
  const tagName = target?.tagName?.toLowerCase();
  const role = target?.role?.toLowerCase() ?? undefined;
  const inputType = target?.inputType?.toLowerCase();

  if (tagName === "button" || role === "button" || inputType === "button" || inputType === "submit") {
    return "button";
  }

  if (tagName === "a" || role === "link" || target?.href) {
    return "link";
  }

  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return "field";
  }

  if (role) {
    return role;
  }

  return tagName ?? "element";
}

function truncateLabelText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
}

function matchesNetworkSearch(item: TimelineItem, query: string): boolean {
  if (item.payload.kind !== "network") {
    return false;
  }

  const haystack = [
    item.payload.method,
    item.payload.url,
    item.payload.statusText ?? "",
    item.payload.failureText ?? "",
    ...item.payload.request.headers.flatMap((header) => [header.name, header.value]),
    ...(item.payload.response?.headers ?? []).flatMap((header) => [header.name, header.value]),
    item.payload.request.body?.value ?? "",
    item.payload.response?.body?.value ?? ""
  ].join("\n");

  const regexMatch = query.trim().match(/^\/(.*)\/([dgimsuvy]*)$/);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1] ?? "", regexMatch[2] ?? "").test(haystack);
    } catch {
      return false;
    }
  }

  return haystack.toLowerCase().includes(query.trim().toLowerCase());
}
