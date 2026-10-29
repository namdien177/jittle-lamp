//! Title and description suggestions for a finished recording, written on the device by Apple
//! Intelligence (FoundationModels, macOS 26+) with Vision text recognition on one frame. Nothing
//! leaves the machine.
//!
//! The model runs in `jl-intelligence-helper`, a Swift command-line tool built by `build.rs`
//! (JSON on stdin, JSON on stdout), so the app needs no Swift runtime of its own and a crash or
//! hang in the framework can't take it down. When the helper is missing, Apple Intelligence is
//! unavailable or generation fails, `suggest` falls back to a deterministic heuristic.

mod helper;
mod heuristic;
mod input;

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};

pub use helper::{HELPER_NAME, helper_path};
pub use heuristic::heuristic_suggestion;
pub use input::{
    ActionLine, ConsoleLine, FailedRequest, SourceInfo, SuggestionInput, input_from_archive,
    suggested_frame_offset_ms,
};

use helper::{Reply, Request};

pub const MAX_TITLE_CHARS: usize = 70;
const MAX_DESCRIPTION_CHARS: usize = 400;
/// How long an "unavailable" answer is trusted: the model may finish downloading, or the user may
/// turn Apple Intelligence on, while the app is open.
const UNAVAILABLE_TTL: Duration = Duration::from_secs(60);
const AVAILABILITY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub title: String,
    pub description: String,
    pub source: SuggestionSource,
    /// Why the heuristic was used instead of Apple Intelligence.
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SuggestionSource {
    AppleIntelligence,
    Heuristic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Availability {
    Available,
    Unavailable {
        reason: UnavailableReason,
        /// A sentence for the UI, e.g. "Apple Intelligence is turned off in System Settings."
        message: String,
    },
}

impl Availability {
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available)
    }

    fn unavailable(reason: UnavailableReason, message: impl Into<String>) -> Self {
        Self::Unavailable {
            reason,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UnavailableReason {
    DeviceNotEligible,
    AppleIntelligenceNotEnabled,
    ModelNotReady,
    /// macOS 15, or a helper built against an SDK without FoundationModels.
    UnsupportedOs,
    /// The helper isn't next to the executable and wasn't built.
    HelperMissing,
    /// The helper failed to answer.
    Other,
}

impl UnavailableReason {
    fn from_code(code: &str) -> Self {
        match code {
            "deviceNotEligible" => Self::DeviceNotEligible,
            "appleIntelligenceNotEnabled" => Self::AppleIntelligenceNotEnabled,
            "modelNotReady" => Self::ModelNotReady,
            "unsupportedOS" => Self::UnsupportedOs,
            _ => Self::Other,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::DeviceNotEligible => "This Mac doesn't support Apple Intelligence.",
            Self::AppleIntelligenceNotEnabled => {
                "Apple Intelligence is turned off in System Settings."
            }
            Self::ModelNotReady => {
                "The Apple Intelligence model is still downloading or preparing."
            }
            Self::UnsupportedOs => "Apple Intelligence needs macOS 26 or later.",
            Self::HelperMissing => "The Apple Intelligence helper is missing from the app.",
            Self::Other => "Apple Intelligence is unavailable.",
        }
    }
}

static AVAILABILITY: Mutex<Option<(Instant, Availability)>> = Mutex::new(None);

/// Whether Apple Intelligence can be used. Cached: `Available` for the process lifetime,
/// anything else for a minute. The first call runs the helper (tens of milliseconds).
pub fn availability() -> Availability {
    let mut cache = AVAILABILITY
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(cached) = fresh(cache.as_ref()) {
        return cached;
    }
    let probed = probe_availability();
    *cache = Some((Instant::now(), probed.clone()));
    probed
}

fn fresh(cached: Option<&(Instant, Availability)>) -> Option<Availability> {
    let (at, availability) = cached?;
    (availability.is_available() || at.elapsed() < UNAVAILABLE_TTL).then(|| availability.clone())
}

fn remember(availability: Availability) {
    let mut cache = AVAILABILITY
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *cache = Some((Instant::now(), availability));
}

fn probe_availability() -> Availability {
    let Some(helper) = helper_path() else {
        return Availability::unavailable(
            UnavailableReason::HelperMissing,
            UnavailableReason::HelperMissing.message(),
        );
    };
    match helper::run(
        &helper,
        &["--availability"],
        Vec::new(),
        AVAILABILITY_TIMEOUT,
    ) {
        Ok(Reply::Unavailable { reason, message }) => Availability::unavailable(reason, message),
        Ok(_) => Availability::Available,
        Err(error) => {
            log::warn!("Apple Intelligence availability check failed: {error:#}");
            Availability::unavailable(UnavailableReason::Other, format!("{error:#}"))
        }
    }
}

/// A title and description for the recording: Apple Intelligence when it's available (with the
/// on-screen text of `frame_png` as extra context), else the heuristic. Blocks for up to
/// `timeout` (2–4 s is typical with the model warm; allow ~10 s for a cold start). Fallbacks
/// are `Ok` with `fallback_reason` set; the `Result` is for the caller's convenience.
pub fn suggest(
    input: &SuggestionInput,
    frame_png: Option<&Path>,
    timeout: Duration,
) -> Result<Suggestion> {
    match suggest_with_model(input, frame_png, timeout) {
        Ok(suggestion) => Ok(suggestion),
        Err(error) => {
            log::info!("Using the heuristic title: {error:#}");
            let mut suggestion = heuristic_suggestion(input);
            suggestion.fallback_reason = Some(format!("{error:#}"));
            Ok(suggestion)
        }
    }
}

fn suggest_with_model(
    input: &SuggestionInput,
    frame_png: Option<&Path>,
    timeout: Duration,
) -> Result<Suggestion> {
    let cached = AVAILABILITY
        .lock()
        .ok()
        .and_then(|cache| fresh(cache.as_ref()));
    if let Some(Availability::Unavailable { message, .. }) = cached {
        bail!(message);
    }
    let Some(helper) = helper_path() else {
        bail!(UnavailableReason::HelperMissing.message());
    };
    let frame = frame_png.filter(|path| {
        let exists = path.is_file();
        if !exists {
            log::warn!(
                "Frame {} doesn't exist; suggesting without it",
                path.display()
            );
        }
        exists
    });
    let frame = frame.and_then(|path| std::path::absolute(path).ok());
    let request = serde_json::to_vec(&Request {
        input,
        frame_path: frame.as_deref(),
    })?;

    match helper::run(&helper, &[], request, timeout)? {
        Reply::Suggestion { title, description } => {
            remember(Availability::Available);
            let title = clean_title(&title);
            let description = clean_description(&description);
            if title.is_empty() || description.is_empty() {
                bail!("Apple Intelligence returned an empty title or description");
            }
            Ok(Suggestion {
                title,
                description,
                source: SuggestionSource::AppleIntelligence,
                fallback_reason: None,
            })
        }
        Reply::Unavailable { reason, message } => {
            remember(Availability::unavailable(reason, message.clone()));
            bail!(message)
        }
        Reply::Available => bail!("the helper returned no suggestion"),
    }
}

/// One line, at most `MAX_TITLE_CHARS`, without quotes, a label, a "Recording of" lead-in or a
/// trailing period.
pub(crate) fn clean_title(raw: &str) -> String {
    let mut title = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let quotes: &[char] = &['"', '\'', '“', '”', '‘', '’', '`'];
    loop {
        let before = title.len();
        // Only quotes that wrap the whole title; `Open "Finder"` keeps its closing quote.
        if let Some(inner) = title
            .strip_prefix(quotes)
            .and_then(|rest| rest.strip_suffix(quotes))
        {
            title = inner.trim().to_owned();
        }
        for prefix in [
            "title:",
            "recording of",
            "recording:",
            "video of",
            "screen recording of",
        ] {
            if title.len() >= prefix.len()
                && title.is_char_boundary(prefix.len())
                && title[..prefix.len()].eq_ignore_ascii_case(prefix)
            {
                title = title[prefix.len()..].trim().to_owned();
            }
        }
        title = title.trim_end_matches(['.', ' ']).to_owned();
        if title.len() == before {
            break;
        }
    }
    // Capitalize "checkout fails" but not "iPhone" or "eBay".
    let mut chars = title.chars();
    if let (Some(first), second) = (chars.next(), chars.next())
        && first.is_lowercase()
        && second.is_none_or(|c| !c.is_uppercase())
    {
        title = first.to_uppercase().chain(title.chars().skip(1)).collect();
    }
    if title.chars().count() <= MAX_TITLE_CHARS {
        return title;
    }
    // Cut at a word boundary, leaving room for the ellipsis.
    let cut: String = title.chars().take(MAX_TITLE_CHARS - 1).collect();
    let cut = match cut.rfind(' ') {
        Some(at) if at > MAX_TITLE_CHARS / 2 => &cut[..at],
        _ => cut.as_str(),
    };
    format!(
        "{}…",
        cut.trim_end_matches([' ', ',', ':', ';', '-', '–', '.'])
    )
}

/// Whitespace collapsed and at most `MAX_DESCRIPTION_CHARS`, cut at a sentence when possible.
fn clean_description(raw: &str) -> String {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = text.trim_matches(['"', '“', '”']).trim();
    if text.chars().count() <= MAX_DESCRIPTION_CHARS {
        return text.to_owned();
    }
    let cut: String = text.chars().take(MAX_DESCRIPTION_CHARS - 1).collect();
    match cut.rfind(". ") {
        Some(at) if at > MAX_DESCRIPTION_CHARS / 3 => cut[..=at].to_owned(),
        _ => {
            let cut = cut.rfind(' ').map_or(cut.as_str(), |at| &cut[..at]);
            format!("{}…", cut.trim_end_matches([' ', ',', ';', ':']))
        }
    }
}

#[cfg(test)]
mod tests;
