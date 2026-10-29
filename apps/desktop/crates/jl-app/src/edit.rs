//! Editing a recording: notes that save themselves, and deleting that can be undone. Moving to the
//! Trash is recoverable, so there is no confirmation dialog — the toast's Undo is the safety net.

use std::path::PathBuf;
use std::time::Duration;

use gpui_kit::component::input::{InputEvent, TextareaState};
use gpui_kit::*;

use crate::app::JlApp;
use crate::model::Page;

/// A recording moved to the Trash that its toast can still bring back.
pub struct Trashed {
    pub session_id: String,
    pub original: PathBuf,
    pub in_trash: PathBuf,
    /// Tags live only in the database, which deleting clears; undo puts them back.
    pub tags: Vec<String>,
}

impl JlApp {
    /// The notes editor exists once per open recording, built on first render (it needs the window).
    pub fn ensure_notes_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Entity<TextareaState>> {
        let v = self.viewer.as_mut()?;
        if let Some(editor) = v.notes.clone() {
            return Some(editor);
        }
        // Copies from the cloud or a ZIP live in a temp folder; saving would write to the library
        // session with the same id, so their notes are read-only.
        if !v.library_backed {
            return None;
        }
        let loaded = v.loaded.as_ref()?;
        let initial = loaded.notes.clone();
        let editor = cx.new(|cx| TextareaState::new(window, cx).rows(8).placeholder("What happened, what you expected, steps to reproduce…").default_value(initial));
        let session_id = loaded.archive.session_id.clone();
        let sub = cx.subscribe_in(&editor, window, move |this: &mut Self, state, ev: &InputEvent, _, cx| {
            if let InputEvent::Change = ev {
                let text = state.read(cx).value().to_string();
                this.schedule_notes_save(session_id.clone(), text, cx);
            }
        });
        v.notes = Some(editor.clone());
        v.notes_sub = Some(sub);
        Some(editor)
    }

    /// Saves 700 ms after the last keystroke, into the archive and the library database. The
    /// debounce is per recording: switching recordings never cancels the previous one's save.
    fn schedule_notes_save(&mut self, session_id: String, text: String, cx: &mut Context<Self>) {
        let Some(library) = self.library.clone() else { return };
        let Some(v) = self.viewer.as_mut().filter(|v| v.session.id.as_ref() == session_id) else { return };
        v.notes_generation += 1;
        v.notes_status = Some("Editing…".into());
        let generation = v.notes_generation;
        let annotations = v.loaded.as_ref().map(|l| l.archive.annotations.clone()).unwrap_or_default();
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(700)).await;
            // A newer keystroke on the same recording supersedes this save. If the viewer moved on
            // to another recording, this is the last edit and it must still be written.
            let superseded = this
                .update(cx, |this, _| this.viewer.as_ref().is_some_and(|v| v.session.id.as_ref() == session_id && v.notes_generation != generation))
                .unwrap_or(false);
            if superseded {
                return;
            }
            let id = session_id.clone();
            let result = cx.background_executor().spawn(async move { library.save_review_state(&id, &text, &annotations) }).await;
            this.update(cx, |this, cx| {
                if let Some(v) = this.viewer.as_mut().filter(|v| v.session.id.as_ref() == session_id && v.notes_generation == generation) {
                    v.notes_status = Some(match &result {
                        Ok(_) => "Saved".into(),
                        Err(err) => format!("Not saved: {err:#}").into(),
                    });
                    cx.notify();
                } else if let Err(err) = result {
                    this.toast("circle-alert", "Notes not saved", format!("{err:#}"), None, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// ⌘⌫ in the Library or the viewer.
    pub fn trash_session(&mut self, session_id: String, cx: &mut Context<Self>) {
        let Some(library) = self.library.clone() else { return };
        let Some(record) = self.records.iter().find(|r| r.session_id == session_id).cloned() else { return };
        if self.viewer.as_ref().is_some_and(|v| v.session.id.as_ref() == session_id) {
            self.viewer = None;
            self.page = Page::Library;
        }
        // Gone from the list at once; the disk work follows.
        self.sessions.retain(|s| s.id.as_ref() != session_id);
        self.records.retain(|r| r.session_id != session_id);
        cx.notify();
        let folder = record.session_folder.clone();
        let name = record.name.clone();
        let tags = record.tags.clone();
        cx.spawn(async move |this, cx| {
            let id = session_id.clone();
            let moved = cx
                .background_executor()
                .spawn(async move {
                    let in_trash = jl_macos::move_to_trash(&folder)?;
                    // Drop the database rows; the folder itself is already in the Trash.
                    library.delete_session(&id).ok();
                    anyhow::Ok((folder, in_trash))
                })
                .await;
            this.update(cx, |this, cx| match moved {
                Ok((original, in_trash)) => {
                    this.trashed.retain(|t| t.session_id != session_id);
                    this.trashed.push(Trashed { session_id: session_id.clone(), original, in_trash, tags });
                    this.toast_with_target("trash", "Moved to Trash", name, Some("Undo"), Some(session_id), cx);
                }
                Err(err) => {
                    this.toast("circle-alert", "Couldn't delete", format!("{err:#}"), None, cx);
                    this.reload_library(cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Undo on a "Moved to Trash" toast restores that toast's recording, whichever came last.
    pub fn undo_trash(&mut self, session_id: &str, cx: &mut Context<Self>) {
        let Some(pos) = self.trashed.iter().position(|t| t.session_id == session_id) else { return };
        let t = self.trashed.remove(pos);
        match std::fs::rename(&t.in_trash, &t.original) {
            Ok(()) => {
                if let Some(library) = self.library.as_ref() {
                    for tag in &t.tags {
                        library.add_tag(&t.session_id, tag).ok();
                    }
                }
                self.reload_library(cx);
                self.toast("circle-check", "Recording restored", t.session_id, None, cx);
            }
            Err(err) => self.toast("circle-alert", "Couldn't restore", format!("It is still in the Trash: {err}"), None, cx),
        }
    }
}
