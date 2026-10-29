use std::sync::RwLock;
use std::time::Duration;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use ureq::Agent;
use ureq::http::{Request, Response};

use crate::auth::Session;
use crate::config::ApiConfig;
use crate::error::ApiError;

/// JSON calls give up after this long; uploads and downloads have no overall deadline.
pub(crate) const JSON_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_JSON_BYTES: u64 = 32 * 1024 * 1024;

/// What `encodeURIComponent` leaves alone: ALPHA DIGIT - _ . ! ~ * ' ( )
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// Percent-encodes one path segment exactly like JavaScript's `encodeURIComponent`.
pub fn encode_component(value: &str) -> String {
    utf8_percent_encode(value, COMPONENT).to_string()
}

/// `URLSearchParams`-style query string (`?a=1&b=x+y`), or empty when there are no pairs.
pub(crate) fn query_string<'a>(
    pairs: impl IntoIterator<Item = (&'a str, Option<String>)>,
) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    let mut any = false;
    for (key, value) in pairs {
        if let Some(value) = value {
            serializer.append_pair(key, &value);
            any = true;
        }
    }
    if any {
        format!("?{}", serializer.finish())
    } else {
        String::new()
    }
}

/// Blocking client for the Jittle Lamp backend. `Send + Sync`; share it behind an `Arc` and call
/// it from background threads. The signed-in [`Session`] is held inside and sent as a bearer token.
pub struct ApiClient {
    pub(crate) config: ApiConfig,
    pub(crate) agent: Agent,
    session: RwLock<Option<Session>>,
}

impl std::fmt::Debug for ApiClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiClient")
            .field("config", &self.config)
            .field("signed_in", &self.session().is_some())
            .finish()
    }
}

impl ApiClient {
    pub fn new(config: ApiConfig) -> Self {
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            // Signed artifact URLs and the API never redirect; following one could leak to another host.
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(120)))
            .user_agent(concat!("jittle-lamp-desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent();
        Self {
            config,
            agent,
            session: RwLock::new(None),
        }
    }

    pub fn config(&self) -> &ApiConfig {
        &self.config
    }

    pub fn session(&self) -> Option<Session> {
        self.session
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    pub fn set_session(&self, session: Option<Session>) {
        *self
            .session
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = session;
    }

    pub fn is_signed_in(&self) -> bool {
        self.session().is_some_and(|session| !session.is_expired())
    }

    pub(crate) fn token(&self) -> Result<String, ApiError> {
        match self.session() {
            Some(session) if !session.is_expired() => Ok(session.access_token),
            Some(_) => Err(ApiError::Unauthorized {
                message: "Your session expired. Sign in again.".into(),
            }),
            None => Err(ApiError::signed_out()),
        }
    }

    pub(crate) fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, ApiError> {
        self.call("GET", path, None::<&()>, true)
    }

    pub(crate) fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<&impl Serialize>,
    ) -> Result<T, ApiError> {
        self.call("POST", path, body, true)
    }

    /// One authenticated (or anonymous) JSON request against the API origin.
    pub(crate) fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<&impl Serialize>,
        authenticated: bool,
    ) -> Result<T, ApiError> {
        let mut builder = Request::builder()
            .method(method)
            .uri(self.config.api_url(path))
            .header("accept", "application/json");
        if authenticated {
            builder = builder.header("authorization", format!("Bearer {}", self.token()?));
        }
        let payload = match body {
            Some(body) => {
                builder = builder.header("content-type", "application/json");
                serde_json::to_vec(body).map_err(|error| ApiError::Invalid(error.to_string()))?
            }
            None => Vec::new(),
        };
        let request = builder
            .body(payload)
            .map_err(|error| ApiError::Invalid(error.to_string()))?;
        let request = self
            .agent
            .configure_request(request)
            .timeout_global(Some(JSON_TIMEOUT))
            .build();
        log::debug!("{method} {}", loggable_path(path));
        let response = self.agent.run(request)?;
        read_json(response, path)
    }
}

pub(crate) fn read_json<T: DeserializeOwned>(
    response: Response<ureq::Body>,
    what: &str,
) -> Result<T, ApiError> {
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .with_config()
        .limit(MAX_JSON_BYTES)
        .read_to_vec()?;
    if !(200..300).contains(&status) {
        return Err(ApiError::from_response(status, &bytes, "Request failed"));
    }
    let bytes: &[u8] = if status == 204 || bytes.is_empty() {
        b"null"
    } else {
        &bytes
    };
    serde_json::from_slice(bytes)
        .map_err(|error| ApiError::contract(&format!("response from {}", strip_query(what)), error))
}

pub(crate) fn error_for(response: Response<ureq::Body>, fallback: &str) -> ApiError {
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .with_config()
        .limit(64 * 1024)
        .read_to_vec()
        .unwrap_or_default();
    ApiError::from_response(status, &bytes, fallback)
}

/// The poll path carries the device code, which is as good as a token until it is exchanged.
fn loggable_path(path: &str) -> &str {
    if path.starts_with("/desktop-auth/flows/") {
        "/desktop-auth/flows/<device code>"
    } else {
        strip_query(path)
    }
}

fn strip_query(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_component("abc-_.!~*'()"), "abc-_.!~*'()");
        assert_eq!(
            encode_component("a b/c?d&e=f#g"),
            "a%20b%2Fc%3Fd%26e%3Df%23g"
        );
        assert_eq!(encode_component("é"), "%C3%A9");
    }

    #[test]
    fn builds_query_strings() {
        assert_eq!(query_string([("orgId", None)]), "");
        assert_eq!(
            query_string([
                ("orgId", Some("org 1".into())),
                ("page", None),
                ("limit", Some("24".into()))
            ]),
            "?orgId=org+1&limit=24"
        );
    }
}
