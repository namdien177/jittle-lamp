import { evidenceRowHeight, getRowWindow } from "./row-window";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { ChevronsLeft, ChevronsRight, GripVertical } from "lucide-react";

import { formatOffset, type NetworkSubtype, type TimelineSection } from "@jittle-lamp/shared";

import { NetworkDrawer } from "./drawers";
import { statusTone } from "./format";
import type { ViewerModalProps, ViewerModalRow } from "./types";

const NETWORK_SUBTYPE_OPTIONS: ReadonlyArray<{ value: NetworkSubtype | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "xhr", label: "XHR" },
  { value: "fetch", label: "Fetch" },
  { value: "document", label: "HTML" },
  { value: "stylesheet", label: "CSS" },
  { value: "script", label: "JS" },
  { value: "image", label: "Img" },
  { value: "font", label: "Font" },
  { value: "media", label: "Media" },
  { value: "websocket", label: "WS" },
  { value: "other", label: "Other" }
];

type EvidenceTab = TimelineSection | "about";
const DEFAULT_STREAM_WIDTH = 560;
const MIN_STREAM_WIDTH = 320;
const MAX_STREAM_WIDTH = 760;

function clampStreamWidth(width: number): number {
  return Math.min(MAX_STREAM_WIDTH, Math.max(MIN_STREAM_WIDTH, Math.round(width)));
}

function getVisibleRows(tab: EvidenceTab, rows: ViewerModalRow[], searchQuery: string): ViewerModalRow[] {
  if (tab === "about") return [];
  return applyClientSearch(rows, searchQuery, tab);
}

function getCountValue(tab: EvidenceTab, count: number): string {
  if (tab === "about") return "Info";
  return String(count);
}

function getCountLabel(tab: EvidenceTab, count: number): string {
  if (tab === "about") return "Extension details";
  if (count === 1) return "1 entry";
  return `${count} entries`;
}

function getCountTitle(tab: EvidenceTab): string {
  if (tab === "actions") return "Number of actions";
  if (tab === "console") return "Number of logs";
  if (tab === "network") return "Number of network entries";
  return "Extension details";
}

export function EvidencePane(props: ViewerModalProps): React.JSX.Element {
  const localRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = props.timelineRef ?? localRef;
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [activeTab, setActiveTab] = useState<EvidenceTab>(props.activeSection);
  const [collapsed, setCollapsed] = useState(false);
  const [streamWidth, setStreamWidth] = useState(DEFAULT_STREAM_WIDTH);
  useEffect(() => setActiveTab(props.activeSection), [props.activeSection]);
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const resize = resizeRef.current;
      if (!resize) return;
      setStreamWidth(clampStreamWidth(resize.startWidth + resize.startX - event.clientX));
    };
    const handlePointerUp = (): void => {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      handlePointerUp();
    };
  }, []);

  const sectionLabels = {
    actions: "Actions",
    console: "Logs",
    network: "Requests",
    about: "Info"
  } as const;
  const filteredRows = useMemo(() => getVisibleRows(activeTab, props.rows, props.searchQuery), [activeTab, props.rows, props.searchQuery]);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const virtual = props.compact && filteredRows.length > 100;
  const rowWindow = virtual ? getRowWindow(filteredRows.length, viewport.top, viewport.height) :
    { start: 0, end: filteredRows.length, before: 0, after: 0 };
  useEffect(() => {
    const list = timelineRef.current;
    if (!list) return;
    const measure = (): void => setViewport({ top: list.scrollTop, height: list.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    measure();
    return () => observer.disconnect();
  }, [activeTab, collapsed, timelineRef]);
  useLayoutEffect(() => {
    const list = timelineRef.current;
    if (!list) return;
    list.scrollTop = 0;
    setViewport({ top: 0, height: list.clientHeight });
  }, [activeTab, props.searchQuery, props.subtypeFilter, timelineRef]);
  useLayoutEffect(() => {
    if (!virtual || !props.autoFollow || !props.activeItemId) return;
    const index = filteredRows.findIndex(row => row.id === props.activeItemId);
    const list = timelineRef.current;
    if (!list || index < 0) return;
    const top = index * evidenceRowHeight;
    if (top < list.scrollTop || top + evidenceRowHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 2);
      setViewport({ top: list.scrollTop, height: list.clientHeight });
    }
  }, [props.activeItemId, props.autoFollow, filteredRows, virtual, timelineRef]);
  const activeCountValue = getCountValue(activeTab, filteredRows.length);
  const activeCountLabel = getCountLabel(activeTab, filteredRows.length);
  const activeCountTitle = getCountTitle(activeTab);

  return (
    <div
      className="jl-vm-right"
      data-collapsed={collapsed ? "true" : "false"}
      style={{ "--jl-vm-stream-width": `${streamWidth}px` } as React.CSSProperties}
    >
      {collapsed ? (
        <button
          type="button"
          className="jl-vm-stream-rail"
          aria-label="Expand Evidence stream"
          title="Expand Evidence stream"
          onClick={() => setCollapsed(false)}
        >
          <ChevronsLeft aria-hidden size={16} strokeWidth={2} />
          <span>Evidence stream</span>
        </button>
      ) : (
        <div
          className="jl-vm-stream-resizer"
          role="separator"
          aria-label="Resize Evidence stream"
          aria-orientation="vertical"
          aria-valuemin={MIN_STREAM_WIDTH}
          aria-valuemax={MAX_STREAM_WIDTH}
          aria-valuenow={streamWidth}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            resizeRef.current = { startX: event.clientX, startWidth: streamWidth };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? 1 : -1;
            setStreamWidth((width) => clampStreamWidth(width + direction * 24));
          }}
        >
          <GripVertical aria-hidden size={14} strokeWidth={2} />
        </div>
      )}
      <div className="jl-vm-evidence">
        {!props.compact ? <div className="jl-vm-pane-heading">
          <div className="jl-vm-pane-title">
            <span className="jl-vm-eyebrow">Evidence stream</span>
            <strong>{sectionLabels[activeTab]}</strong>
          </div>
          <div className="jl-vm-pane-heading-actions">
            <span
              className="jl-vm-pane-count"
              data-count={activeCountValue}
              title={activeCountTitle}
              aria-label={activeCountTitle}
            >
              {activeCountLabel}
            </span>
            <button
              type="button"
              className="jl-vm-icon-btn"
              aria-label="Collapse Evidence stream"
              title="Collapse Evidence stream"
              onClick={() => setCollapsed(true)}
            >
              <ChevronsRight aria-hidden size={16} strokeWidth={2} />
            </button>
          </div>
        </div> : null}
        <div className="jl-vm-tabs-row">
          <div className="jl-vm-tabs">
            {(["actions", "network", "console", "about"] as const).map((section) => (
              <button
                key={section}
                type="button"
                className="jl-vm-tab"
                aria-pressed={section === activeTab}
                data-active={section === activeTab ? "true" : "false"}
                onClick={() => {
                  setActiveTab(section);
                  if (section !== "about") props.onSectionChange(section);
                  else props.onInfoOpen?.();
                }}
              >
                {sectionLabels[section]}
              </button>
            ))}
          </div>
          {activeTab === "about" ? null : (
            <input
              className="jl-vm-search"
              type="search"
              placeholder="Search…"
              aria-label="Search evidence entries"
              value={props.searchQuery}
              onChange={(event) => props.onSearchChange(event.currentTarget.value)}
            />
          )}
        </div>
        {activeTab === "network" ? (
          <div className="jl-vm-filters">
            {NETWORK_SUBTYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="jl-vm-chip"
                data-active={opt.value === props.subtypeFilter ? "true" : "false"}
                onClick={() => props.onSubtypeFilterChange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="jl-vm-list-wrap">
          {activeTab === "about" ? (
            <AboutEvidencePanel about={props.aboutEvidence} recordedBy={props.recordedBy ?? null} />
          ) : (
            <div
              className="jl-vm-list"
              ref={timelineRef}
              tabIndex={0}
              aria-label={`${sectionLabels[activeTab]} entries`}
              onScroll={event => {
                if (virtual) setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight });
              }}
              onKeyDown={event => {
                if (!virtual || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
                const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-item-id]");
                const current = filteredRows.findIndex(row => row.id === button?.dataset.itemId);
                const next = Math.max(0, Math.min(filteredRows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
                const row = filteredRows[next];
                if (!row) return;
                event.preventDefault();
                props.onUserScroll?.();
                event.currentTarget.scrollTop = next * evidenceRowHeight;
                setViewport({ top: next * evidenceRowHeight, height: event.currentTarget.clientHeight });
                requestAnimationFrame(() => {
                  const buttons = timelineRef.current?.querySelectorAll<HTMLButtonElement>("[data-item-id]");
                  Array.from(buttons ?? []).find(button => button.dataset.itemId === row.id)?.focus({ preventScroll: true });
                });
              }}
              onWheel={() => props.onUserScroll?.()}
              onTouchMove={() => props.onUserScroll?.()}
              onPointerDown={(event) => {
                // A pointerdown on the list itself (not on a row) is a
                // scrollbar drag or padding press — treat it as manual scroll.
                if (event.target === event.currentTarget) props.onUserScroll?.();
              }}
            >
              <div style={{ height: rowWindow.before }} aria-hidden />
              {filteredRows.length === 0 ? (
                <div className="jl-vm-empty">No entries match.</div>
              ) : (
                filteredRows.slice(rowWindow.start, rowWindow.end).map((row) => (
                  <EvidenceRow
                    key={row.id}
                    row={row}
                    active={row.id === props.activeItemId}
                    onItemClick={props.onItemClick}
                    onItemContextMenu={props.onItemContextMenu}
                  />
                ))
              )}
              <div style={{ height: rowWindow.after }} aria-hidden />
            </div>
          )}
          {activeTab !== "about" && !props.autoFollow ? (
            <button type="button" className="jl-vm-focus-btn" onClick={props.onAutoFollowToggle}>
              ↓ Focus
            </button>
          ) : null}
          {activeTab !== "about" && props.drawerItem ? (
            <NetworkDrawer item={props.drawerItem} onClose={props.onDrawerClose} onCopy={props.onCopy} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AboutEvidencePanel(props: {
  about: ViewerModalProps["aboutEvidence"];
  recordedBy: NonNullable<ViewerModalProps["recordedBy"]> | null;
}): React.JSX.Element {
  const extension = props.about.extension;
  const recordedBy = props.recordedBy;
  const extensionRows = [
    ["Extension", extension.name],
    ["Extension version", extension.version],
    ["Extension ID", extension.extensionId ?? "Not saved"],
    ["Manifest [extension config]", extension.manifestVersion ? `MV${extension.manifestVersion}` : "Not saved"],
    ["Recorder type", "Chrome extension"]
  ];

  return (
    <div className="jl-vm-about">
      {recordedBy ? (
        <div className="jl-vm-about-card">
          <span className="jl-vm-eyebrow">Recorded by</span>
          <strong>{recordedBy.displayName}</strong>
          <dl className="jl-vm-about-list">
            <div className="jl-vm-about-row">
              <dt>Name</dt>
              <dd>{recordedBy.displayName}</dd>
            </div>
            <div className="jl-vm-about-row">
              <dt>Email</dt>
              <dd>{recordedBy.email ?? "Not available"}</dd>
            </div>
          </dl>
        </div>
      ) : null}
      <div className="jl-vm-about-card">
        <span className="jl-vm-eyebrow">Extension used</span>
        <strong>{extension.name}</strong>
        <dl className="jl-vm-about-list">
          {extensionRows.map(([label, value]) => (
            <div key={label} className="jl-vm-about-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function EvidenceRow(props: {
  row: ViewerModalRow;
  active: boolean;
  onItemClick: ViewerModalProps["onItemClick"];
  onItemContextMenu: ViewerModalProps["onItemContextMenu"];
}): React.JSX.Element {
  const row = props.row;
  const offset = row.mergedRange ?? formatOffset(row.offsetMs);
  const duration =
    row.durationMs !== null && row.durationMs !== undefined
      ? `${Math.round(row.durationMs)}ms`
      : "";
  const url = row.url ?? row.label;

  return (
    <button
      type="button"
      className="jl-vm-row"
      data-kind={row.section}
      data-item-id={row.id}
      data-active={props.active ? "true" : "false"}
      data-selected={row.selected ? "true" : "false"}
      onClick={(event) => {
        event.stopPropagation();
        props.onItemClick(row, event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onItemContextMenu(row, event);
      }}
    >
      {row.section === "network" ? (
        <>
          <span className="jl-vm-row-offset">{offset}</span>
          <span className="jl-vm-row-method" data-method={row.method ?? undefined}>
            {row.method ?? "REQ"}
          </span>
          <span className="jl-vm-row-main">
            <span className="jl-vm-row-label">{url}</span>
            <span className="jl-vm-row-sub">{row.subtype ?? "other"}</span>
          </span>
          <span className="jl-vm-row-status" data-tone={statusTone(row.statusCode ?? null)}>
            {row.statusCode ?? ""}
          </span>
          <span className="jl-vm-row-duration">{duration}</span>
        </>
      ) : (
        <>
          <span className="jl-vm-row-offset">{offset}</span>
          <span className="jl-vm-row-dot" data-kind={row.kind} />
          <span className="jl-vm-row-label">{row.label}</span>
          <span className="jl-vm-row-status" data-tone={statusTone(row.statusCode ?? null)}>
            {row.statusCode ?? ""}
          </span>
        </>
      )}
    </button>
  );
}

function applyClientSearch(
  rows: ViewerModalRow[],
  query: string,
  section: TimelineSection
): ViewerModalRow[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return rows;
  if (section === "network") return rows;
  return rows.filter((row) => row.label.toLowerCase().includes(trimmed));
}
