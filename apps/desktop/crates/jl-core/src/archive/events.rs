//! Entry payloads. Field order follows the Zod schemas so rewritten archives match the TS writer.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::serde_util::{double_option, literal, num, opt_num};

literal!(ConsoleKind, "console");
literal!(NetworkKind, "network");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapturePhase {
    Idle,
    Armed,
    Recording,
    Paused,
    Processing,
    Ready,
    Failed,
}

impl CapturePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Armed => "armed",
            Self::Recording => "recording",
            Self::Paused => "paused",
            Self::Processing => "processing",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

// Interactions are both the largest and the most common payload, so boxing them saves nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ActionPayload {
    Interaction(InteractionEvent),
    Error(ErrorEvent),
    Lifecycle(LifecycleEvent),
    Integration(IntegrationEvent),
}

impl ActionPayload {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Interaction(_) => "interaction",
            Self::Error(_) => "error",
            Self::Lifecycle(_) => "lifecycle",
            Self::Integration(_) => "integration",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<InteractionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<PageMetrics>,
    #[serde(flatten)]
    pub detail: Interaction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Interaction {
    Click(Click),
    Input(Input),
    Submit(Submit),
    Navigation(Navigation),
    Keyboard(Keyboard),
    Selection(Selection),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Click {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_num"
    )]
    pub x: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_num"
    )]
    pub y: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_num"
    )]
    pub client_x: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_num"
    )]
    pub client_y: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_num"
    )]
    pub page_x: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_num"
    )]
    pub page_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buttons: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub click_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Modifiers>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_index: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    pub selection_start: Option<Option<u64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    pub selection_end: Option<Option<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_composing: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitter_selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Navigation {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigation_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referrer: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyboard {
    /// `keydown` or `keyup`.
    pub event_type: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_composing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Modifiers>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub selected_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_text_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_selector: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Modifiers {
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub meta: bool,
    #[serde(default)]
    pub shift: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default)]
    pub selector_alternates: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_test_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    pub role: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    #[serde(serialize_with = "num")]
    pub left: f64,
    #[serde(serialize_with = "num")]
    pub top: f64,
    #[serde(serialize_with = "num")]
    pub width: f64,
    #[serde(serialize_with = "num")]
    pub height: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMetrics {
    pub viewport: Size,
    pub document: Size,
    pub scroll: Point,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_num"
    )]
    pub device_pixel_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Size {
    pub width: u64,
    pub height: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    #[serde(serialize_with = "num")]
    pub x: f64,
    #[serde(serialize_with = "num")]
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorEvent {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// `page`, `extension` or `runtime`.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LifecycleEvent {
    pub phase: CapturePhase,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationEvent {
    /// `sql` or `http`.
    pub integration: String,
    pub profile: String,
    pub statement: String,
    pub row_count: u64,
    #[serde(default)]
    pub sample: Vec<Map<String, Value>>,
    #[serde(serialize_with = "num")]
    pub duration_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConsoleEvent {
    pub kind: ConsoleKind,
    pub level: ConsoleLevel,
    pub message: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkSubtype {
    Xhr,
    Fetch,
    Document,
    Stylesheet,
    Script,
    Image,
    Font,
    Media,
    Websocket,
    #[default]
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEvent {
    pub kind: NetworkKind,
    pub method: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtype: Option<NetworkSubtype>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "opt_num"
    )]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub request: NetworkRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<NetworkResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_text: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NetworkRequest {
    #[serde(default)]
    pub headers: Vec<Header>,
    #[serde(default)]
    pub cookies: Vec<AssociatedCookie>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<BodyCapture>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkResponse {
    #[serde(default)]
    pub headers: Vec<Header>,
    #[serde(default)]
    pub set_cookie_headers: Vec<String>,
    /// Parsed `Set-Cookie` entries, kept verbatim.
    #[serde(default)]
    pub set_cookies: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<BodyCapture>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociatedCookie {
    pub cookie: Value,
    #[serde(default)]
    pub blocked_reasons: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyDisposition {
    Captured,
    Truncated,
    Omitted,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyEncoding {
    Utf8,
    Base64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyCapture {
    pub disposition: BodyDisposition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<BodyEncoding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted_byte_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl BodyCapture {
    /// The body as text, JSON pretty-printed when it parses; `None` for binary or missing bodies.
    pub fn display_text(&self) -> Option<String> {
        if self.encoding == Some(BodyEncoding::Base64) {
            return None;
        }
        let value = self.value.as_deref()?;
        match serde_json::from_str::<Value>(value) {
            Ok(parsed @ (Value::Object(_) | Value::Array(_))) => {
                serde_json::to_string_pretty(&parsed).ok()
            }
            _ => Some(value.to_owned()),
        }
    }
}
