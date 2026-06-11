import type * as React from "react";
import { Pencil, X } from "lucide-react";

import type { ViewerModalProps } from "./types";

export function ViewerModalHeader(props: ViewerModalProps): React.JSX.Element {
  const showCopyLink = props.shareLinkUrl !== null && props.onCopyShareLink !== undefined;
  const showCreateLink =
    props.isOwner && props.shareLinkUrl === null && props.onCreateShareLink !== undefined;
  const showRename = props.onRename !== undefined;
  const showDownloadZip = props.onDownloadZip !== undefined;
  const isPage = (props.mode ?? "modal") === "page";
  const closeLabel = props.closeLabel ?? "Close viewer";

  return (
    <header className="jl-vm-header">
      <div className="jl-vm-header-left">
        <div className="jl-vm-heading">
          <span className="jl-vm-title">{props.title}</span>
          {props.titleMeta ? <span className="jl-vm-title-meta">{props.titleMeta}</span> : null}
        </div>
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
        {showRename ? (
          <button
            type="button"
            className="jl-vm-btn"
            disabled={props.renaming}
            onClick={props.onRename}
          >
            <Pencil aria-hidden size={14} strokeWidth={2} />
            {props.renaming ? "Saving…" : "Edit name"}
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
