//! The companion HTTP server the extension uploads to (port of `companion/server.ts`).

use std::io::{self, Read};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use anyhow::{Context as _, Result, anyhow};
use crossbeam_channel::Sender;
use parking_lot::RwLock;
use serde_json::json;
use tiny_http::{Header, Method, Request, Response, Server};

use crate::config::{self, COMPANION_ORIGIN, COMPANION_PORT, ResolvedConfig, is_trusted_origin};
use crate::library::{Library, find_video};

const WORKERS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArtifactName {
    RecordingWebm,
    SessionArchiveJson,
}

impl ArtifactName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RecordingWebm => crate::RECORDING_WEBM_FILE,
            Self::SessionArchiveJson => crate::SESSION_ARCHIVE_FILE,
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            crate::RECORDING_WEBM_FILE => Some(Self::RecordingWebm),
            crate::SESSION_ARCHIVE_FILE => Some(Self::SessionArchiveJson),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompanionEvent {
    Listening {
        addr: SocketAddr,
    },
    ArtifactWritten {
        session_id: String,
        artifact: ArtifactName,
        path: PathBuf,
        bytes: u64,
    },
    /// The session folder now holds both the archive and a recording.
    SessionReady {
        session_id: String,
    },
    /// The extension asked the app to come forward: its library, or one recording in it.
    OpenRequested {
        session_id: Option<String>,
    },
    Error {
        message: String,
    },
}

pub struct CompanionOptions {
    pub addr: SocketAddr,
    /// Served by `GET /config`; `outputDir` always reflects the library.
    pub config: ResolvedConfig,
}

impl Default for CompanionOptions {
    fn default() -> Self {
        Self {
            addr: SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, COMPANION_PORT)),
            config: config::load(),
        }
    }
}

pub struct CompanionHandle {
    addr: SocketAddr,
    server: Arc<Server>,
    config: Arc<RwLock<ResolvedConfig>>,
    stopping: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
}

impl CompanionHandle {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn set_config(&self, config: ResolvedConfig) {
        *self.config.write() = config;
    }

    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        for _ in &self.workers {
            self.server.unblock();
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Drop for CompanionHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Listens on `127.0.0.1:48115`. A bind failure (port in use) is sent as an `Error` event too.
pub fn start(library: Library, events: Sender<CompanionEvent>) -> Result<CompanionHandle> {
    start_with(library, events, CompanionOptions::default())
}

pub fn start_with(
    library: Library,
    events: Sender<CompanionEvent>,
    options: CompanionOptions,
) -> Result<CompanionHandle> {
    let server = match Server::http(options.addr) {
        Ok(server) => Arc::new(server),
        Err(error) => {
            let message = format!(
                "Companion server could not listen on {}: {error}",
                options.addr
            );
            let _ = events.send(CompanionEvent::Error {
                message: message.clone(),
            });
            return Err(anyhow!(message));
        }
    };
    let addr = server.server_addr().to_ip().unwrap_or(options.addr);
    let config = Arc::new(RwLock::new(options.config));
    let stopping = Arc::new(AtomicBool::new(false));

    let workers = (0..WORKERS)
        .map(|index| {
            let ctx = Context {
                library: library.clone(),
                events: events.clone(),
                config: config.clone(),
            };
            let server = server.clone();
            let stopping = stopping.clone();
            std::thread::Builder::new()
                .name(format!("jl-companion-{index}"))
                .spawn(move || {
                    while !stopping.load(Ordering::SeqCst) {
                        match server.recv() {
                            Ok(request) => ctx.handle(request),
                            Err(error) if !stopping.load(Ordering::SeqCst) => {
                                let _ = ctx.events.send(CompanionEvent::Error {
                                    message: error.to_string(),
                                });
                            }
                            Err(_) => break,
                        }
                    }
                })
                .context("Spawning companion worker")
        })
        .collect::<Result<Vec<_>>>()?;

    log::info!("jittle-lamp companion listening on http://{addr}");
    let _ = events.send(CompanionEvent::Listening { addr });
    Ok(CompanionHandle {
        addr,
        server,
        config,
        stopping,
        workers,
    })
}

struct Context {
    library: Library,
    events: Sender<CompanionEvent>,
    config: Arc<RwLock<ResolvedConfig>>,
}

impl Context {
    fn handle(&self, mut request: Request) {
        let origin = header(&request, "origin");
        let response = match self.route(&mut request, origin.as_deref()) {
            Ok(response) => response,
            Err(error) => json_response(
                500,
                &json!({ "ok": false, "error": format!("{error:#}") }),
                origin.as_deref(),
            ),
        };
        if let Err(error) = request.respond(response) {
            log::debug!("Companion response failed: {error}");
        }
    }

    fn route(
        &self,
        request: &mut Request,
        origin: Option<&str>,
    ) -> Result<Response<io::Cursor<Vec<u8>>>> {
        let path = request
            .url()
            .split('?')
            .next()
            .unwrap_or_default()
            .to_owned();
        let method = request.method().clone();

        if method == Method::Options {
            let Some(origin) = origin.filter(|origin| is_trusted_origin(Some(origin))) else {
                return Ok(Response::from_data(Vec::new()).with_status_code(403));
            };
            let private_network = header(request, "access-control-request-private-network")
                .as_deref()
                == Some("true");
            let mut response = Response::from_data(Vec::new()).with_status_code(204);
            for header in cors_headers(Some(origin), private_network) {
                response.add_header(header);
            }
            return Ok(response);
        }

        if method == Method::Get && path == "/health" {
            // `capabilities` lets the extension offer "Open in Jittle Lamp" only to apps that can.
            let body = json!({ "ok": true, "outputDir": self.library.output_dir(), "origin": COMPANION_ORIGIN, "capabilities": ["open"] });
            return Ok(json_response(200, &body, origin));
        }

        if method == Method::Get && path == "/config" {
            let mut config = self.config.read().clone();
            config.output_dir = self.library.output_dir();
            return Ok(json_response(200, &serde_json::to_value(config)?, origin));
        }

        if method == Method::Post && path == "/api/open" {
            if !is_trusted_origin(origin) {
                return Ok(json_response(403, &json!({ "ok": false, "error": "Forbidden origin" }), origin));
            }
            let session_id = request
                .url()
                .split_once('?')
                .and_then(|(_, query)| query.split('&').find_map(|kv| kv.strip_prefix("session=")))
                .filter(|id| crate::paths::is_valid_session_id(id))
                .map(str::to_owned);
            let _ = self.events.send(CompanionEvent::OpenRequested { session_id });
            return Ok(json_response(200, &json!({ "ok": true }), origin));
        }

        if method == Method::Put
            && let Some((session_id, artifact)) = parse_artifact_path(&path)
        {
            if !is_trusted_origin(origin) {
                return Ok(json_response(
                    403,
                    &json!({ "ok": false, "error": "Forbidden origin" }),
                    origin,
                ));
            }
            let destination = self.write_artifact(&session_id, artifact, request.as_reader())?;
            return Ok(json_response(
                200,
                &json!({ "ok": true, "destinationPath": destination }),
                origin,
            ));
        }

        Ok(json_response(
            404,
            &json!({ "ok": false, "error": "Not found" }),
            origin,
        ))
    }

    fn write_artifact(
        &self,
        session_id: &str,
        artifact: ArtifactName,
        body: &mut dyn Read,
    ) -> Result<PathBuf> {
        let destination = config::artifact_destination(
            &self.library.output_dir(),
            session_id,
            artifact.as_str(),
        )?;
        let folder = destination
            .parent()
            .context("Artifact path has no folder")?;
        std::fs::create_dir_all(folder)
            .with_context(|| format!("Creating {}", folder.display()))?;

        let partial = destination.with_extension("part");
        let bytes = (|| -> io::Result<u64> {
            let mut file = std::fs::File::create(&partial)?;
            let bytes = io::copy(body, &mut file)?;
            file.sync_all()?;
            std::fs::rename(&partial, &destination)?;
            Ok(bytes)
        })();
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = std::fs::remove_file(&partial);
                return Err(error).with_context(|| format!("Writing {}", destination.display()));
            }
        };

        self.library
            .record_artifact_write(session_id, artifact.as_str(), &destination, bytes)?;
        let _ = self.events.send(CompanionEvent::ArtifactWritten {
            session_id: session_id.to_owned(),
            artifact,
            path: destination.clone(),
            bytes,
        });
        if is_session_complete(folder) {
            let _ = self.events.send(CompanionEvent::SessionReady {
                session_id: session_id.to_owned(),
            });
        }
        Ok(destination)
    }
}

/// `^/api/sessions/([^/]+)/(recording\.webm|session\.archive\.json)$` on the raw (encoded) path.
fn parse_artifact_path(path: &str) -> Option<(String, ArtifactName)> {
    let rest = path.strip_prefix("/api/sessions/")?;
    let (session_id, artifact) = rest.split_once('/')?;
    if session_id.is_empty() || artifact.contains('/') {
        return None;
    }
    Some((session_id.to_owned(), ArtifactName::parse(artifact)?))
}

fn is_session_complete(folder: &Path) -> bool {
    folder.join(crate::SESSION_ARCHIVE_FILE).is_file() && find_video(folder).is_some()
}

fn header(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_owned())
}

fn cors_headers(origin: Option<&str>, private_network: bool) -> Vec<Header> {
    let mut headers = vec![
        make_header("access-control-allow-methods", "GET,PUT,POST,OPTIONS"),
        make_header("access-control-allow-headers", "content-type"),
    ];
    if let Some(origin) = origin.filter(|origin| is_trusted_origin(Some(origin))) {
        headers.push(make_header("access-control-allow-origin", origin));
        headers.push(make_header("vary", "Origin"));
    }
    if private_network {
        headers.push(make_header("access-control-allow-private-network", "true"));
    }
    headers
}

fn json_response(
    status: u16,
    payload: &serde_json::Value,
    origin: Option<&str>,
) -> Response<io::Cursor<Vec<u8>>> {
    let mut body = serde_json::to_string_pretty(payload).unwrap_or_else(|_| "{}".into());
    body.push('\n');
    let mut response = Response::from_data(body.into_bytes()).with_status_code(status);
    for header in cors_headers(origin, false) {
        response.add_header(header);
    }
    response.add_header(make_header("content-type", "application/json"));
    response
}

fn make_header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

#[cfg(test)]
mod tests;

