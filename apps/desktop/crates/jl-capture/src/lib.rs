//! macOS capture for Jittle Lamp: ScreenCaptureKit recording, unified-log capture and input
//! events. Every API is blocking and `Send + Sync`; long-running work runs on owned threads and
//! reports over `crossbeam_channel`.

pub mod archive;
pub mod content;
mod input;
pub mod logs;
pub mod mask;
pub mod mp4;
pub mod permissions;
pub mod recorder;
pub mod session_id;
mod sys;

pub use content::{
    AppInfo, ContentOptions, DisplayInfo, Shareable, WindowInfo, shareable_content,
    shareable_content_with,
};
pub use logs::{ConsoleLevel, LogBudget, LogFilter, LogLine, LogStream, LogTarget};
pub use mask::{mask_secret_value, mask_secrets};
pub use permissions::{PermissionStatus, Permissions, SettingsPane, open_settings, permissions};
pub use recorder::{
    ActionKind, AppSelector, CaptureTarget, FinishedRecording, LiveStats, Recorder, RecorderEvent,
    RecordingOptions,
};
pub use session_id::{is_valid_session_id, new_session_id};
pub use sys::{Rect, app_icon_png};
