// Browser (device-code) sign-in, ported from apps/desktop/src/mainview/auth-context.tsx:
// POST /desktop-auth/flows starts a flow, the user approves it in the web app, and the app polls
// GET /desktop-auth/flows/:deviceCode until it is approved, expires or is denied. The approved
// session is kept in the macOS Keychain instead of localStorage.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::http::{ApiClient, encode_component};

pub const KEYCHAIN_SERVICE: &str = "dev.jittlelamp.desktop";
pub const KEYCHAIN_ACCOUNT: &str = "desktop-auth.v1";
/// A stored session is reused only while it has at least this long left (auth-context.tsx `isFresh`).
pub const FRESHNESS_MARGIN_MS: i64 = 60_000;

/// A signed-in desktop session. Serialized like the Electron app's stored session.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub access_token: String,
    /// Epoch milliseconds.
    pub expires_at: i64,
    pub clerk_user_id: String,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("access_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("clerk_user_id", &self.clerk_user_id)
            .finish()
    }
}

impl Session {
    /// True while the session has more than a minute left.
    pub fn is_fresh(&self) -> bool {
        self.is_fresh_at(now_ms())
    }

    pub fn is_fresh_at(&self, now_ms: i64) -> bool {
        self.expires_at > now_ms + FRESHNESS_MARGIN_MS
    }

    pub fn is_expired(&self) -> bool {
        self.expires_at <= now_ms()
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// A started browser sign-in. Open `verification_uri_complete` in the browser, show `user_code`,
/// then poll with `device_code` every `interval`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlow {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_at: i64,
    pub expires_in_seconds: u64,
    #[serde(rename = "intervalSeconds")]
    pub interval_seconds: u64,
}

impl DeviceFlow {
    /// Delay before the next poll; never below one second.
    pub fn interval(&self) -> Duration {
        Duration::from_secs(self.interval_seconds.max(1))
    }
}

impl std::fmt::Debug for DeviceFlow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceFlow")
            .field("device_code", &"<redacted>")
            .field("user_code", &self.user_code)
            .field("verification_uri_complete", &self.verification_uri_complete)
            .field("expires_at", &self.expires_at)
            .field("interval_seconds", &self.interval_seconds)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PollOutcome {
    /// Not approved yet; poll again after `interval`.
    Pending {
        interval: Duration,
    },
    Approved(Session),
    /// "The browser sign-in request expired. Start a new sign-in." Also returned for unknown codes.
    Expired,
    /// "The browser sign-in request was denied."
    Denied,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum PollResponse {
    Pending {
        #[serde(rename = "intervalSeconds")]
        interval_seconds: u64,
    },
    Expired,
    Denied,
    Approved {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(rename = "expiresAt")]
        expires_at: i64,
        #[serde(rename = "clerkUserId")]
        clerk_user_id: String,
    },
}

pub(crate) fn parse_poll(value: serde_json::Value) -> Result<PollOutcome, ApiError> {
    let response: PollResponse = serde_json::from_value(value)
        .map_err(|error| ApiError::contract("sign-in status", error))?;
    Ok(match response {
        PollResponse::Pending { interval_seconds } => PollOutcome::Pending {
            interval: Duration::from_secs(interval_seconds.max(1)),
        },
        PollResponse::Expired => PollOutcome::Expired,
        PollResponse::Denied => PollOutcome::Denied,
        PollResponse::Approved {
            access_token,
            expires_at,
            clerk_user_id,
        } => PollOutcome::Approved(Session {
            access_token,
            expires_at,
            clerk_user_id,
        }),
    })
}

impl ApiClient {
    /// POST /desktop-auth/flows (anonymous).
    pub fn start_device_flow(&self) -> Result<DeviceFlow, ApiError> {
        self.call("POST", "/desktop-auth/flows", None::<&()>, false)
            .map_err(|error| relabel(error, "Unable to start browser sign-in"))
    }

    /// GET /desktop-auth/flows/:deviceCode (anonymous). Does not store the session; on
    /// `Approved`, save it with a [`SessionStore`] and pass it to [`ApiClient::set_session`].
    pub fn poll_device_flow(&self, device_code: &str) -> Result<PollOutcome, ApiError> {
        let path = format!("/desktop-auth/flows/{}", encode_component(device_code));
        let value: serde_json::Value = self
            .call("GET", &path, None::<&()>, false)
            .map_err(|error| relabel(error, "Unable to check browser sign-in status"))?;
        parse_poll(value)
    }
}

// The flow endpoints are anonymous, so a 401 there is a server problem, not a stale session.
fn relabel(error: ApiError, fallback: &str) -> ApiError {
    match error {
        ApiError::Unauthorized { message } => ApiError::Api {
            status: 401,
            code: None,
            message,
        },
        ApiError::Contract { detail, .. } => ApiError::Contract {
            what: fallback.to_lowercase(),
            detail,
        },
        other => other,
    }
}

/// Where the desktop session is persisted.
pub trait SessionStore: Send + Sync {
    fn load(&self) -> Result<Option<Session>, ApiError>;
    fn save(&self, session: &Session) -> Result<(), ApiError>;
    fn clear(&self) -> Result<(), ApiError>;

    /// The stored session if it is still fresh; a stale or unreadable entry is cleared.
    fn load_fresh(&self) -> Result<Option<Session>, ApiError> {
        match self.load() {
            Ok(Some(session)) if session.is_fresh() => Ok(Some(session)),
            Ok(None) => Ok(None),
            Ok(Some(_)) | Err(ApiError::Contract { .. }) => {
                self.clear()?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

/// Generic-password item in the login Keychain (service `dev.jittlelamp.desktop`).
#[derive(Clone, Debug)]
pub struct KeychainSessionStore {
    service: String,
    account: String,
}

impl Default for KeychainSessionStore {
    fn default() -> Self {
        Self {
            service: KEYCHAIN_SERVICE.into(),
            account: KEYCHAIN_ACCOUNT.into(),
        }
    }
}

impl KeychainSessionStore {
    pub fn new(service: &str, account: &str) -> Self {
        Self {
            service: service.into(),
            account: account.into(),
        }
    }
}

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

impl SessionStore for KeychainSessionStore {
    fn load(&self) -> Result<Option<Session>, ApiError> {
        match security_framework::passwords::get_generic_password(&self.service, &self.account) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|error| ApiError::contract("stored session", error)),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(ApiError::Keychain(error.to_string())),
        }
    }

    fn save(&self, session: &Session) -> Result<(), ApiError> {
        let bytes =
            serde_json::to_vec(session).map_err(|error| ApiError::Invalid(error.to_string()))?;
        security_framework::passwords::set_generic_password(&self.service, &self.account, &bytes)
            .map_err(|error| ApiError::Keychain(error.to_string()))
    }

    fn clear(&self) -> Result<(), ApiError> {
        match security_framework::passwords::delete_generic_password(&self.service, &self.account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(ApiError::Keychain(error.to_string())),
        }
    }
}

/// In-memory store for tests and previews.
#[derive(Debug, Default)]
pub struct MemorySessionStore(Mutex<Option<Session>>);

impl SessionStore for MemorySessionStore {
    fn load(&self) -> Result<Option<Session>, ApiError> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone())
    }

    fn save(&self, session: &Session) -> Result<(), ApiError> {
        *self.0.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(session.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), ApiError> {
        *self.0.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(expires_at: i64) -> Session {
        Session {
            access_token: "secret-token".into(),
            expires_at,
            clerk_user_id: "user_1".into(),
        }
    }

    #[test]
    fn freshness_uses_a_minute_margin() {
        let now = 1_000_000;
        assert!(session(now + 60_001).is_fresh_at(now));
        assert!(!session(now + 60_000).is_fresh_at(now));
        assert!(!session(now - 1).is_fresh_at(now));
    }

    #[test]
    fn debug_output_never_contains_tokens() {
        let text = format!("{:?}", session(1));
        assert!(!text.contains("secret-token"));
        let flow: DeviceFlow = serde_json::from_str(START_FIXTURE).unwrap();
        assert!(!format!("{flow:?}").contains("dev_code_secret"));
    }

    #[test]
    fn stored_session_round_trips_in_electron_shape() {
        let json = serde_json::to_string(&session(5)).unwrap();
        assert_eq!(
            json,
            r#"{"accessToken":"secret-token","expiresAt":5,"clerkUserId":"user_1"}"#
        );
    }

    const START_FIXTURE: &str = r#"{"ok":true,"deviceCode":"dev_code_secret","userCode":"ABCD-EFGH","verificationUri":"http://127.0.0.1:4173/desktop-auth","verificationUriComplete":"http://127.0.0.1:4173/desktop-auth?code=ABCD-EFGH","expiresAt":1761700000000,"expiresInSeconds":600,"intervalSeconds":0}"#;

    #[test]
    fn parses_start_response() {
        let flow: DeviceFlow = serde_json::from_str(START_FIXTURE).unwrap();
        assert_eq!(flow.user_code, "ABCD-EFGH");
        assert_eq!(flow.expires_in_seconds, 600);
        assert_eq!(flow.interval(), Duration::from_secs(1));
    }

    fn parse_poll(bytes: &[u8]) -> Result<PollOutcome, ApiError> {
        super::parse_poll(serde_json::from_slice(bytes).unwrap())
    }

    #[test]
    fn parses_every_poll_status() {
        assert_eq!(
            parse_poll(br#"{"status":"pending","expiresAt":1,"intervalSeconds":3}"#).unwrap(),
            PollOutcome::Pending {
                interval: Duration::from_secs(3)
            }
        );
        assert_eq!(
            parse_poll(br#"{"status":"expired","expiresAt":1,"intervalSeconds":3}"#).unwrap(),
            PollOutcome::Expired
        );
        assert_eq!(
            parse_poll(br#"{"status":"denied","expiresAt":1,"intervalSeconds":3}"#).unwrap(),
            PollOutcome::Denied
        );
        let approved = parse_poll(
            br#"{"status":"approved","tokenType":"Bearer","accessToken":"tok","expiresAt":99,"expiresInSeconds":10,"clerkUserId":"user_9"}"#,
        )
        .unwrap();
        assert_eq!(
            approved,
            PollOutcome::Approved(Session {
                access_token: "tok".into(),
                expires_at: 99,
                clerk_user_id: "user_9".into()
            })
        );
        assert!(parse_poll(br#"{"status":"weird"}"#).is_err());
    }

    #[test]
    fn load_fresh_clears_stale_sessions() {
        let store = MemorySessionStore::default();
        store.save(&session(now_ms() + 10_000)).unwrap();
        assert_eq!(store.load_fresh().unwrap(), None);
        assert_eq!(store.load().unwrap(), None);
        let fresh = session(now_ms() + 3_600_000);
        store.save(&fresh).unwrap();
        assert_eq!(store.load_fresh().unwrap(), Some(fresh));
    }
}
