use std::time::Duration;

use crossbeam_channel::Receiver;

use super::*;
use crate::config::ConfigSource;
use crate::test_support::fixture;

const EXTENSION: &str = "chrome-extension://abcdefghijklmnop";

struct Harness {
    _dir: tempfile::TempDir,
    library: Library,
    handle: CompanionHandle,
    events: Receiver<CompanionEvent>,
    agent: ureq::Agent,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        let library = Library::open(dir.path().join("sessions.db"), &out).unwrap();
        let (tx, events) = crossbeam_channel::unbounded();
        let config = ResolvedConfig {
            config_file_path: dir.path().join("companion.json"),
            auto_sync_to_cloud: true,
            default_output_dir: out.clone(),
            env_override_active: false,
            output_dir: out,
            saved_output_dir: None,
            source: ConfigSource::Default,
        };
        let options = CompanionOptions {
            addr: "127.0.0.1:0".parse().unwrap(),
            config,
        };
        let handle = start_with(library.clone(), tx, options).unwrap();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let harness = Self {
            _dir: dir,
            library,
            handle,
            events,
            agent,
        };
        assert!(matches!(
            harness.next_event(),
            CompanionEvent::Listening { .. }
        ));
        harness
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.handle.addr())
    }

    fn next_event(&self) -> CompanionEvent {
        self.events
            .recv_timeout(Duration::from_secs(5))
            .expect("companion event")
    }

    fn put(&self, path: &str, origin: Option<&str>, body: &[u8]) -> (u16, serde_json::Value) {
        let mut request = self.agent.put(self.url(path));
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let mut response = request.send(body).unwrap();
        let status = response.status().as_u16();
        (
            status,
            serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap(),
        )
    }
}

#[test]
fn health_and_config() {
    let h = Harness::new();
    let mut response = h
        .agent
        .get(h.url("/health"))
        .header("origin", EXTENSION)
        .call()
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["access-control-allow-origin"], EXTENSION);
    assert_eq!(response.headers()["vary"], "Origin");
    assert_eq!(response.headers()["content-type"], "application/json");
    let text = response.body_mut().read_to_string().unwrap();
    assert!(text.ends_with("}\n"));
    let body: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["origin"], "http://127.0.0.1:48115");
    assert_eq!(body["outputDir"], h.library.output_dir().to_str().unwrap());

    h.library.set_output_dir("/tmp/elsewhere");
    let mut response = h.agent.get(h.url("/config?x=1")).call().unwrap();
    assert!(
        response
            .headers()
            .get("access-control-allow-origin")
            .is_none()
    );
    let body: serde_json::Value =
        serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap();
    assert_eq!(body["outputDir"], "/tmp/elsewhere");
    assert_eq!(body["source"], "default");
}

#[test]
fn preflight_requires_extension_origin() {
    let h = Harness::new();
    let response = h
        .agent
        .options(h.url("/api/sessions/jl_abc/recording.webm"))
        .call()
        .unwrap();
    assert_eq!(response.status(), 403);
    let response = h
        .agent
        .options(h.url("/health"))
        .header("origin", "https://evil.example")
        .call()
        .unwrap();
    assert_eq!(response.status(), 403);

    let response = h
        .agent
        .options(h.url("/api/sessions/jl_abc/recording.webm"))
        .header("origin", EXTENSION)
        .header("access-control-request-private-network", "true")
        .call()
        .unwrap();
    assert_eq!(response.status(), 204);
    let headers = response.headers();
    assert_eq!(headers["access-control-allow-origin"], EXTENSION);
    assert_eq!(headers["access-control-allow-methods"], "GET,PUT,POST,OPTIONS");
    assert_eq!(headers["access-control-allow-headers"], "content-type");
    assert_eq!(headers["access-control-allow-private-network"], "true");
}

#[test]
fn uploads_write_artifacts_and_report_ready_sessions() {
    let h = Harness::new();
    let (status, body) = h.put(
        "/api/sessions/jl_upload_1/recording.webm",
        Some("https://evil.example"),
        b"x",
    );
    assert_eq!(
        (status, body["error"].as_str()),
        (403, Some("Forbidden origin"))
    );
    let (status, _) = h.put("/api/sessions/jl_upload_1/recording.webm", None, b"x");
    assert_eq!(status, 403);

    let video = vec![7u8; 256 * 1024];
    let (status, body) = h.put(
        "/api/sessions/jl_upload_1/recording.webm",
        Some(EXTENSION),
        &video,
    );
    assert_eq!(status, 200, "{body}");
    let video_path = h.library.output_dir().join("jl_upload_1/recording.webm");
    assert_eq!(body["destinationPath"], video_path.to_str().unwrap());
    assert_eq!(std::fs::read(&video_path).unwrap(), video);
    assert_eq!(
        h.next_event(),
        CompanionEvent::ArtifactWritten {
            session_id: "jl_upload_1".into(),
            artifact: ArtifactName::RecordingWebm,
            path: video_path,
            bytes: video.len() as u64
        }
    );
    assert!(
        h.events.try_recv().is_err(),
        "not ready before the archive arrives"
    );

    let archive = fixture("extension-v5.json");
    let (status, _) = h.put(
        "/api/sessions/jl_upload_1/session.archive.json",
        Some(EXTENSION),
        archive.as_bytes(),
    );
    assert_eq!(status, 200);
    assert!(matches!(
        h.next_event(),
        CompanionEvent::ArtifactWritten {
            artifact: ArtifactName::SessionArchiveJson,
            ..
        }
    ));
    assert_eq!(
        h.next_event(),
        CompanionEvent::SessionReady {
            session_id: "jl_upload_1".into()
        }
    );

    let writes = h.library.recent_artifact_writes(10).unwrap();
    assert_eq!(writes.len(), 2);
    assert_eq!(h.library.list_sessions().unwrap().len(), 1);
    assert!(
        !h.library
            .output_dir()
            .join("jl_upload_1/recording.part")
            .exists()
    );
}

#[test]
fn rejects_bad_paths() {
    let h = Harness::new();
    let (status, body) = h.put(
        "/api/sessions/bad%2F..%2Fid/recording.webm",
        Some(EXTENSION),
        b"x",
    );
    assert_eq!(status, 500);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("Invalid session id")
    );
    let (status, _) = h.put("/api/sessions/jl_abc/other.bin", Some(EXTENSION), b"x");
    assert_eq!(status, 404);
    // `..` passes the id pattern but resolves outside the output dir.
    let (status, body) = h.put("/api/sessions/../recording.webm", Some(EXTENSION), b"x");
    assert_ne!(status, 200, "{body}");
    assert!(
        !h.library
            .output_dir()
            .parent()
            .unwrap()
            .join("recording.webm")
            .exists()
    );
    let response = h.agent.get(h.url("/nope")).call().unwrap();
    assert_eq!(response.status(), 404);
}

#[test]
fn port_in_use_is_an_error_event() {
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("sessions.db"), dir.path()).unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let options = CompanionOptions {
        addr: taken.local_addr().unwrap(),
        config: config::load_from(&dir.path().join("c.json"), None),
    };
    assert!(start_with(library, tx, options).is_err());
    assert!(matches!(
        rx.try_recv().unwrap(),
        CompanionEvent::Error { .. }
    ));
}

#[test]
fn extension_can_ask_the_app_to_open() {
    let h = Harness::new();
    let health: serde_json::Value = serde_json::from_str(&h.agent.get(h.url("/health")).call().unwrap().body_mut().read_to_string().unwrap()).unwrap();
    assert_eq!(health["capabilities"], serde_json::json!(["open"]));

    let denied = h.agent.post(h.url("/api/open")).header("origin", "https://evil.example").send_empty().unwrap();
    assert_eq!(denied.status(), 403);

    let ok = h.agent.post(h.url("/api/open?session=jl_abc12345")).header("origin", EXTENSION).send_empty().unwrap();
    assert_eq!(ok.status(), 200);
    assert_eq!(h.next_event(), CompanionEvent::OpenRequested { session_id: Some("jl_abc12345".into()) });

    // An id that isn't a safe session id opens the library instead of being passed along.
    h.agent.post(h.url("/api/open?session=..%2Fx")).header("origin", EXTENSION).send_empty().unwrap();
    assert_eq!(h.next_event(), CompanionEvent::OpenRequested { session_id: None });
}
