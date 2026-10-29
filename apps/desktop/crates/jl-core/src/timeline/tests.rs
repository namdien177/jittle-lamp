use serde_json::Value;

use super::*;
use crate::archive::{ArchiveAction, LifecycleEvent, MARKER_TAG, parse_archive};
use crate::test_support::fixture;

fn archive(name: &str) -> SessionArchive {
    parse_archive(fixture(name).as_bytes()).unwrap()
}

#[test]
fn matches_the_ts_timeline() {
    let expected: Value = serde_json::from_str(&fixture("timelines.json")).unwrap();
    for (name, expected) in expected.as_object().unwrap() {
        let archive = archive(name);
        assert_eq!(
            archive.recording_start_ms(),
            expected["anchorMs"].as_i64().unwrap(),
            "{name}"
        );
        let actual: Vec<_> = build_timeline(&archive)
            .into_iter()
            .filter(|item| item.lane != Lane::Step)
            .map(|item| (item.id, item.offset_ms, item.label))
            .collect();
        let expected: Vec<_> = expected["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["id"].as_str().unwrap().to_owned(),
                    item["offsetMs"].as_i64().unwrap(),
                    item["label"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(actual, expected, "{name}");
    }
}

#[test]
fn lanes_severity_and_sources() {
    let archive = archive("extension-v5.json");
    let items = build_timeline(&archive);
    let by_id = |id: &str| items.iter().find(|item| item.id.ends_with(id)).unwrap();

    let login = by_id("network:000000");
    assert_eq!(
        (login.lane, login.severity, login.status),
        (Lane::Network, Severity::Warn, Some(401))
    );
    assert_eq!(login.secondary, "401 Unauthorized · 87 ms");
    assert_eq!(login.end_offset_ms, Some(login.offset_ms + 87));
    assert_eq!(login.source, Source::Network(0));
    assert_eq!(login.method.as_deref(), Some("POST"));

    let error = by_id("actions:000006");
    assert_eq!(
        (error.lane, error.severity),
        (Lane::Console, Severity::Error)
    );
    assert_eq!(error.secondary, "at foo (app.js:1:2)");

    let warn = by_id("console:000000");
    assert_eq!(
        (warn.lane, warn.severity, warn.source),
        (Lane::Console, Severity::Warn, Source::Console(0))
    );

    let click = by_id("actions:000002");
    assert_eq!(
        (click.lane, click.secondary.as_str()),
        (Lane::Action, "button.save")
    );
    assert_eq!(click.tab_label.as_deref(), Some("Báo cáo phụ huynh"));
    assert_eq!(by_id("actions:000000").lane, Lane::Marker);
}

#[test]
fn steps_and_user_markers() {
    let mut archive = archive("runner-v5-expected.json");
    archive.sections.actions.push(ArchiveAction {
        id: "marker-1".into(),
        seq: 99,
        at: "2026-10-03T08:00:04.500Z".into(),
        tab: None,
        tags: vec![MARKER_TAG.into()],
        payload: ActionPayload::Lifecycle(LifecycleEvent {
            phase: CapturePhase::Recording,
            detail: "Spinner never resolves".into(),
        }),
    });
    let items = build_timeline(&archive);
    let steps: Vec<_> = items
        .iter()
        .filter(|item| item.lane == Lane::Step)
        .collect();
    assert_eq!(steps.len(), 2);
    assert_eq!(
        (steps[0].offset_ms, steps[0].end_offset_ms),
        (400, Some(1200))
    );
    assert_eq!(steps[0].secondary, "Step 1 · passed");
    assert_eq!(steps[1].source, Source::Annotation(1));

    let marker = items.iter().find(|item| item.id == "marker-1").unwrap();
    assert_eq!((marker.lane, marker.offset_ms), (Lane::Marker, 4500));
    assert_eq!(
        (marker.label.as_str(), marker.secondary.as_str()),
        ("Spinner never resolves", "Marker")
    );

    let offsets: Vec<_> = items.iter().map(|item| item.offset_ms).collect();
    assert!(offsets.is_sorted());
}

#[test]
fn visible_rows_fold_merge_groups() {
    let archive = archive("extension-v5.json");
    let rows = visible_action_rows(&archive);
    assert_eq!(rows[0].id, "merge-1");
    assert_eq!(rows[0].member_action_ids.len(), 2);
    // click+input merged, then keyboard, submit, error, navigation, selection, navigation.
    assert_eq!(rows.len(), 7);
}

#[test]
fn helpers() {
    let items = build_timeline(&archive("canonical-medium.json"));
    assert_eq!(find_active_index(&items, -1), None);
    assert_eq!(find_active_index(&items, 0), Some(1));
    assert_eq!(find_active_index(&items, 1500), Some(2));
    assert_eq!(format_offset(61_999), "01:01");
    assert_eq!(format_offset(-120), "-00:00");
    assert_eq!(truncate_label_text("  a \n  b "), "a b");
    let long = "ă".repeat(70);
    assert_eq!(truncate_label_text(&long), format!("{}...", "ă".repeat(61)));
    assert_eq!(
        url_hostname("https://Admin.Example.test:8443/x").as_deref(),
        Some("admin.example.test")
    );
    assert_eq!(
        url_hostname("app://com.apple.Safari").as_deref(),
        Some("com.apple.Safari")
    );
    assert_eq!(url_hostname("about:blank").as_deref(), Some(""));
    assert_eq!(url_hostname("not a url"), None);
}
