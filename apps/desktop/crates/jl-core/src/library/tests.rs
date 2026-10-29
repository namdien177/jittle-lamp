use std::path::Path;

use super::*;
use crate::archive::{Annotation, MergeGroup, RecorderKind, parse_archive};
use crate::test_support::write_session;

fn library() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let library = Library::open(dir.path().join("db/sessions.db"), &out).unwrap();
    (dir, library)
}

#[test]
fn list_sessions_scans_webm_and_mp4_folders() {
    let (_dir, library) = library();
    let out = library.output_dir();
    write_session(
        &out,
        "jl_ext_session",
        "extension-v5.json",
        Some("recording.webm"),
    );
    write_session(
        &out,
        "jl_runner_session",
        "runner-v4.json",
        Some("recording.mp4"),
    );
    write_session(&out, "jl_no_video", "canonical-medium.json", None);
    std::fs::create_dir_all(out.join("jl_broken")).unwrap();
    std::fs::write(out.join("jl_broken/session.archive.json"), "{}").unwrap();
    std::fs::write(out.join("jl_broken/recording.webm"), [0]).unwrap();
    std::fs::write(out.join("stray.txt"), "x").unwrap();

    library.add_tag("jl_ext_session", "regression").unwrap();
    library.add_tag("jl_ext_session", "login").unwrap();
    library
        .set_notes("jl_ext_session", "Check the 401")
        .unwrap();
    library
        .mark_remote_synced(
            "jl_runner_session",
            "ev_1",
            "org_1",
            Some("2026-10-04T00:00:00.000Z"),
        )
        .unwrap();

    let sessions = library.list_sessions().unwrap();
    let ids: Vec<_> = sessions.iter().map(|s| s.session_id.as_str()).collect();
    // Newest `createdAt` first: the runner fixture is from October, the extension one from September.
    assert_eq!(ids, ["jl_runner_session", "jl_ext_session"]);

    let runner = &sessions[0];
    assert_eq!(runner.video_mime, "video/mp4");
    assert_eq!(runner.recorder_kind, RecorderKind::E2eRunner);
    assert_eq!(runner.remote.as_ref().unwrap().evidence_id, "ev_1");
    assert_eq!(runner.duration_ms, Some(6000.0));

    let ext = &sessions[1];
    assert_eq!(ext.name, "Báo cáo phụ huynh");
    assert_eq!(ext.page_url, "https://parent.example.test/reports");
    assert_eq!(ext.video_mime, "video/webm");
    assert_eq!(ext.tags, ["login", "regression"]);
    assert_eq!(ext.notes, "Check the 401");
    assert_eq!(
        (ext.action_count, ext.request_count, ext.console_error_count),
        (7, 2, 1)
    );
    assert_eq!(ext.artifacts.len(), 2);
    assert_eq!(
        ext.total_bytes,
        ext.artifacts.iter().map(|a| a.bytes).sum::<u64>()
    );
    assert_eq!(library.all_tags().unwrap(), ["login", "regression"]);
}

#[test]
fn load_session_mirrors_archive_and_seeds_notes() {
    let (_dir, library) = library();
    write_session(
        &library.output_dir(),
        "jl_ext_session",
        "extension-v5.json",
        Some("recording.webm"),
    );

    let loaded = library.load_session("jl_ext_session").unwrap();
    assert_eq!(loaded.source, SessionSource::Library);
    assert_eq!(loaded.notes, "First note\n\nSecond note");
    assert_eq!(
        library.notes("jl_ext_session").unwrap(),
        "First note\n\nSecond note"
    );
    assert!(loaded.video_path.ends_with("jl_ext_session/recording.webm"));

    let conn = library.conn.lock();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_events WHERE session_id = 'jl_ext_session'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let total = loaded.archive.sections.actions.len()
        + loaded.archive.sections.console.len()
        + loaded.archive.sections.network.len();
    assert_eq!(count as usize, total);
    let (subtype, payload): (Option<String>, String) = conn
        .query_row("SELECT subtype, payload_json FROM session_events WHERE section = 'network' ORDER BY seq LIMIT 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(subtype.as_deref(), Some("fetch"));
    assert!(payload.starts_with(r#"{"kind":"network","method":"POST""#));
}

#[test]
fn load_session_rejects_traversal_and_missing_files() {
    let (_dir, library) = library();
    assert!(
        library
            .load_session("../etc")
            .unwrap_err()
            .to_string()
            .contains("path traversal")
    );
    assert!(library.load_session("jl_missing").is_err());
}

#[test]
fn save_review_state_keeps_steps_and_writes_notes() {
    let (_dir, library) = library();
    write_session(
        &library.output_dir(),
        "jl_runner_session",
        "runner-v4.json",
        Some("recording.webm"),
    );
    let group = Annotation::MergeGroup(MergeGroup::new(
        "merge-new",
        vec![
            "jl_runner_fixture:actions:000001".into(),
            "jl_runner_fixture:actions:000002".into(),
        ],
        "Open and log out",
        "2026-10-03T08:00:09.000Z",
    ));

    let archive = library
        .save_review_state("jl_runner_session", "  Looks right  ", &[group])
        .unwrap();
    let ids: Vec<_> = archive.annotations.iter().map(Annotation::id).collect();
    assert_eq!(ids, ["step-1", "step-2", "merge-new"]);
    assert_eq!(archive.notes, ["Looks right"]);
    assert_eq!(
        library.notes("jl_runner_session").unwrap(),
        "  Looks right  "
    );

    let on_disk = std::fs::read_to_string(
        library
            .output_dir()
            .join("jl_runner_session/session.archive.json"),
    )
    .unwrap();
    assert_eq!(parse_archive(on_disk.as_bytes()).unwrap(), archive);
    assert!(on_disk.ends_with("}\n"));
}

#[test]
fn rename_updates_archive_name() {
    let (_dir, library) = library();
    write_session(
        &library.output_dir(),
        "jl_ext_session",
        "extension-v5.json",
        Some("recording.webm"),
    );
    assert!(library.rename_session("jl_ext_session", "   ").is_err());
    let archive = library
        .rename_session("jl_ext_session", "  Login 401  ")
        .unwrap();
    assert_eq!(archive.name, "Login 401");
    assert_eq!(library.list_sessions().unwrap()[0].name, "Login 401");
}

#[test]
fn delete_session_removes_folder_and_rows() {
    let (_dir, library) = library();
    let out = library.output_dir();
    write_session(
        &out,
        "jl_ext_session",
        "extension-v5.json",
        Some("recording.webm"),
    );
    library.add_tag("jl_ext_session", "x").unwrap();
    library
        .record_artifact_write(
            "jl_ext_session",
            "recording.webm",
            &out.join("jl_ext_session/recording.webm"),
            4,
        )
        .unwrap();

    assert!(library.delete_session("..").is_err());
    assert!(library.delete_session(".").is_err());
    assert!(library.delete_session("a/b").is_err());
    library.delete_session("jl_ext_session").unwrap();
    assert!(!out.join("jl_ext_session").exists());
    assert!(library.tags("jl_ext_session").unwrap().is_empty());
    assert!(library.recent_artifact_writes(10).unwrap().is_empty());
    // Deleting again is not an error, like `rm -f`.
    library.delete_session("jl_ext_session").unwrap();
}

#[test]
fn artifact_writes_are_recorded() {
    let (_dir, library) = library();
    let path = library.output_dir().join("jl_x/session.archive.json");
    let write = library
        .record_artifact_write("jl_x", "session.archive.json", &path, 42)
        .unwrap();
    assert!(write.id.starts_with("jl_x:session.archive.json:"));
    let recent = library.recent_artifact_writes(5).unwrap();
    assert_eq!(recent, [write]);
    let folder: String = library
        .conn
        .lock()
        .query_row("SELECT session_folder FROM session_writes", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(Path::new(&folder), library.output_dir().join("jl_x"));
}

#[test]
fn load_folder_reads_ad_hoc_folders() {
    let dir = tempfile::tempdir().unwrap();
    write_session(
        dir.path(),
        "jl_loose_folder",
        "runner-v4.json",
        Some("recording.mp4"),
    );
    let loaded = load_folder(dir.path().join("jl_loose_folder")).unwrap();
    assert_eq!(loaded.source, SessionSource::Local);
    assert_eq!(loaded.video_mime, "video/mp4");
    assert!(load_folder(dir.path()).is_err());
}

#[test]
fn opens_a_database_the_electron_app_created() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("sessions.db");
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(schema::SCHEMA).unwrap();
        conn.execute("INSERT INTO session_tags VALUES ('jl_old', 'legacy')", [])
            .unwrap();
    }
    let library = Library::open(&db, dir.path()).unwrap();
    assert_eq!(library.tags("jl_old").unwrap(), ["legacy"]);
}
