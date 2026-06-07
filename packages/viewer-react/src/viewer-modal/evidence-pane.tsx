import { useRef } from "react";
import type * as React from "react";

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

export function EvidencePane(props: ViewerModalProps): React.JSX.Element {
  const localRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = props.timelineRef ?? localRef;
  const filteredRows = applyClientSearch(props.rows, props.searchQuery, props.activeSection);

  return (
    <div className="jl-vm-right">
      <div className="jl-vm-evidence">
        <div className="jl-vm-tabs-row">
          <div className="jl-vm-tabs">
            {(["actions", "console", "network"] as const).map((section) => (
              <button
                key={section}
                type="button"
                className="jl-vm-tab"
                data-active={section === props.activeSection ? "true" : "false"}
                onClick={() => props.onSectionChange(section)}
              >
                {section === "console" ? "Logs" : section[0]!.toUpperCase() + section.slice(1)}
              </button>
            ))}
          </div>
          <input
            className="jl-vm-search"
            type="search"
            placeholder="Search this evidence…"
            value={props.searchQuery}
            onChange={(event) => props.onSearchChange(event.currentTarget.value)}
          />
        </div>
        {props.activeSection === "network" ? (
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
          <div className="jl-vm-list" ref={timelineRef}>
            {filteredRows.length === 0 ? (
              <div className="jl-vm-empty">No entries match.</div>
            ) : (
              filteredRows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="jl-vm-row"
                  data-item-id={row.id}
                  data-active={row.id === props.activeItemId ? "true" : "false"}
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
                  <span className="jl-vm-row-offset">
                    {row.mergedRange ?? formatOffset(row.offsetMs)}
                  </span>
                  <span className="jl-vm-row-label">{row.label}</span>
                  <span
                    className="jl-vm-row-status"
                    data-tone={statusTone(row.statusCode ?? null)}
                  >
                    {row.statusCode ?? ""}
                  </span>
                </button>
              ))
            )}
          </div>
          {!props.autoFollow ? (
            <button type="button" className="jl-vm-focus-btn" onClick={props.onAutoFollowToggle}>
              ↓ Focus
            </button>
          ) : null}
          {props.drawerItem ? (
            <NetworkDrawer item={props.drawerItem} onClose={props.onDrawerClose} onCopy={props.onCopy} />
          ) : null}
        </div>
      </div>
    </div>
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
