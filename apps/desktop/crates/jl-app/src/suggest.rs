//! Pre-filled titles and descriptions for a just-saved recording. The on-device model writes them
//! when Apple Intelligence is available; otherwise they come from the recording's own labels.

use gpui_kit::*;

use crate::app::{JlApp, Suggestion};

impl JlApp {
    pub fn request_suggestion(&mut self, session_id: String, cx: &mut Context<Self>) {
        let Some(library) = self.library.clone() else { return };
        if self.suggestions.contains_key(&session_id) || !self.suggesting.insert(session_id.clone()) {
            return;
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let id = session_id.clone();
            let suggestion = cx
                .background_executor()
                .spawn(async move {
                    let loaded = library.load_session(&id).ok()?;
                    let input = jl_intelligence::input_from_archive(&loaded.archive);
                    // A frame just after the first error (or near the end) gives the model the
                    // on-screen text; Vision reads it on device.
                    let at = jl_intelligence::suggested_frame_offset_ms(&input).max(0) as u64;
                    let frame = jl_media::frame_png(&loaded.video_path, at).ok().and_then(|png| {
                        let path = std::env::temp_dir().join(format!("jl-suggest-{id}.png"));
                        std::fs::write(&path, png).ok().map(|_| path)
                    });
                    let s = jl_intelligence::suggest(&input, frame.as_deref(), std::time::Duration::from_secs(10)).ok();
                    if let Some(path) = frame {
                        std::fs::remove_file(path).ok();
                    }
                    let s = s?;
                    Some(Suggestion {
                        title: s.title,
                        description: s.description,
                        on_device: s.source == jl_intelligence::SuggestionSource::AppleIntelligence,
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                this.suggesting.remove(&session_id);
                if let Some(s) = suggestion {
                    this.suggestions.insert(session_id, s);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}
