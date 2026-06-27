import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { Check, Plus, Search, Tags } from "lucide-react";

import { formatCommentTime } from "./format";
import type { ViewerModalProps } from "./types";
import { EvidenceVideoPlayer } from "./video-player";

export function VideoNotesPane(props: ViewerModalProps): React.JSX.Element {
  const hasDiscussion = props.discussionComments !== undefined;

  return (
    <div className="jl-vm-left">
      <EvidenceVideoPlayer {...props} />
      <EvidenceTagBar {...props} />
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
              className="jl-vm-notes-textarea"
              placeholder="Leave a comment..."
              value={props.discussionValue ?? ""}
              readOnly={props.discussionReadOnly}
              onChange={(event) => props.onDiscussionChange?.(event.currentTarget.value)}
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
              Comment
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
    </div>
  );
}

function EvidenceTagBar(props: ViewerModalProps): React.JSX.Element | null {
  const tags = props.evidenceTags ?? [];
  const availableTags = props.availableEvidenceTags ?? [];
  const canEdit = props.canUpdateEvidenceTags === true && availableTags.length > 0;

  if (tags.length === 0 && !canEdit) return null;

  return (
    <div className="jl-vm-tagbar">
      <div className="jl-vm-tagbar-main">
        <Tags aria-hidden size={14} strokeWidth={2} />
        {tags.length > 0 ? (
          <div className="jl-vm-tagbar-list" aria-label="Evidence tags">
            {tags.map((tag) => (
              <EvidenceTagPill key={tag.id} tag={tag} />
            ))}
          </div>
        ) : (
          <span className="jl-vm-tagbar-empty">No tags</span>
        )}
      </div>
      {canEdit ? (
        <EvidenceTagPicker
          tags={tags}
          availableTags={availableTags}
          saving={props.evidenceTagsSaving === true}
          onChange={props.onEvidenceTagsChange ?? (() => undefined)}
          empty={tags.length === 0}
        />
      ) : null}
    </div>
  );
}

function EvidenceTagPill(props: { tag: NonNullable<ViewerModalProps["evidenceTags"]>[number] }): React.JSX.Element {
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
  tags: NonNullable<ViewerModalProps["evidenceTags"]>;
  availableTags: NonNullable<ViewerModalProps["availableEvidenceTags"]>;
  saving: boolean;
  empty: boolean;
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
        {props.empty ? "Add Tags" : "Edit"}
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
