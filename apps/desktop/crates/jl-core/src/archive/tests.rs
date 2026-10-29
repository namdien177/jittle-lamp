use super::*;
use crate::test_support::fixture;

#[test]
fn v5_round_trips_byte_for_byte() {
    for name in [
        "extension-v5.json",
        "runner-v5-expected.json",
        "canonical-medium.json",
    ] {
        let text = fixture(name);
        let archive = parse_archive(text.as_bytes()).unwrap();
        assert_eq!(to_pretty_json(&archive), text, "{name}");
    }
}

#[test]
fn v3_upgrades_to_the_same_archive_ts_produces() {
    let archive = parse_archive(fixture("extension-v3.json").as_bytes()).unwrap();
    let expected = parse_archive(fixture("extension-v5.json").as_bytes()).unwrap();
    assert_eq!(archive.schema_version, 5);
    assert_eq!(archive, expected);
    assert_eq!(to_pretty_json(&archive), fixture("extension-v5.json"));
}

#[test]
fn v4_upgrades_to_v5() {
    let archive = parse_archive(fixture("runner-v4.json").as_bytes()).unwrap();
    assert_eq!(to_pretty_json(&archive), fixture("runner-v5-expected.json"));
    assert_eq!(archive.recorder.kind(), RecorderKind::E2eRunner);
    let steps = archive.step_annotations();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].mode, Some(StepMode::Deterministic));
    assert!(matches!(
        archive.sections.actions[3].payload,
        ActionPayload::Integration(_)
    ));
}

#[test]
fn typed_payloads_expose_viewer_fields() {
    let archive = parse_archive(fixture("extension-v5.json").as_bytes()).unwrap();
    let click = &archive.sections.actions[2].payload;
    let ActionPayload::Interaction(InteractionEvent {
        target: Some(target),
        detail: Interaction::Click(click),
        ..
    }) = click
    else {
        panic!("expected click, got {click:?}");
    };
    assert_eq!(target.tag_name.as_deref(), Some("BUTTON"));
    assert_eq!(click.x, Some(120.5));
    assert!(click.modifiers.unwrap().meta);

    let network = &archive.sections.network[0].payload;
    assert_eq!(network.status, Some(401));
    assert_eq!(network.duration_ms, Some(87.25));
    assert_eq!(network.request.headers[0].name, "authorization");
    let body = network
        .request
        .body
        .as_ref()
        .unwrap()
        .display_text()
        .unwrap();
    assert!(body.contains("\n  \"password\""));
    assert_eq!(archive.console_error_count(), 1);
    assert_eq!(archive.action_count(), 7);
    assert_eq!(archive.duration_ms(), Some(5080.0));
    assert_eq!(
        archive.recording_start_ms(),
        parse_timestamp_ms("2026-09-09T05:42:55.813Z").unwrap()
    );
}

#[test]
fn unknown_fields_are_tolerated_and_defaults_filled() {
    let raw = serde_json::json!({
        "schemaVersion": 5,
        "sessionId": "jl_abcdefgh",
        "name": "Minimal",
        "createdAt": "2026-01-01T00:00:00.000+07:00",
        "updatedAt": "2026-01-01T00:00:01.000+07:00",
        "phase": "ready",
        "page": { "url": "https://example.com/", "title": "Example", "future": true },
        "artifacts": [],
        "sections": {
            "console": [{ "id": "c1", "seq": 0, "at": "2026-01-01T00:00:00.500+07:00",
                          "payload": { "kind": "console", "level": "error", "message": "boom" } }]
        },
        "somethingNew": { "nested": 1 }
    });
    let archive = parse_archive_value(raw).unwrap();
    assert_eq!(archive.recorder, Recorder::default());
    assert_eq!(archive.summary, ArchiveSummary::default());
    let json: Value = serde_json::from_str(&to_pretty_json(&archive)).unwrap();
    assert_eq!(
        json["sections"]["console"][0]["payload"]["args"],
        serde_json::json!([])
    );
    assert_eq!(json["summary"]["videoDurationMs"], Value::Null);
    assert!(json.get("somethingNew").is_none());
}

#[test]
fn rejects_bad_archives() {
    assert!(parse_archive(b"{ broken").is_err());
    assert!(parse_archive(br#"{"schemaVersion":99,"bad":true}"#).is_err());
    let mut raw: Value = serde_json::from_str(&fixture("extension-v5.json")).unwrap();
    raw["createdAt"] = Value::from("yesterday");
    assert!(parse_archive_value(raw).is_err());
}

#[test]
fn desktop_recorder_and_mp4_artifact() {
    let mut archive = parse_archive(fixture("canonical-medium.json").as_bytes()).unwrap();
    archive.recorder = Recorder::Desktop {
        recorder: DesktopRecorderInfo {
            name: "jittle-lamp-desktop".into(),
            version: "1.8.5".into(),
            os: "macOS 26.1".into(),
            source: CaptureSource {
                kind: CaptureSourceKind::Application,
                name: "Safari".into(),
                bundle_id: Some("com.apple.Safari".into()),
                pid: Some(412),
            },
        },
    };
    archive.artifacts = session_artifacts(&archive.session_id, ArtifactKind::RecordingMp4);
    let text = to_pretty_json(&archive);
    let json: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["recorder"]["kind"], "desktop-recorder");
    assert_eq!(
        json["recorder"]["recorder"]["source"]["type"],
        "application"
    );
    assert_eq!(
        json["recorder"]["recorder"]["source"]["bundleId"],
        "com.apple.Safari"
    );
    assert_eq!(json["artifacts"][0]["kind"], "recording.mp4");
    assert_eq!(json["artifacts"][0]["mimeType"], "video/mp4");
    assert_eq!(parse_archive(text.as_bytes()).unwrap(), archive);
}

#[test]
fn replace_merge_groups_keeps_steps() {
    let archive = parse_archive(fixture("runner-v5-expected.json").as_bytes()).unwrap();
    let group = Annotation::MergeGroup(MergeGroup::new(
        "merge-2",
        vec!["a".into(), "b".into()],
        "New",
        "2026-10-03T08:00:09.000Z",
    ));
    let next = replace_merge_groups(&archive.annotations, std::slice::from_ref(&group));
    let ids: Vec<_> = next.iter().map(Annotation::id).collect();
    assert_eq!(ids, ["step-1", "step-2", "merge-2"]);
}

#[test]
fn whole_floats_serialize_as_integers() {
    let summary = ArchiveSummary {
        video_duration_ms: Some(1200.0),
        action_count: Some(1),
        request_count: None,
    };
    assert_eq!(
        serde_json::to_string(&summary).unwrap(),
        r#"{"videoDurationMs":1200,"actionCount":1,"requestCount":null}"#
    );
}
