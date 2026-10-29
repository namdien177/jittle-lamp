//! Running `jl-intelligence-helper` (built from `swift/main.swift`) and reading its reply.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use crate::{SuggestionInput, UnavailableReason};

pub const HELPER_NAME: &str = "jl-intelligence-helper";
const BUILT_HELPER: &str = env!("JL_INTELLIGENCE_HELPER");
/// The helper gives up this much before the caller's deadline, so it can still say why.
const HELPER_MARGIN: Duration = Duration::from_millis(300);

/// The helper next to the running executable (`Contents/MacOS/` in the bundle), else the one
/// this crate's build script compiled.
pub fn helper_path() -> Option<PathBuf> {
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(HELPER_NAME)));
    let built = (!BUILT_HELPER.is_empty()).then(|| PathBuf::from(BUILT_HELPER));
    sibling.into_iter().chain(built).find(|path| path.is_file())
}

/// What goes to the helper's stdin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request<'a> {
    #[serde(flatten)]
    pub input: &'a SuggestionInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_path: Option<&'a Path>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reply {
    Suggestion {
        title: String,
        description: String,
    },
    Available,
    Unavailable {
        reason: UnavailableReason,
        message: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReply {
    available: bool,
    title: Option<String>,
    description: Option<String>,
    reason: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

/// Parses the last JSON line of the helper's stdout; an `error` reply is an `Err`.
pub(crate) fn parse_reply(stdout: &str) -> Result<Reply> {
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .context("the helper printed nothing")?;
    let raw: RawReply = serde_json::from_str(line)
        .with_context(|| format!("the helper printed something other than JSON: {line}"))?;
    if !raw.available {
        let reason = UnavailableReason::from_code(raw.reason.as_deref().unwrap_or_default());
        let message = raw.message.unwrap_or_else(|| reason.message().to_owned());
        return Ok(Reply::Unavailable { reason, message });
    }
    if let Some(error) = raw.error {
        bail!("Apple Intelligence failed: {error}");
    }
    match (raw.title, raw.description) {
        (Some(title), Some(description)) => Ok(Reply::Suggestion { title, description }),
        (None, None) => Ok(Reply::Available),
        _ => bail!("the helper's reply is missing a title or description: {line}"),
    }
}

/// Runs the helper with `stdin`, killing it if it outlives `timeout`.
pub(crate) fn run(
    helper: &Path,
    args: &[&str],
    stdin: Vec<u8>,
    timeout: Duration,
) -> Result<Reply> {
    let helper_timeout = timeout
        .saturating_sub(HELPER_MARGIN)
        .max(Duration::from_millis(100));
    let mut child = Command::new(helper)
        .args(args)
        .arg("--timeout-ms")
        .arg(helper_timeout.as_millis().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to start {}", helper.display()))?;

    let mut child_stdin = child.stdin.take().expect("piped stdin");
    std::thread::spawn(move || {
        // A helper that exits early closes the pipe; its reply says why.
        let _ = child_stdin.write_all(&stdin);
    });
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    // The reply is one JSON line; don't wait for EOF, which a wedged exit could hold back.
    let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        for line in stdout.lines() {
            match line {
                Ok(line) if line.trim_start().starts_with('{') => {
                    text = line;
                    break;
                }
                Ok(line) => text = line,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    return;
                }
            }
        }
        let _ = sender.send(Ok(text));
    });

    let deadline = Instant::now() + timeout;
    let received = receiver.recv_timeout(timeout);
    let status = reap(&mut child, deadline);
    let stdout = match received {
        Ok(result) => result.context("failed to read the helper's output")?,
        Err(_) => bail!(
            "Apple Intelligence timed out after {} ms",
            timeout.as_millis()
        ),
    };
    // The helper has exited or been killed by now, so stderr is closed.
    let stderr = stderr_reader.join().unwrap_or_default();
    let status = status.map_or_else(|| "killed".to_owned(), |status| status.to_string());
    parse_reply(&stdout).map_err(|error| {
        let detail = stderr.trim();
        if detail.is_empty() {
            error
        } else {
            anyhow!("{error} (helper {status}: {detail})")
        }
    })
}

/// Waits briefly for the helper to exit after replying (or past the deadline), then kills it.
fn reap(child: &mut std::process::Child, deadline: Instant) -> Option<std::process::ExitStatus> {
    let grace = Instant::now().max(deadline.min(Instant::now() + Duration::from_millis(500)));
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= grace {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_suggestion() {
        let reply = parse_reply(
            r#"{"available":true,"description":"Clicked Pay; POST /api/orders returned 500.","elapsedMs":812,"ocrLines":3,"title":"Checkout: Pay fails with 500"}"#,
        )
        .unwrap();
        assert_eq!(
            reply,
            Reply::Suggestion {
                title: "Checkout: Pay fails with 500".into(),
                description: "Clicked Pay; POST /api/orders returned 500.".into(),
            }
        );
    }

    #[test]
    fn parses_unavailable_reasons() {
        let reply = parse_reply(
            r#"{"available":false,"message":"Apple Intelligence is turned off in System Settings.","reason":"appleIntelligenceNotEnabled"}"#,
        )
        .unwrap();
        assert_eq!(
            reply,
            Reply::Unavailable {
                reason: UnavailableReason::AppleIntelligenceNotEnabled,
                message: "Apple Intelligence is turned off in System Settings.".into(),
            }
        );
        for (code, reason) in [
            ("deviceNotEligible", UnavailableReason::DeviceNotEligible),
            ("modelNotReady", UnavailableReason::ModelNotReady),
            ("unsupportedOS", UnavailableReason::UnsupportedOs),
            ("somethingNew", UnavailableReason::Other),
        ] {
            let line = format!(r#"{{"available":false,"reason":"{code}"}}"#);
            let Reply::Unavailable {
                reason: parsed,
                message,
            } = parse_reply(&line).unwrap()
            else {
                panic!("{code} should be unavailable");
            };
            assert_eq!(parsed, reason);
            assert_eq!(message, reason.message());
        }
    }

    #[test]
    fn parses_availability_and_errors() {
        assert_eq!(
            parse_reply("{\"available\":true}\n").unwrap(),
            Reply::Available
        );
        let error = parse_reply(r#"{"available":true,"error":"timed out after 9700 ms"}"#)
            .unwrap_err()
            .to_string();
        assert!(error.contains("timed out after 9700 ms"), "{error}");
        assert!(parse_reply("").is_err());
        assert!(parse_reply("Segmentation fault").is_err());
        assert!(parse_reply(r#"{"available":true,"title":"Only a title"}"#).is_err());
    }

    #[test]
    fn reads_the_last_line() {
        let stdout =
            "warning: something\n{\"available\":true,\"title\":\"A\",\"description\":\"B\"}\n\n";
        assert!(matches!(parse_reply(stdout), Ok(Reply::Suggestion { .. })));
    }

    #[test]
    fn request_is_camel_case_with_the_frame_path() {
        let input = SuggestionInput {
            page_url: "app://com.apple.Safari".into(),
            duration_ms: Some(1500.0),
            ..SuggestionInput::default()
        };
        let request = Request {
            input: &input,
            frame_path: Some(Path::new("/tmp/frame.png")),
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["pageUrl"], "app://com.apple.Safari");
        assert_eq!(json["durationMs"], 1500.0);
        assert_eq!(json["framePath"], "/tmp/frame.png");
        assert!(json["windowTitles"].as_array().unwrap().is_empty());
        assert!(json["failedRequests"].as_array().unwrap().is_empty());
        assert!(json["source"]["bundleId"].is_null());
    }
}
