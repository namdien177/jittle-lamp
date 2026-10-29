use std::path::PathBuf;

use jl_core::SessionArchive;
use serde_json::json;

use super::*;

fn fixture(path: &str) -> SessionArchive {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    jl_core::parse_archive(&bytes).unwrap()
}

fn core_fixture(name: &str) -> SessionArchive {
    fixture(&format!("../jl-core/tests/fixtures/{name}"))
}

fn desktop() -> SessionArchive {
    fixture("tests/fixtures/desktop-ledger.json")
}

fn labels(input: &SuggestionInput) -> Vec<&str> {
    input.actions.iter().map(|a| a.label.as_str()).collect()
}

#[test]
fn desktop_archive_input() {
    let input = input_from_archive(&desktop());
    assert_eq!(
        input.source,
        SourceInfo {
            kind: "application".into(),
            name: "Ledger".into(),
            bundle_id: Some("com.example.ledger".into()),
        }
    );
    assert_eq!(input.page_url, "app://com.example.ledger");
    assert_eq!(input.page_title, "Ledger");
    assert_eq!(input.duration_ms, Some(16000.0));
    assert_eq!(input.window_titles, ["Invoice INV-1042 — Edited", "Finder"]);
    assert_eq!(input.markers, ["Save shows error sheet"]);
    // AX roles read as words, shortcuts as keys, and repeats fold.
    assert_eq!(
        labels(&input),
        [
            "Click \"New Invoice\" button",
            "Navigate to \"Invoice INV-1042 — Edited\"",
            "Click \"Customer\" button",
            "Click \"Northwind Traders\" menu item",
            "Click \"Add Line Item\" button (×2)",
            "Press Cmd+S",
            "Click \"OK\" button",
            "Navigate to \"Finder\"",
        ]
    );
    assert_eq!(input.actions[5].at_ms, 11000);
    // Errors first in time order, then warnings; info is dropped; secrets are masked.
    let console: Vec<_> = input
        .console
        .iter()
        .map(|line| (line.level.as_str(), line.at_ms))
        .collect();
    assert_eq!(
        console,
        [("error", 11050), ("error", 11060), ("warn", 4200)]
    );
    assert!(
        input.console[0]
            .message
            .starts_with("Failed to save document INV-1042")
    );
    assert!(
        !input.console[1]
            .message
            .contains("sk_live_9f8a7b6c5d4e3f2a1b0c")
    );
    assert!(input.console[1].message.contains("****"));
    assert!(input.failed_requests.is_empty());
}

#[test]
fn extension_archive_input() {
    for name in ["extension-v5.json", "extension-v3.json"] {
        let input = input_from_archive(&core_fixture(name));
        assert_eq!(input.source.kind, "browser tab", "{name}");
        assert_eq!(input.source.name, "parent.example.test");
        assert_eq!(input.source.bundle_id, None);
        assert_eq!(input.page_url, "https://parent.example.test/reports");
        assert_eq!(input.page_title, "Báo cáo phụ huynh");
        assert_eq!(input.duration_ms, Some(5080.0));
        assert_eq!(input.window_titles, ["Dashboard"]);
        assert!(input.markers.is_empty());
        // Lifecycle rows are not actions; the uncaught page error becomes a console error.
        assert_eq!(input.actions.len(), 7);
        assert!(labels(&input).contains(&"Press Enter"));
        assert!(input.actions.iter().all(|a| !a.label.contains("Recording")));
        let errors: Vec<_> = input
            .console
            .iter()
            .filter(|line| line.level == "error")
            .map(|line| line.message.as_str())
            .collect();
        assert_eq!(
            errors,
            [
                "[Báo cáo phụ huynh] TypeError: x is undefined",
                "[admin.example.test] Failed to load resource"
            ]
        );
        assert_eq!(
            input.failed_requests,
            [FailedRequest {
                at_ms: 2480,
                method: "POST".into(),
                path: "/api/login".into(),
                status: Some(401),
                failure: None,
            }]
        );
    }
}

#[test]
fn runner_archive_input() {
    let input = input_from_archive(&core_fixture("runner-v5-expected.json"));
    assert_eq!(input.source.kind, "automated browser test");
    assert_eq!(input.source.name, "uat.example.test");
    // The integration row keeps only its header line, not the statement or sample rows.
    assert_eq!(labels(&input)[2], "SQL uat-db · 1 row · 13ms");
    assert!(input.console.is_empty(), "info logs are dropped");
    assert!(
        input.failed_requests.is_empty(),
        "2xx requests are not failures"
    );
}

#[test]
fn canonical_archive_input_caps_and_requests() {
    let input = input_from_archive(&core_fixture("canonical-medium.json"));
    assert_eq!(input.actions.len(), 20, "under the cap, nothing is dropped");
    let requests: Vec<_> = input
        .failed_requests
        .iter()
        .map(FailedRequest::summary)
        .collect();
    assert_eq!(
        requests,
        [
            "POST /api/graphql returned 500",
            "GET /api/timeout failed (net::ERR_TIMED_OUT)"
        ]
    );
}

#[test]
fn long_recordings_keep_the_start_and_the_end() {
    let mut archive = core_fixture("canonical-medium.json");
    let template = archive.sections.actions[1].clone();
    archive.sections.actions.truncate(1);
    for index in 0..60u64 {
        let mut action = template.clone();
        action.id = format!("a{index}");
        action.seq = index + 10;
        action.at = format!("2024-06-01T12:{:02}:{:02}.000Z", index / 60, index % 60);
        if let jl_core::archive::ActionPayload::Interaction(event) = &mut action.payload {
            event.selector = Some(format!("#button-{index}"));
        }
        archive.sections.actions.push(action);
    }
    let input = input_from_archive(&archive);
    let labels = labels(&input);
    assert_eq!(labels.len(), 25, "24 actions and a gap row");
    assert_eq!(labels[0], "click #button-0");
    assert_eq!(labels[5], "click #button-5");
    assert_eq!(labels[6], "… 36 more actions");
    assert_eq!(labels[7], "click #button-42");
    assert_eq!(labels[24], "click #button-59");
}

#[test]
fn failed_requests_dedupe_strip_queries_and_name_foreign_hosts() {
    let mut archive = core_fixture("extension-v5.json");
    let template = archive.sections.network[0].clone();
    let urls = [
        (
            "https://parent.example.test/api/login?token=abc#x",
            Some(401),
        ),
        ("https://parent.example.test/api/login?token=def", Some(401)),
        ("https://user:pw@cdn.example.test/logo.png", Some(404)),
        ("https://parent.example.test/ok", Some(302)),
    ];
    archive.sections.network.clear();
    for (index, (url, status)) in urls.into_iter().enumerate() {
        let mut entry = template.clone();
        entry.id = format!("n{index}");
        entry.payload.url = url.into();
        entry.payload.status = status;
        archive.sections.network.push(entry);
    }
    let input = input_from_archive(&archive);
    let paths: Vec<_> = input
        .failed_requests
        .iter()
        .map(|r| r.path.as_str())
        .collect();
    assert_eq!(paths, ["/api/login", "cdn.example.test/logo.png"]);
}

#[test]
fn heuristic_names_the_app_and_first_error() {
    let suggestion = heuristic_suggestion(&input_from_archive(&desktop()));
    assert_eq!(suggestion.source, SuggestionSource::Heuristic);
    assert_eq!(
        suggestion.title,
        "Ledger: Failed to save document INV-1042: NSCocoaErrorDomain…"
    );
    assert!(suggestion.title.chars().count() <= MAX_TITLE_CHARS);
    assert!(
        suggestion
            .description
            .starts_with("After pressing Cmd+S (00:11): Failed to save document INV-1042"),
        "{}",
        suggestion.description
    );
    assert!(
        suggestion
            .description
            .ends_with(" 1 more error was captured.")
    );
}

#[test]
fn heuristic_prefers_the_earliest_error() {
    let suggestion = heuristic_suggestion(&input_from_archive(&core_fixture("extension-v5.json")));
    assert_eq!(
        suggestion.title,
        "Báo cáo phụ huynh: POST /api/login returned 401"
    );
    assert_eq!(
        suggestion.description,
        "After submitting (00:02): POST /api/login returned 401. 2 more errors were captured."
    );
}

#[test]
fn heuristic_without_errors() {
    let mut input = input_from_archive(&desktop());
    input.console.clear();
    let with_marker = heuristic_suggestion(&input);
    assert_eq!(with_marker.title, "Ledger: Save shows error sheet");
    assert_eq!(
        with_marker.description,
        "8 actions in Ledger over 16 s; no console errors or failed requests were captured."
    );

    input.markers.clear();
    assert_eq!(
        heuristic_suggestion(&input).title,
        "Ledger: Navigate to \"Finder\""
    );

    let empty = SuggestionInput::default();
    let suggestion = heuristic_suggestion(&empty);
    assert_eq!(suggestion.title, "Recording walkthrough");
    assert_eq!(
        suggestion.description,
        "No actions in Recording; no console errors or failed requests were captured."
    );
}

#[test]
fn heuristic_display_recordings_use_the_front_window() {
    let input = SuggestionInput {
        source: SourceInfo {
            kind: "display".into(),
            name: "Built-in Retina Display".into(),
            bundle_id: None,
        },
        window_titles: vec!["Xcode — jl-app".into()],
        markers: vec!["Build hangs".into()],
        ..SuggestionInput::default()
    };
    assert_eq!(
        heuristic_suggestion(&input).title,
        "Xcode — jl-app: Build hangs"
    );
}

#[test]
fn frame_offset_prefers_the_first_error() {
    let input = input_from_archive(&desktop());
    assert_eq!(suggested_frame_offset_ms(&input), 11800);
    let mut quiet = input.clone();
    quiet.console.clear();
    assert_eq!(suggested_frame_offset_ms(&quiet), 15500);
}

#[test]
fn titles_are_cleaned() {
    for (raw, clean) in [
        (
            "\"Checkout: Pay fails with 500.\"",
            "Checkout: Pay fails with 500",
        ),
        ("Title: Recording of Safari checkout", "Safari checkout"),
        ("  “Settings toggle resets”  ", "Settings toggle resets"),
        ("checkout fails", "Checkout fails"),
        (
            "Finder: Open \"Downloads\" shows nothing",
            "Finder: Open \"Downloads\" shows nothing",
        ),
        (
            "iPhone mirroring drops input",
            "iPhone mirroring drops input",
        ),
    ] {
        assert_eq!(clean_title(raw), clean, "{raw}");
    }
    let long =
        "Invoices: Exporting the quarterly report as CSV produces an empty file with only headers";
    let cleaned = clean_title(long);
    assert!(cleaned.chars().count() <= MAX_TITLE_CHARS, "{cleaned}");
    assert_eq!(
        cleaned,
        "Invoices: Exporting the quarterly report as CSV produces an empty…"
    );
}

#[test]
fn descriptions_are_cleaned() {
    assert_eq!(clean_description("  One.\n\n Two.  "), "One. Two.");
    let long = format!(
        "{} Second sentence that pushes it over the limit.",
        "Word ".repeat(80).trim()
    );
    // A sentence break too early to keep much text is ignored in favour of an ellipsis.
    let cleaned = clean_description(&format!("First sentence here. {long}"));
    assert!(cleaned.chars().count() <= MAX_DESCRIPTION_CHARS);
    assert!(cleaned.ends_with(" Word…"), "{cleaned}");
    let sentences = format!(
        "{} Second.",
        "A long first sentence that goes on. ".repeat(12).trim()
    );
    let cleaned = clean_description(&sentences);
    assert!(cleaned.chars().count() <= MAX_DESCRIPTION_CHARS);
    assert!(cleaned.ends_with("goes on."), "{cleaned}");
}

#[test]
fn input_round_trips_through_the_protocol() {
    let input = input_from_archive(&desktop());
    let value = serde_json::to_value(&input).unwrap();
    assert_eq!(
        value["source"],
        json!({ "kind": "application", "name": "Ledger", "bundleId": "com.example.ledger" })
    );
    assert_eq!(
        value["actions"][5],
        json!({ "atMs": 11000, "label": "Press Cmd+S" })
    );
    let back: SuggestionInput = serde_json::from_value(value).unwrap();
    assert_eq!(back, input);
}

#[test]
fn unavailable_cache_expires_but_available_does_not() {
    let old = Instant::now() - UNAVAILABLE_TTL - Duration::from_secs(1);
    assert_eq!(
        fresh(Some(&(old, Availability::Available))),
        Some(Availability::Available)
    );
    let unavailable = Availability::unavailable(UnavailableReason::ModelNotReady, "later");
    assert_eq!(fresh(Some(&(old, unavailable.clone()))), None);
    assert_eq!(
        fresh(Some(&(Instant::now(), unavailable.clone()))),
        Some(unavailable)
    );
}
