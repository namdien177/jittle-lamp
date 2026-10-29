// End-to-end checks against a tiny local server standing in for the backend.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jl_api::sync::checksum_bytes;
use jl_api::{
    ApiClient, ApiConfig, ApiError, PollOutcome, Session, SessionStore, SyncInput, SyncPhase,
};

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

struct Reply {
    status: u16,
    body: Vec<u8>,
    content_type: &'static str,
}

fn json(status: u16, value: serde_json::Value) -> Reply {
    Reply {
        status,
        body: value.to_string().into_bytes(),
        content_type: "application/json",
    }
}

struct Mock {
    origin: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Mock {
    fn start(handler: impl Fn(&Seen, &str) -> Reply + Send + 'static) -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!(
            "http://127.0.0.1:{}",
            server.server_addr().to_ip().unwrap().port()
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (thread_origin, thread_seen) = (origin.clone(), seen.clone());
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut body = Vec::new();
                request.as_reader().read_to_end(&mut body).unwrap();
                let entry = Seen {
                    method: request.method().to_string(),
                    url: request.url().to_string(),
                    headers: request
                        .headers()
                        .iter()
                        .map(|header| (header.field.to_string(), header.value.to_string()))
                        .collect(),
                    body,
                };
                let reply = handler(&entry, &thread_origin);
                thread_seen.lock().unwrap().push(entry);
                let content_type =
                    tiny_http::Header::from_bytes("content-type", reply.content_type).unwrap();
                let _ = request.respond(
                    tiny_http::Response::from_data(reply.body)
                        .with_status_code(reply.status)
                        .with_header(content_type),
                );
            }
        });
        Self { origin, seen }
    }

    fn client(&self) -> ApiClient {
        ApiClient::new(ApiConfig::new(&self.origin, "http://127.0.0.1:4173"))
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn session() -> Session {
    Session {
        access_token: "tok_live".into(),
        expires_at: i64::MAX / 2,
        clerk_user_id: "user_1".into(),
    }
}

#[test]
fn device_flow_then_authenticated_profile() {
    let polls = AtomicUsize::new(0);
    let mock = Mock::start(
        move |seen, _| match (seen.method.as_str(), seen.url.as_str()) {
            ("POST", "/desktop-auth/flows") => json(
                200,
                serde_json::json!({"ok": true, "deviceCode": "dev/code", "userCode": "WXYZ-1234",
                "verificationUri": "http://127.0.0.1:4173/desktop-auth", "verificationUriComplete": "http://127.0.0.1:4173/desktop-auth?code=WXYZ-1234",
                "expiresAt": 1, "expiresInSeconds": 600, "intervalSeconds": 2}),
            ),
            ("GET", "/desktop-auth/flows/dev%2Fcode") => {
                if polls.fetch_add(1, Ordering::SeqCst) == 0 {
                    json(
                        200,
                        serde_json::json!({"status": "pending", "expiresAt": 1, "intervalSeconds": 5}),
                    )
                } else {
                    json(
                        200,
                        serde_json::json!({"status": "approved", "tokenType": "Bearer", "accessToken": "tok_live",
                        "expiresAt": i64::MAX / 2, "expiresInSeconds": 3600, "clerkUserId": "user_1"}),
                    )
                }
            }
            ("GET", "/protected/me") if seen.header("authorization") == Some("Bearer tok_live") => {
                json(
                    200,
                    serde_json::json!({"userId": "user_1", "localUserId": "u_1", "orgId": "org_1", "activeOrgId": "org_1", "roles": [], "scopes": [],
                "user": {"id": "user_1", "displayName": "Dana Q", "email": null, "imageUrl": null},
                "organizations": [{"id": "org_1", "name": "Acme", "role": "admin", "isPersonal": false, "isActive": true,
                    "migrationAccessState": null, "migrationDestinationWebOrigin": null}]}),
                )
            }
            _ => json(
                401,
                serde_json::json!({"error": {"code": "UNAUTHORIZED", "message": "Sign in required", "status": 401, "requestId": null}}),
            ),
        },
    );
    let client = mock.client();

    // Signed out: no request is made.
    assert!(client.account_profile().unwrap_err().is_unauthorized());
    assert!(mock.seen().is_empty());

    let flow = client.start_device_flow().unwrap();
    assert_eq!(flow.user_code, "WXYZ-1234");
    assert_eq!(flow.interval(), Duration::from_secs(2));
    assert_eq!(
        client.poll_device_flow(&flow.device_code).unwrap(),
        PollOutcome::Pending {
            interval: Duration::from_secs(5)
        }
    );
    let PollOutcome::Approved(approved) = client.poll_device_flow(&flow.device_code).unwrap()
    else {
        panic!("expected approval");
    };
    assert_eq!(approved, session());
    assert!(
        mock.seen()
            .iter()
            .all(|seen| seen.header("authorization").is_none()),
        "flow endpoints are anonymous"
    );

    let store = jl_api::MemorySessionStore::default();
    store.save(&approved).unwrap();
    client.set_session(store.load_fresh().unwrap());
    let profile = client.account_profile().unwrap();
    assert_eq!(profile.display_label(), "Dana Q");

    // A rejected token surfaces as Unauthorized with the backend's message.
    client.set_session(Some(Session {
        access_token: "stale".into(),
        ..session()
    }));
    let error = client.account_profile().unwrap_err();
    assert!(error.is_unauthorized());
    assert_eq!(error.to_string(), "Sign in required");
}

#[test]
fn backend_error_messages_are_surfaced() {
    let mock = Mock::start(|_, _| {
        json(
            403,
            serde_json::json!({"error": {"code": "ORG_MEMBERSHIP_REQUIRED", "message": "Selected organization must be a member organization", "status": 403, "requestId": "r1"}}),
        )
    });
    let client = mock.client();
    client.set_session(Some(session()));
    let error = client.select_active_organization("org 2").unwrap_err();
    assert!(matches!(&error, ApiError::Api { status: 403, .. }));
    assert_eq!(error.code(), Some("ORG_MEMBERSHIP_REQUIRED"));
    assert_eq!(
        error.to_string(),
        "Selected organization must be a member organization"
    );
    assert_eq!(mock.seen()[0].url, "/orgs/org%202/select-active");
}

#[test]
fn sync_session_hashes_starts_uploads_and_completes() {
    let dir = tempfile::tempdir().unwrap();
    let recording: Vec<u8> = (0..700_000u32)
        .map(|value| (value * 7 % 256) as u8)
        .collect();
    let archive = br#"{"schemaVersion":5,"sessionId":"s1","createdAt":"2026-10-29T10:00:00.000Z","updatedAt":"2026-10-29T10:00:03.000Z",
        "summary":{"videoDurationMs":2900,"actionCount":4,"requestCount":9},"sections":{"actions":[],"network":[]}}"#;
    std::fs::write(dir.path().join("recording.mp4"), &recording).unwrap();
    std::fs::write(dir.path().join("session.archive.json"), archive).unwrap();

    let mock = Mock::start(
        |seen, origin| match (seen.method.as_str(), seen.url.as_str()) {
            ("POST", "/evidences/desktop-sessions/sync/start") => {
                let sessions: Vec<_> = seen.json()["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|artifact| {
                    let key = artifact["key"].as_str().unwrap();
                    serde_json::json!({"key": key, "uploadId": format!("up_{key}"), "expiresAt": 1,
                        "uploadUrl": format!("{origin}/evidences/uploads/up_{key}/blob"), "method": "PUT",
                        "headers": {"content-type": artifact["mimeType"]}, "storageKey": format!("uploads/org_1/ev_1/{key}")})
                })
                .collect();
                json(
                    200,
                    serde_json::json!({"evidenceId": "ev_1", "organizationId": "org_1", "uploadSessions": sessions}),
                )
            }
            ("PUT", _) => Reply {
                status: 204,
                body: Vec::new(),
                content_type: "text/plain",
            },
            ("POST", url) if url.ends_with("/complete") => {
                let upload_id = url
                    .trim_start_matches("/evidences/uploads/")
                    .trim_end_matches("/complete");
                json(
                    200,
                    serde_json::json!({"uploadId": upload_id, "evidenceId": "ev_1", "status": "committed"}),
                )
            }
            _ => json(
                404,
                serde_json::json!({"error": {"code": "NOT_FOUND", "message": "nope", "status": 404, "requestId": null}}),
            ),
        },
    );
    let client = mock.client();
    client.set_session(Some(session()));

    let mut input = SyncInput::from_session_folder(dir.path(), "s1", "Checkout bug").unwrap();
    input.thumbnail_jpeg = Some(vec![0xff, 0xd8, 0xff, 0xe0]);
    let events = Mutex::new(Vec::new());
    let result = client
        .sync_session(&input, |progress| events.lock().unwrap().push(progress))
        .unwrap();
    assert_eq!(
        (result.evidence_id.as_str(), result.organization_id.as_str()),
        ("ev_1", "org_1")
    );
    assert!(result.thumbnail_sent);

    let seen = mock.seen();
    let order: Vec<_> = seen
        .iter()
        .map(|seen| format!("{} {}", seen.method, seen.url))
        .collect();
    assert_eq!(
        order,
        [
            "POST /evidences/desktop-sessions/sync/start",
            "PUT /evidences/uploads/up_recording/blob",
            "POST /evidences/uploads/up_recording/complete",
            "PUT /evidences/uploads/up_archive/blob",
            "POST /evidences/uploads/up_archive/complete",
        ]
    );
    assert!(
        seen.iter()
            .all(|seen| seen.header("authorization") == Some("Bearer tok_live"))
    );

    let start = seen[0].json();
    assert_eq!(start["sessionId"], "s1");
    assert_eq!(start["title"], "Checkout bug");
    assert_eq!(start["thumbnailBase64"], "/9j/4A==");
    assert_eq!(start["thumbnailMimeType"], "image/jpeg");
    assert!(start.get("replaceEvidenceId").is_none());
    let recording_checksum = checksum_bytes(&recording);
    assert_eq!(
        start["artifacts"],
        serde_json::json!([
            {"key": "recording", "kind": "recording", "mimeType": "video/mp4", "bytes": 700_000, "checksum": recording_checksum},
            {"key": "archive", "kind": "network-log", "mimeType": "application/json", "bytes": archive.len(), "checksum": checksum_bytes(archive)}
        ])
    );
    let metadata: serde_json::Value =
        serde_json::from_str(start["sourceMetadata"].as_str().unwrap()).unwrap();
    assert_eq!(metadata["localSessionId"], "s1");
    assert_eq!(metadata["artifactFormat"], "split");
    assert_eq!(metadata["durationMs"], 2900);
    assert_eq!(metadata["actionCount"], 4);
    assert_eq!(metadata["requestCount"], 9);
    assert_eq!(metadata["artifacts"], start["artifacts"]);

    let put = &seen[1];
    assert_eq!(put.header("content-type"), Some("video/mp4"));
    assert_eq!(
        put.header("content-length"),
        Some("700000"),
        "uploads are length-delimited, not chunked"
    );
    assert_eq!(checksum_bytes(&put.body), recording_checksum);
    assert_eq!(
        seen[2].json(),
        serde_json::json!({"bytes": 700_000, "checksum": recording_checksum, "mimeType": "video/mp4"})
    );
    assert_eq!(seen[3].body, archive);

    let events = events.into_inner().unwrap();
    assert_eq!(events.first().unwrap().phase, SyncPhase::Hashing);
    assert_eq!(events.last().unwrap().phase, SyncPhase::Done);
    let total = 700_000 + archive.len() as u64;
    let uploads: Vec<_> = events
        .iter()
        .filter(|event| event.phase == SyncPhase::Uploading)
        .collect();
    assert!(
        uploads.len() >= 3,
        "upload progress is reported while streaming: {uploads:?}"
    );
    assert!(
        uploads
            .windows(2)
            .all(|pair| pair[0].bytes_done <= pair[1].bytes_done)
    );
    assert_eq!(uploads.last().unwrap().bytes_done, total);
    assert!(events.iter().all(|event| event.bytes_total == total));
}

#[test]
fn sync_stops_on_quota_error_before_uploading() {
    let mock = Mock::start(|_, _| {
        json(
            429,
            serde_json::json!({"error": {"code": "DAILY_UPLOAD_QUOTA_EXCEEDED", "message": "Daily upload limit reached", "status": 429, "requestId": null}}),
        )
    });
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("recording.webm"), b"webm").unwrap();
    std::fs::write(dir.path().join("session.archive.json"), b"{}").unwrap();
    let client = mock.client();
    client.set_session(Some(session()));
    let input = SyncInput::from_session_folder(dir.path(), "s1", "t").unwrap();
    let error = client.sync_session(&input, |_| {}).unwrap_err();
    assert_eq!(error.to_string(), "Daily upload limit reached");
    assert_eq!(mock.seen().len(), 1);
}

#[test]
fn open_remote_evidence_downloads_archive_then_recording() {
    let archive = br#"{"schemaVersion":5,"sessionId":"s1","sections":{}}"#;
    let mock = Mock::start(move |seen, origin| match seen.url.as_str() {
        "/evidences/ev_1/playback" => json(
            200,
            serde_json::json!({
                "evidence": {"id": "ev_1", "orgId": "o", "title": "Run", "sourceType": "test-run", "sourceExternalId": null, "sourceMetadata": null,
                    "thumbnailBase64": null, "thumbnailMimeType": null, "createdBy": "u", "createdAt": 1, "updatedAt": 1, "status": "ready",
                    "durationMs": null, "actionCount": null, "requestCount": null, "tags": [], "createdByProfile": null},
                "artifacts": [
                    {"id": "a_video", "evidenceId": "ev_1", "kind": "recording", "mimeType": "video/webm", "bytes": 6, "checksum": "c", "uploadStatus": "uploaded", "createdAt": 1, "updatedAt": 1},
                    {"id": "a_archive", "evidenceId": "ev_1", "kind": "network-log", "mimeType": "application/json", "bytes": 3, "checksum": "c", "uploadStatus": "uploaded", "createdAt": 1, "updatedAt": 1}
                ],
                "readUrls": [
                    {"artifactId": "a_video", "url": format!("{origin}/dev-artifacts/video"), "expiresAt": 1, "renewAfterMs": 30000},
                    {"artifactId": "a_archive", "url": format!("{origin}/dev-artifacts/archive"), "expiresAt": 1, "renewAfterMs": 30000}
                ]
            }),
        ),
        "/dev-artifacts/archive" => Reply {
            status: 200,
            body: archive.to_vec(),
            content_type: "application/json",
        },
        "/dev-artifacts/video" => Reply {
            status: 200,
            body: b"VIDEO!".to_vec(),
            content_type: "video/webm",
        },
        _ => json(
            404,
            serde_json::json!({"error": {"code": "NOT_FOUND", "message": "nope", "status": 404, "requestId": null}}),
        ),
    });
    let client = mock.client();
    client.set_session(Some(session()));
    let temp = tempfile::tempdir().unwrap();

    assert!(matches!(
        client.open_remote_evidence("../x", Some(temp.path())),
        Err(ApiError::Invalid(_))
    ));

    let opened = client
        .open_remote_evidence("ev_1", Some(temp.path()))
        .unwrap();
    assert!(
        opened
            .folder
            .starts_with(temp.path().join("jittle-lamp-temp"))
    );
    assert_eq!(std::fs::read(&opened.archive_path).unwrap(), archive);
    assert_eq!(
        opened.archive_path.file_name().unwrap(),
        "session.archive.json"
    );
    assert_eq!(opened.recording_path.file_name().unwrap(), "recording.webm");
    assert_eq!(std::fs::read(&opened.recording_path).unwrap(), b"VIDEO!");
    assert_eq!(opened.evidence.summary.title, "Run");

    let seen = mock.seen();
    let urls: Vec<_> = seen.iter().map(|seen| seen.url.as_str()).collect();
    assert_eq!(
        urls,
        [
            "/evidences/ev_1/playback",
            "/dev-artifacts/archive",
            "/dev-artifacts/video"
        ]
    );
    assert_eq!(seen[0].header("authorization"), Some("Bearer tok_live"));
    assert!(
        seen[1..]
            .iter()
            .all(|seen| seen.header("authorization").is_none()),
        "signed URLs are fetched without credentials"
    );

    opened.remove().unwrap();
    assert!(!opened.folder.exists());
}

#[test]
fn open_remote_evidence_rejects_bad_archive_before_recording() {
    let mock = Mock::start(|seen, origin| match seen.url.as_str() {
        "/evidences/ev_1/playback" => json(
            200,
            serde_json::json!({
                "evidence": {"id": "ev_1", "orgId": "o", "title": "Run", "sourceType": "test-run", "createdBy": "u", "createdAt": 1, "updatedAt": 1},
                "artifacts": [
                    {"id": "v", "evidenceId": "ev_1", "kind": "recording", "mimeType": "video/mp4", "bytes": 1, "checksum": "c", "uploadStatus": "uploaded", "createdAt": 1, "updatedAt": 1},
                    {"id": "a", "evidenceId": "ev_1", "kind": "network-log", "mimeType": "application/json", "bytes": 1, "checksum": "c", "uploadStatus": "uploaded", "createdAt": 1, "updatedAt": 1}
                ],
                "readUrls": [{"artifactId": "v", "url": format!("{origin}/v")}, {"artifactId": "a", "url": format!("{origin}/a")}]
            }),
        ),
        _ => Reply {
            status: 200,
            body: b"<html>".to_vec(),
            content_type: "text/html",
        },
    });
    let client = mock.client();
    client.set_session(Some(session()));
    let temp = tempfile::tempdir().unwrap();
    let error = client
        .open_remote_evidence("ev_1", Some(temp.path()))
        .unwrap_err();
    assert!(
        error.to_string().starts_with("Invalid session archive"),
        "{error}"
    );
    assert_eq!(mock.seen().len(), 2, "the recording is never requested");
    assert!(!temp.path().join("jittle-lamp-temp").exists());
}
