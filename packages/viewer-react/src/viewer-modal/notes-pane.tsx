import type * as React from "react";

import { formatCommentTime } from "./format";
import type { ViewerModalProps } from "./types";
import { EvidenceVideoPlayer } from "./video-player";

export function VideoNotesPane(props: ViewerModalProps): React.JSX.Element {
  const hasDiscussion = props.discussionComments !== undefined;

  return (
    <div className="jl-vm-left">
      <EvidenceVideoPlayer {...props} />
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
