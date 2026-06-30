import { useEffect, useRef, useState } from "react";
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
    network: "Network",
    about: "About Evidence"
  } as const;
  const filteredRows =
    activeTab === "about" ? [] : applyClientSearch(props.rows, props.searchQuery, activeTab);
  const activeCountLabel =
    activeTab === "about"
      ? "Extension details"
      : `${filteredRows.length} ${filteredRows.length === 1 ? "entry" : "entries"}`;

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
        <div className="jl-vm-pane-heading">
          <div>
            <span className="jl-vm-eyebrow">Evidence stream</span>
            <strong>{sectionLabels[activeTab]}</strong>
          </div>
          <div className="jl-vm-pane-heading-actions">
            <span>{activeCountLabel}</span>
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
        </div>
        <div className="jl-vm-tabs-row">
          <div className="jl-vm-tabs">
            {(["actions", "console", "network", "about"] as const).map((section) => (
              <button
                key={section}
                type="button"
                className="jl-vm-tab"
                data-active={section === activeTab ? "true" : "false"}
                onClick={() => {
                  setActiveTab(section);
                  if (section !== "about") props.onSectionChange(section);
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
              placeholder="Search this evidence…"
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
            <AboutEvidencePanel {...props.aboutEvidence} />
          ) : (
            <div className="jl-vm-list" ref={timelineRef}>
              {filteredRows.length === 0 ? (
                <div className="jl-vm-empty">No entries match.</div>
              ) : (
                filteredRows.map((row) => (
                  <EvidenceRow
                    key={row.id}
                    row={row}
                    active={row.id === props.activeItemId}
                    onItemClick={props.onItemClick}
                    onItemContextMenu={props.onItemContextMenu}
                  />
                ))
              )}
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

function AboutEvidencePanel(props: ViewerModalProps["aboutEvidence"]): React.JSX.Element {
  const extension = props.extension;
  const rows = [
    ["Recorded by", extension.name],
    ["Extension version", extension.version],
    ["Extension ID", extension.extensionId ?? "Not saved"],
    ["Manifest [extension config]", extension.manifestVersion ? `MV${extension.manifestVersion}` : "Not saved"],
    ["Recorder type", "Chrome extension"]
  ];

  return (
    <div className="jl-vm-about">
      <div className="jl-vm-about-card">
        <span className="jl-vm-eyebrow">Extension used</span>
        <strong>{extension.name}</strong>
        <dl className="jl-vm-about-list">
          {rows.map(([label, value]) => (
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
