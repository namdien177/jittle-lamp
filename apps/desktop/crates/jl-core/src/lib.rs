//! Platform-independent core of the native desktop app: the session archive model, companion
//! config, the SQLite session library, the companion HTTP server, ZIP bundles and the timeline.

pub mod archive;
pub mod companion;
pub mod config;
pub mod library;
pub mod mask;
mod paths;
#[cfg(test)]
pub(crate) mod test_support;
pub mod timeline;
pub mod zip;

pub use archive::{SessionArchive, parse_archive, to_pretty_json};
pub use library::{Library, LoadedSession, SessionRecord, SessionSource};
pub use mask::mask_secrets;
pub use timeline::{Lane, Severity, TimelineItem, build_timeline};

pub const SESSION_ARCHIVE_FILE: &str = "session.archive.json";
pub const RECORDING_WEBM_FILE: &str = "recording.webm";
pub const RECORDING_MP4_FILE: &str = "recording.mp4";

/// Current time as `Date.prototype.toISOString()` formats it.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
