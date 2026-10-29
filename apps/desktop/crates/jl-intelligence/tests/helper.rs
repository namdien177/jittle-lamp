//! Runs the real helper, so it needs a Mac with Apple Intelligence turned on:
//!
//!   cargo test -p jl-intelligence --test helper -- --ignored --nocapture
//!
//! `JL_INTELLIGENCE_FRAME=<png>` adds a frame for the on-screen text pass.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use jl_intelligence::{Availability, SuggestionSource, input_from_archive, suggest};

fn fixture(path: &str) -> jl_core::SessionArchive {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    jl_core::parse_archive(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
#[ignore = "runs Apple Intelligence on this Mac"]
fn suggests_with_apple_intelligence() {
    let helper = jl_intelligence::helper_path().expect("the build script compiles the helper");
    println!("helper: {}", helper.display());

    let started = Instant::now();
    let availability = jl_intelligence::availability();
    println!(
        "availability: {availability:?} ({} ms)",
        started.elapsed().as_millis()
    );
    if availability != Availability::Available {
        println!("skipping: Apple Intelligence is unavailable");
        return;
    }

    let frame = std::env::var_os("JL_INTELLIGENCE_FRAME").map(PathBuf::from);
    let cases = [
        ("desktop (cold)", "tests/fixtures/desktop-ledger.json", None),
        ("desktop (warm)", "tests/fixtures/desktop-ledger.json", None),
        (
            "extension",
            "../jl-core/tests/fixtures/extension-v5.json",
            None,
        ),
        (
            "desktop + frame",
            "tests/fixtures/desktop-ledger.json",
            frame.as_deref(),
        ),
    ];
    for (name, path, frame) in cases {
        if name.ends_with("frame") && frame.is_none() {
            continue;
        }
        let input = input_from_archive(&fixture(path));
        let started = Instant::now();
        let suggestion = suggest(&input, frame, Duration::from_secs(20)).unwrap();
        let elapsed = started.elapsed();
        println!(
            "\n[{name}] {} ms, {:?}{}\n  title:       {}\n  description: {}",
            elapsed.as_millis(),
            suggestion.source,
            suggestion
                .fallback_reason
                .as_deref()
                .map(|reason| format!(" ({reason})"))
                .unwrap_or_default(),
            suggestion.title,
            suggestion.description
        );
        assert_eq!(
            suggestion.source,
            SuggestionSource::AppleIntelligence,
            "{name}"
        );
        assert!(!suggestion.title.is_empty() && suggestion.title.chars().count() <= 70);
        assert!(!suggestion.title.ends_with('.'));
        assert!(!suggestion.description.is_empty());
    }
}

#[test]
#[ignore = "runs the helper"]
fn a_tiny_timeout_falls_back_without_hanging() {
    let input = input_from_archive(&fixture("tests/fixtures/desktop-ledger.json"));
    let started = Instant::now();
    let suggestion = suggest(&input, None, Duration::from_millis(400)).unwrap();
    let elapsed = started.elapsed();
    println!("{elapsed:?} {suggestion:?}");
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    assert_eq!(suggestion.source, SuggestionSource::Heuristic);
    assert!(suggestion.fallback_reason.is_some());
}
