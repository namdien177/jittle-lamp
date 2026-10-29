//! Share: upload a local recording if it isn't in the cloud yet, then create a link and put it on
//! the clipboard. One button, whatever state the recording is in. "Upload new recordings" uses the
//! same path without the link.

use std::path::PathBuf;
use std::time::Duration;

use gpui_kit::*;
use jl_api::{SyncInput, SyncPhase};

use crate::app::JlApp;
use crate::model::Sync;

/// The backend refuses recordings above this at `sync/start` (413).
const MAX_UPLOAD_BYTES: u64 = 60 * 1024 * 1024;

/// Share links last a week unless the web app changes them.
const LINK_LIFETIME: Duration = Duration::from_secs(7 * 24 * 3600);

struct UploadJob {
    session_id: String,
    title: String,
    folder: PathBuf,
    video: PathBuf,
    /// Already in the cloud: link it, don't upload it again.
    evidence_id: Option<String>,
    /// Library sessions remember their upload; temp copies have nothing to update.
    library_backed: bool,
}

impl JlApp {
    pub fn share_current(&mut self, cx: &mut Context<Self>) {
        if self.demo {
            self.toast("link", "Share link copied", "Anyone in LittleLives QA can open it for 7 days.", None, cx);
            return;
        }
        if !self.signed_in {
            self.start_sign_in(cx);
            return;
        }
        let Some(v) = self.viewer.as_ref() else { return };
        let Some(loaded) = v.loaded.as_ref() else { return };
        let session_id = loaded.archive.session_id.clone();
        let evidence_id = v.remote_evidence_id.clone().or_else(|| {
            v.library_backed.then(|| self.records.iter().find(|r| r.session_id == session_id).and_then(|r| r.remote.as_ref().map(|r| r.evidence_id.clone()))).flatten()
        });
        let job = UploadJob {
            session_id,
            title: loaded.archive.name.clone(),
            folder: loaded.folder.clone(),
            video: loaded.video_path.clone(),
            evidence_id,
            library_backed: v.library_backed,
        };
        self.run_upload(job, true, cx);
    }

    /// The quick recorder's "Copy link": share a library recording without opening the window.
    pub fn share_session(&mut self, session_id: String, cx: &mut Context<Self>) {
        if !self.signed_in {
            self.start_sign_in(cx);
            if self.sign_in.is_some() {
                self.show_main_window(cx);
            }
            return;
        }
        let Some(r) = self.records.iter().find(|r| r.session_id == session_id) else { return };
        let job = UploadJob {
            session_id: r.session_id.clone(),
            title: r.name.clone(),
            folder: r.session_folder.clone(),
            video: r.video_path.clone(),
            evidence_id: r.remote.as_ref().map(|x| x.evidence_id.clone()),
            library_backed: true,
        };
        self.run_upload(job, true, cx);
    }

    /// "Upload new recordings": a finished recording goes to the cloud on its own.
    pub fn upload_in_background(&mut self, session_id: String, cx: &mut Context<Self>) {
        let Some(r) = self.records.iter().find(|r| r.session_id == session_id) else { return };
        if r.remote.is_some() {
            return;
        }
        let job = UploadJob {
            session_id: r.session_id.clone(),
            title: r.name.clone(),
            folder: r.session_folder.clone(),
            video: r.video_path.clone(),
            evidence_id: None,
            library_backed: true,
        };
        self.run_upload(job, false, cx);
    }

    fn run_upload(&mut self, job: UploadJob, make_link: bool, cx: &mut Context<Self>) {
        let Some(cloud) = self.cloud_api.clone() else { return };
        let size = std::fs::metadata(&job.video).map(|m| m.len()).unwrap_or(0);
        if job.evidence_id.is_none() && size > MAX_UPLOAD_BYTES {
            self.toast(
                "cloud-off",
                "Too large to upload",
                format!("This recording is {}; uploads are limited to 60 MB. Export it as a ZIP to share it another way.", crate::ui::format_bytes(size)),
                None,
                cx,
            );
            return;
        }
        let library = self.library.clone().filter(|_| job.library_backed);
        let session_id = job.session_id.clone();
        if job.evidence_id.is_none() {
            self.set_sync_state(&session_id, Sync::Uploading(0.0), cx);
        }

        cx.spawn(async move |this, cx| {
            let (tx, rx) = crossbeam_channel::unbounded::<f32>();
            let api = cloud.api.clone();
            let work = cx.background_executor().spawn(async move {
                let evidence_id = match job.evidence_id {
                    Some(id) => id,
                    None => {
                        let mut input = SyncInput::from_session_folder(&job.folder, &job.session_id, &job.title)?;
                        input.thumbnail_jpeg = jl_media::jpeg_thumbnail(&job.video, 1_000, 480, 80).ok();
                        let result = api.sync_session(&input, |p| {
                            if p.phase == SyncPhase::Uploading {
                                let _ = tx.send(p.fraction());
                            }
                        })?;
                        if let Some(library) = library {
                            library.mark_remote_synced(&job.session_id, &result.evidence_id, &result.organization_id, None).ok();
                        }
                        result.evidence_id
                    }
                };
                if !make_link {
                    return anyhow::Ok(None);
                }
                let link = api.create_share_link(&evidence_id, Some(LINK_LIFETIME))?;
                anyhow::Ok(Some(api.config().share_url(&link.slug)))
            });
            // Progress drives the row's bar while the upload runs; the channel closes when it ends.
            let progress = this.clone();
            let progress_id = session_id.clone();
            cx.spawn(async move |cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(120)).await;
                    let mut last = None;
                    loop {
                        match rx.try_recv() {
                            Ok(f) => last = Some(f),
                            Err(crossbeam_channel::TryRecvError::Empty) => break,
                            Err(crossbeam_channel::TryRecvError::Disconnected) => return,
                        }
                    }
                    if let Some(f) = last {
                        progress.update(cx, |this, cx| this.set_sync_state(&progress_id, Sync::Uploading(f), cx)).ok();
                    }
                }
            })
            .detach();
            let result = work.await;
            this.update(cx, |this, cx| match result {
                Ok(url) => {
                    this.set_sync_state(&session_id, Sync::Synced, cx);
                    match url {
                        Some(url) => {
                            cx.write_to_clipboard(ClipboardItem::new_string(url));
                            this.toast("link", "Share link copied", "Anyone in your organisation can open it for 7 days.", None, cx);
                        }
                        None => this.toast("cloud-check", "Uploaded", "Your team can find it in Cloud.", None, cx),
                    }
                    this.reload_library(cx);
                }
                Err(err) => {
                    this.set_sync_state(&session_id, Sync::Failed, cx);
                    if jl_api::is_unauthorized(&err) {
                        this.signed_in = false;
                        this.start_sign_in(cx);
                    } else {
                        this.toast("cloud-off", if make_link { "Couldn't share" } else { "Upload failed" }, format!("{err:#}"), None, cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn set_sync_state(&mut self, session_id: &str, sync: Sync, cx: &mut Context<Self>) {
        for s in self.sessions.iter_mut().filter(|s| s.id.as_ref() == session_id) {
            s.sync = sync;
        }
        if let Some(v) = self.viewer.as_mut().filter(|v| v.session.id.as_ref() == session_id) {
            v.session.sync = sync;
        }
        cx.notify();
    }
}
