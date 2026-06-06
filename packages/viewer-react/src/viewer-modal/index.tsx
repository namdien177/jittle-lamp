import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

import {
  formatOffset,
  type NetworkSubtype,
  type TimelineItem,
  type TimelineSection
} from "@jittle-lamp/shared";

import { MergeDialog } from "../components";
import { VIEWER_MODAL_STYLE_ID, viewerModalStyles } from "./styles";
import { buildCurl, getResponseBodyString } from "./curl";

export type ViewerModalRow = {
  id: string;
  offsetMs: number;
  section: TimelineSection;
  label: string;
  kind: string;
  selected: boolean;
  merged: boolean;
  mergedRange?: string;
  tags: string[];
  statusCode?: number | null;
  subtype?: NetworkSubtype | null;
};

export type ViewerSource = "local" | "zip" | "cloud" | "share";

export type ViewerModalFeedback = {
  tone: "neutral" | "success" | "error";
  text: string;
};

export type ViewerContextMenuState = {
  open: boolean;
  x: number;
  y: number;
  rowId: string | null;
  kind: "actions" | "network";
  canMerge: boolean;
  canUnmerge: boolean;
};

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

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(VIEWER_MODAL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = VIEWER_MODAL_STYLE_ID;
  style.textContent = viewerModalStyles;
  document.head.append(style);
}

export type ViewerModalProps = {
  open: boolean;
  onClose: () => void;
  mode?: "modal" | "page";
  closeLabel?: string;

  title: string;
  tags: string[];
  source: ViewerSource;
  isOwner: boolean;
  shareLinkUrl: string | null;
  onCopyShareLink?: () => void;
  onCreateShareLink?: () => void;
  onDownloadZip?: () => void;
  downloadingZip?: boolean;
  creatingShareLink?: boolean;

  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc?: string | null;
  notesValue: string;
  notesReadOnly: boolean;
  notesSaving: boolean;
  notesDirty: boolean;
  notesNotice?: string | null;
  onNotesChange: (v: string) => void;
  onSaveNotes: () => void;
  onVideoTimeUpdate: () => void;
  onVideoError?: () => void;

  activeSection: TimelineSection;
  onSectionChange: (s: TimelineSection) => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  subtypeFilter: NetworkSubtype | "all";
  onSubtypeFilterChange: (v: NetworkSubtype | "all") => void;
  rows: ViewerModalRow[];
  activeItemId: string | null;
  autoFollow: boolean;
  onItemClick: (row: ViewerModalRow, event: React.MouseEvent<HTMLButtonElement>) => void;
  onItemContextMenu: (row: ViewerModalRow, event: React.MouseEvent<HTMLButtonElement>) => void;
  onAutoFollowToggle: () => void;
  timelineRef?: React.RefObject<HTMLDivElement | null>;

  drawerItem: TimelineItem | null;
  onDrawerClose: () => void;
  onCopy: (value: string, label: string) => void;

  contextMenu: ViewerContextMenuState;
  onContextMenuClose: () => void;
  onContextMenuMerge?: () => void;
  onContextMenuUnmerge?: () => void;
  onCopyCurl?: (rowId: string) => void;
  onCopyResponse?: (rowId: string) => void;

  mergeDialog: { open: boolean; value: string; error: string | null };
  onMergeValueChange: (v: string) => void;
  onMergeConfirm: () => void;
  onMergeCancel: () => void;

  feedback?: ViewerModalFeedback | null;
  onFeedbackDismiss?: () => void;
};

export function ViewerModal(props: ViewerModalProps): React.JSX.Element | null {
  injectStyles();
  const mode = props.mode ?? "modal";

  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (props.contextMenu.open) {
          props.onContextMenuClose();
          return;
        }
        if (props.drawerItem) {
          props.onDrawerClose();
          return;
        }
        if (!props.mergeDialog.open && mode === "modal") {
          props.onClose();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    props.open,
    props.contextMenu.open,
    props.drawerItem,
    props.mergeDialog.open,
    mode,
    props.onClose,
    props.onContextMenuClose,
    props.onDrawerClose
  ]);

  if (!props.open) return null;

  const viewer = (
    <div
      className="jl-vm-modal"
      role={mode === "modal" ? "dialog" : undefined}
      aria-modal={mode === "modal" ? "true" : undefined}
      aria-label={props.title}
    >
      <ViewerModalHeader {...props} mode={mode} />
      <div className="jl-vm-body">
        <VideoNotesPane {...props} />
        <EvidencePane {...props} />
      </div>
      {props.feedback ? (
        <div className="jl-vm-feedback" data-tone={props.feedback.tone}>
          <span>{props.feedback.text}</span>
          {props.onFeedbackDismiss ? (
            <button
              type="button"
              className="jl-vm-feedback-dismiss"
              aria-label="Dismiss"
              onClick={props.onFeedbackDismiss}
            >
              <X aria-hidden size={14} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (mode === "page") {
    return (
      <div className="jl-vm-page">
        {viewer}
        <ContextMenuPortal {...props} />
        <MergeDialog
          open={props.mergeDialog.open}
          selectedCount={0}
          value={props.mergeDialog.value}
          error={props.mergeDialog.error}
          onValueChange={props.onMergeValueChange}
          onConfirm={props.onMergeConfirm}
          onCancel={props.onMergeCancel}
        />
      </div>
    );
  }

  return (
    <div
      className="jl-vm-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      {viewer}
      <ContextMenuPortal {...props} />
      <MergeDialog
        open={props.mergeDialog.open}
        selectedCount={0}
        value={props.mergeDialog.value}
        error={props.mergeDialog.error}
        onValueChange={props.onMergeValueChange}
        onConfirm={props.onMergeConfirm}
        onCancel={props.onMergeCancel}
      />
    </div>
  );
}

function ViewerModalHeader(props: ViewerModalProps): React.JSX.Element {
  const showCopyLink = props.shareLinkUrl !== null && props.onCopyShareLink !== undefined;
  const showCreateLink =
    props.isOwner && props.shareLinkUrl === null && props.onCreateShareLink !== undefined;
  const showDownloadZip = props.onDownloadZip !== undefined;
  const isPage = (props.mode ?? "modal") === "page";
  const closeLabel = props.closeLabel ?? "Close viewer";

  return (
    <header className="jl-vm-header">
      <div className="jl-vm-header-left">
        <span className="jl-vm-title">{props.title}</span>
        {props.tags.length > 0 ? (
          <span className="jl-vm-tags">
            {props.tags.map((tag) => (
              <span key={tag} className="jl-vm-tag">
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="jl-vm-actions">
        {showCopyLink ? (
          <button type="button" className="jl-vm-btn" onClick={props.onCopyShareLink}>
            Copy share link
          </button>
        ) : null}
        {showCreateLink ? (
          <button
            type="button"
            className="jl-vm-btn jl-vm-btn-primary"
            disabled={props.creatingShareLink}
            onClick={props.onCreateShareLink}
          >
            {props.creatingShareLink ? "Creating…" : "Create share link"}
          </button>
        ) : null}
        {showDownloadZip ? (
          <button
            type="button"
            className="jl-vm-btn"
            disabled={props.downloadingZip}
            onClick={props.onDownloadZip}
          >
            {props.downloadingZip ? "Preparing…" : "Download ZIP"}
          </button>
        ) : null}
        <button
          type="button"
          className={isPage && props.closeLabel ? "jl-vm-btn" : "jl-vm-btn jl-vm-btn-icon"}
          aria-label={closeLabel}
          onClick={props.onClose}
        >
          {isPage && props.closeLabel ? props.closeLabel : <X aria-hidden size={16} strokeWidth={2} />}
        </button>
      </div>
    </header>
  );
}

function VideoNotesPane(props: ViewerModalProps): React.JSX.Element {
  return (
    <div className="jl-vm-left">
      <div className="jl-vm-video-wrap">
        <div className="jl-vm-video-inner">
          <video
            ref={props.videoRef}
            controls
            src={props.videoSrc ?? undefined}
            onTimeUpdate={props.onVideoTimeUpdate}
            onError={props.onVideoError}
          />
        </div>
      </div>
      <div className="jl-vm-notes">
        <div className="jl-vm-notes-label">
          <span>Session notes</span>
          {!props.notesReadOnly ? (
            <button
              type="button"
              className="jl-vm-btn"
              disabled={!props.notesDirty || props.notesSaving}
              onClick={props.onSaveNotes}
            >
              {props.notesSaving ? "Saving…" : "Save"}
            </button>
          ) : null}
        </div>
        {props.notesNotice ? <div className="jl-vm-notes-notice">{props.notesNotice}</div> : null}
        <textarea
          className="jl-vm-notes-textarea"
          placeholder="Add notes…"
          value={props.notesValue}
          readOnly={props.notesReadOnly}
          onChange={(event) => props.onNotesChange(event.currentTarget.value)}
        />
      </div>
    </div>
  );
}

function EvidencePane(props: ViewerModalProps): React.JSX.Element {
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

function statusTone(code: number | null): "ok" | "err" | "" {
  if (code === null) return "";
  if (code >= 200 && code < 300) return "ok";
  if (code >= 400) return "err";
  return "";
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

function NetworkDrawer(props: {
  item: TimelineItem;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  if (props.item.payload.kind === "network") {
    return <NetworkDetailDrawer item={props.item} onClose={props.onClose} onCopy={props.onCopy} />;
  }
  if (props.item.payload.kind === "console") {
    return <ConsoleDetailDrawer item={props.item} onClose={props.onClose} onCopy={props.onCopy} />;
  }
  return <ActionDetailDrawer item={props.item} onClose={props.onClose} onCopy={props.onCopy} />;
}

function NetworkDetailDrawer(props: {
  item: TimelineItem;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element | null {
  if (props.item.payload.kind !== "network") return null;
  const payload = props.item.payload;
  const statusCode = payload.status ?? null;
  const tone = statusTone(statusCode);
  const statusText =
    statusCode !== null
      ? `${statusCode}${payload.statusText ? ` ${payload.statusText}` : ""}`
      : "—";
  const durationText =
    payload.durationMs !== undefined ? `${payload.durationMs.toFixed(0)} ms` : "—";

  return (
    <div className="jl-vm-drawer">
      <div className="jl-vm-drawer-header">
        <span>Network request</span>
        <button type="button" className="jl-vm-btn jl-vm-btn-icon" aria-label="Close drawer" onClick={props.onClose}>
          <X aria-hidden size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="jl-vm-drawer-body">
        <div className="jl-vm-drawer-section">
          <span className="jl-vm-drawer-label">Request</span>
          <KvRow keyLabel="Method" value={payload.method} onCopy={props.onCopy} copyAs="request method" />
          <KvRow keyLabel="URL" value={payload.url} onCopy={props.onCopy} copyAs="request URL" />
          <KvRow keyLabel="Status" value={statusText} tone={tone} onCopy={props.onCopy} copyAs="response status" />
          <KvRow keyLabel="Duration" value={durationText} onCopy={props.onCopy} copyAs="duration" />
          {payload.failureText ? (
            <KvRow keyLabel="Failure" value={payload.failureText} tone="err" onCopy={props.onCopy} copyAs="failure" />
          ) : null}
        </div>
        <HeadersSection title="Request headers" headers={payload.request.headers} onCopy={props.onCopy} />
        <BodySection title="Request body" body={payload.request.body} onCopy={props.onCopy} />
        <HeadersSection title="Response headers" headers={payload.response?.headers ?? []} onCopy={props.onCopy} />
        <BodySection title="Response body" body={payload.response?.body} onCopy={props.onCopy} />
      </div>
    </div>
  );
}

function ConsoleDetailDrawer(props: {
  item: TimelineItem;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element | null {
  if (props.item.payload.kind !== "console") return null;
  const payload = props.item.payload;
  const text = JSON.stringify(payload, null, 2);
  return (
    <div className="jl-vm-drawer">
      <div className="jl-vm-drawer-header">
        <span>Log entry</span>
        <button type="button" className="jl-vm-btn jl-vm-btn-icon" aria-label="Close drawer" onClick={props.onClose}>
          <X aria-hidden size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="jl-vm-drawer-body">
        <pre className="jl-vm-pre" onClick={() => props.onCopy(text, "log entry")}>{text}</pre>
      </div>
    </div>
  );
}

function ActionDetailDrawer(props: {
  item: TimelineItem;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  const text = JSON.stringify(props.item.payload, null, 2);
  return (
    <div className="jl-vm-drawer">
      <div className="jl-vm-drawer-header">
        <span>Action</span>
        <button type="button" className="jl-vm-btn jl-vm-btn-icon" aria-label="Close drawer" onClick={props.onClose}>
          <X aria-hidden size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="jl-vm-drawer-body">
        <pre className="jl-vm-pre" onClick={() => props.onCopy(text, "action")}>{text}</pre>
      </div>
    </div>
  );
}

function KvRow(props: {
  keyLabel: string;
  value: string;
  tone?: "ok" | "err" | "";
  onCopy: (value: string, label: string) => void;
  copyAs: string;
}): React.JSX.Element {
  return (
    <div className="jl-vm-kv">
      <span className="jl-vm-kv-key">{props.keyLabel}</span>
      <button
        type="button"
        className="jl-vm-kv-val"
        data-tone={props.tone || undefined}
        onClick={() => props.onCopy(props.value, props.copyAs)}
      >
        {props.value}
      </button>
    </div>
  );
}

function HeadersSection(props: {
  title: string;
  headers: ReadonlyArray<{ name: string; value: string }>;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  return (
    <div className="jl-vm-drawer-section">
      <span className="jl-vm-drawer-label">{props.title}</span>
      {props.headers.length === 0 ? (
        <span className="jl-vm-empty-line">No headers</span>
      ) : (
        props.headers.map((header, index) => (
          <div className="jl-vm-kv" key={`${props.title}-${header.name}-${index}`}>
            <button
              type="button"
              className="jl-vm-kv-val jl-vm-kv-key"
              onClick={() => props.onCopy(header.name, "header name")}
            >
              {header.name}
            </button>
            <button
              type="button"
              className="jl-vm-kv-val"
              onClick={() => props.onCopy(header.value, "header value")}
            >
              {header.value}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

type NetworkBody = NonNullable<
  Extract<TimelineItem["payload"], { kind: "network" }>["request"]["body"]
>;

function BodySection(props: {
  title: string;
  body: NetworkBody | undefined;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  return (
    <div className="jl-vm-drawer-section">
      <span className="jl-vm-drawer-label">{props.title}</span>
      <BodyContent body={props.body} onCopy={props.onCopy} />
    </div>
  );
}

function BodyContent(props: {
  body: NetworkBody | undefined;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  if (!props.body) return <span className="jl-vm-empty-line">No body</span>;
  if (props.body.disposition !== "captured" || props.body.value === undefined) {
    const reason = props.body.reason ? ` (${props.body.reason})` : "";
    return <span className="jl-vm-empty-line">{`${props.body.disposition}${reason}`}</span>;
  }
  const value = props.body.value;
  const isBase64 = props.body.encoding === "base64";
  const display = isBase64 ? `[base64, ${props.body.byteLength ?? "?"} bytes]` : value;
  return (
    <pre className="jl-vm-pre" onClick={() => props.onCopy(value, "body")}>{display}</pre>
  );
}

function ContextMenuPortal(props: ViewerModalProps): React.JSX.Element | null {
  const menu = props.contextMenu;
  useEffect(() => {
    if (!menu.open) return;
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".jl-vm-ctx-menu")) return;
      props.onContextMenuClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [menu.open, props.onContextMenuClose]);

  if (!menu.open || menu.rowId === null) return null;

  if (menu.kind === "network") {
    return (
      <div
        className="jl-vm-ctx-menu"
        style={{ left: menu.x, top: menu.y }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="jl-vm-ctx-item"
          onClick={() => {
            if (menu.rowId) props.onCopyCurl?.(menu.rowId);
            props.onContextMenuClose();
          }}
        >
          Copy cURL
        </button>
        <button
          type="button"
          className="jl-vm-ctx-item"
          onClick={() => {
            if (menu.rowId) props.onCopyResponse?.(menu.rowId);
            props.onContextMenuClose();
          }}
        >
          Copy response
        </button>
      </div>
    );
  }

  return (
    <div
      className="jl-vm-ctx-menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.canMerge ? (
        <button
          type="button"
          className="jl-vm-ctx-item"
          onClick={() => {
            props.onContextMenuMerge?.();
            props.onContextMenuClose();
          }}
        >
          Merge actions
        </button>
      ) : null}
      {menu.canUnmerge ? (
        <button
          type="button"
          className="jl-vm-ctx-item"
          onClick={() => {
            props.onContextMenuUnmerge?.();
            props.onContextMenuClose();
          }}
        >
          Un-merge
        </button>
      ) : null}
    </div>
  );
}

export { buildCurl, getResponseBodyString };
