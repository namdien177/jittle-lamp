import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { Check, Plus, Search } from "lucide-react";

import { formatCommentTime } from "./format";
import type { ViewerEvidenceTag, ViewerModalProps } from "./types";
import { EvidenceVideoPlayer } from "./video-player";

type TagRailItem = {
  id: string;
  name: string;
  color: string;
};

const FALLBACK_TAG_COLOR = "#22c55e";
const COMPOSER_MAX_ROWS = 2;

function getNumericStyle(value: string): number {
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return 0;
}

function getComposerMaxHeight(textarea: HTMLTextAreaElement): number {
  const styles = window.getComputedStyle(textarea);
  const lineHeight = getNumericStyle(styles.lineHeight);
  const verticalPadding =
    getNumericStyle(styles.paddingTop) +
    getNumericStyle(styles.paddingBottom) +
    getNumericStyle(styles.borderTopWidth) +
    getNumericStyle(styles.borderBottomWidth);

  if (lineHeight <= 0) {
    return textarea.scrollHeight;
  }

  return lineHeight * COMPOSER_MAX_ROWS + verticalPadding;
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";

  const maxHeight = getComposerMaxHeight(textarea);
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
  let overflowY = "hidden";

  if (textarea.scrollHeight > maxHeight) {
    overflowY = "auto";
  }

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = overflowY;
}

export function VideoNotesPane(props: ViewerModalProps): React.JSX.Element {
  const hasDiscussion = props.discussionComments !== undefined;
  const discussionValue = props.discussionValue ?? "";
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!hasDiscussion || !composerTextareaRef.current) {
      return;
    }

    resizeComposerTextarea(composerTextareaRef.current);
  }, [discussionValue, hasDiscussion]);

  const supplemental = <>
      <SessionTagRail {...props} />
      {hasDiscussion ? (
        <div className="jl-vm-discussion">
          <div className="jl-vm-notes-label">
            <span>Discussion</span>
            {props.discussionSaving ? <span className="jl-vm-saving">Saving...</span> : null}
          </div>
          {props.discussionNotice ? <div className="jl-vm-notes-notice">{props.discussionNotice}</div> : null}
          <div className="jl-vm-comments" aria-label="Evidence discussion comments">
            {props.discussionComments?.length ? (
              props.discussionComments.map((comment) => (
                <article key={comment.id} className="jl-vm-comment">
                  <div className="jl-vm-comment-meta">
                    <span>{comment.authorLabel}</span>
                    <time dateTime={new Date(comment.createdAt).toISOString()}>
                      {formatCommentTime(comment.createdAt)}
                    </time>
                  </div>
                  <p>{comment.body}</p>
                </article>
              ))
            ) : (
              <div className="jl-vm-empty-line">No comments yet.</div>
            )}
          </div>
          <div className="jl-vm-composer">
            <textarea
              ref={composerTextareaRef}
              className="jl-vm-notes-textarea"
              placeholder="Leave a comment..."
              rows={1}
              value={discussionValue}
              readOnly={props.discussionReadOnly}
              onChange={(event) => {
                props.onDiscussionChange?.(event.currentTarget.value);
                resizeComposerTextarea(event.currentTarget);
              }}
            />
            <button
              type="button"
              className="jl-vm-btn"
              disabled={
                props.discussionReadOnly ||
                props.discussionSaving ||
                !(props.discussionValue ?? "").trim()
              }
              onClick={props.onSubmitDiscussion}
            >
              Send
            </button>
          </div>
        </div>
      ) : (
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
                {props.notesSaving ? "Saving..." : "Save"}
              </button>
            ) : null}
          </div>
          {props.notesNotice ? <div className="jl-vm-notes-notice">{props.notesNotice}</div> : null}
          <textarea
            className="jl-vm-notes-textarea"
            placeholder="Add notes..."
            value={props.notesValue}
            readOnly={props.notesReadOnly}
            onChange={(event) => props.onNotesChange(event.currentTarget.value)}
          />
        </div>
      )}
  </>;

  return (
    <div className="jl-vm-left">
      <EvidenceVideoPlayer {...props} />
      {props.compact ? (
        <details className="jl-vm-secondary" onToggle={event => {
          if (event.currentTarget.open) props.onDetailsOpen?.();
        }}>
          <summary>Discussion &amp; tags</summary>
          <div className="jl-vm-secondary-content">{supplemental}</div>
        </details>
      ) : supplemental}

    </div>
  );
}

function getSessionTagRailItems(props: ViewerModalProps): TagRailItem[] {
  const evidenceTags = props.evidenceTags ?? [];
  if (evidenceTags.length > 0) {
    return evidenceTags;
  }

  return props.tags.map((tag) => ({
    id: tag,
    name: tag,
    color: FALLBACK_TAG_COLOR
  }));
}

function SessionTagRail(props: ViewerModalProps): React.JSX.Element | null {
  const evidenceTags = props.evidenceTags ?? [];
  const displayTags = getSessionTagRailItems(props);
  const availableTags = props.availableEvidenceTags ?? [];
  const canEdit = props.canUpdateEvidenceTags === true;

  if (displayTags.length === 0 && !canEdit) {
    return null;
  }

  return (
    <div className="jl-vm-tagbar" aria-label="Session tags">
      <div className="jl-vm-tagbar-list" aria-label="Current session tags">
        <SessionTagRailContent tags={displayTags} />
      </div>
      {canEdit ? (
        <EvidenceTagPicker
          tags={evidenceTags}
          availableTags={availableTags}
          saving={props.evidenceTagsSaving === true}
          onChange={props.onEvidenceTagsChange ?? (() => undefined)}
        />
      ) : null}
    </div>
  );
}

function SessionTagRailContent(props: { tags: TagRailItem[] }): React.JSX.Element {
  if (props.tags.length === 0) {
    return <span className="jl-vm-tagbar-empty">No tags</span>;
  }

  return (
    <>
      {props.tags.map((tag) => (
        <EvidenceTagPill key={tag.id} tag={tag} />
      ))}
    </>
  );
}

function EvidenceTagPill(props: { tag: TagRailItem }): React.JSX.Element {
  return (
    <span
      className="jl-vm-tag-pill"
      style={{
        borderColor: `${props.tag.color}66`,
        backgroundColor: `${props.tag.color}18`,
        color: props.tag.color
      }}
    >
      {props.tag.name}
    </span>
  );
}

function EvidenceTagPicker(props: {
  tags: ViewerEvidenceTag[];
  availableTags: ViewerEvidenceTag[];
  saving: boolean;
  onChange: (tagIds: string[]) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(props.tags.map((tag) => tag.id))
  );
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const selectedIdsRef = useRef(selectedIds);
  const visibleTags = props.availableTags.filter((tag) =>
    tag.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  useEffect(() => {
    const next = new Set(props.tags.map((tag) => tag.id));
    selectedIdsRef.current = next;
    setSelectedIds(next);
  }, [props.tags]);

  const toggle = (tagId: string): void => {
    const next = new Set(selectedIdsRef.current);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    selectedIdsRef.current = next;
    setSelectedIds(next);
    props.onChange(Array.from(next));
  };

  return (
    <div className="jl-vm-tag-picker">
      <button
        ref={buttonRef}
        type="button"
        className="jl-vm-tag-add"
        disabled={props.saving}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus aria-hidden size={13} strokeWidth={2} />
        Add tags
      </button>
      {open ? (
        <div className="jl-vm-tag-menu" role="dialog" aria-label="Choose evidence tags">
          <div className="jl-vm-tag-search">
            <Search aria-hidden size={14} strokeWidth={2} />
            <input
              autoFocus
              value={query}
              placeholder="Search tags..."
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setOpen(false);
                  buttonRef.current?.focus();
                }
              }}
            />
          </div>
          <div className="jl-vm-tag-options">
            {visibleTags.length > 0 ? (
              visibleTags.map((tag) => {
                const selected = selectedIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className="jl-vm-tag-option"
                    data-selected={selected ? "true" : "false"}
                    onClick={() => toggle(tag.id)}
                  >
                    <span className="jl-vm-tag-check">
                      {selected ? <Check aria-hidden size={13} strokeWidth={2.4} /> : null}
                    </span>
                    <EvidenceTagPill tag={tag} />
                  </button>
                );
              })
            ) : (
              <div className="jl-vm-tag-no-results">No tags found.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
