import { useEffect } from "react";
import type * as React from "react";
import { X } from "lucide-react";

import { MergeDialog } from "../components";
import { ContextMenuPortal } from "./context-menu";
import { EvidencePane } from "./evidence-pane";
import { injectStyles } from "./inject-styles";
import { ViewerModalHeader } from "./modal-header";
import { VideoNotesPane } from "./notes-pane";
import type { ViewerModalProps } from "./types";

export function ViewerModal(props: ViewerModalProps): React.JSX.Element | null {
  injectStyles();
  const mode = props.mode ?? "modal";
  const theme = props.theme ?? "dark";

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
      className={mode === "page" ? "jl-vm-root" : "jl-vm-modal"}
      data-jl-theme={theme}
      data-compact={props.compact ? "true" : "false"}
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
      <>
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
      </>
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

export { buildCurl, getResponseBodyString } from "./curl";
export type {
  ViewerModalProps,
  ViewerModalRow,
  ViewerSource,
  ViewerEvidenceTag,
  ViewerDiscussionComment,
  ViewerModalFeedback,
  ViewerContextMenuState
} from "./types";
