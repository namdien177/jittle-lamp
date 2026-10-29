use serde::Deserialize;

/// Errors from the backend client. `Send + Sync + 'static`, so `?` converts it into
/// `anyhow::Error`; the app can recover it with `err.downcast_ref::<ApiError>()` or use
/// [`is_unauthorized`] to decide whether to prompt for sign-in again.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// No session, an expired session, or a 401 from the backend.
    #[error("{message}")]
    Unauthorized { message: String },
    /// A non-2xx response. `message` is the backend's `{ error: { message } }` when present.
    #[error("{message}")]
    Api {
        status: u16,
        code: Option<String>,
        message: String,
    },
    /// The response did not match the expected shape.
    #[error("The backend returned an unexpected {what}: {detail}")]
    Contract { what: String, detail: String },
    /// Connection, TLS, timeout or redirect failures.
    #[error("Network error: {0}")]
    Transport(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Rejected on the client before any request (bad ID, unsafe URL, missing file, size cap).
    #[error("{0}")]
    Invalid(String),
    #[error("Keychain error: {0}")]
    Keychain(String),
}

impl ApiError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, ApiError::Unauthorized { .. })
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            ApiError::Unauthorized { .. } => Some(401),
            ApiError::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            ApiError::Api { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    pub(crate) fn signed_out() -> Self {
        ApiError::Unauthorized {
            message: "Sign in to continue.".into(),
        }
    }

    pub(crate) fn contract(what: &str, error: impl std::fmt::Display) -> Self {
        ApiError::Contract {
            what: what.into(),
            detail: error.to_string(),
        }
    }

    /// Builds the error for a failed response from its status and (possibly empty) body.
    pub(crate) fn from_response(status: u16, body: &[u8], fallback: &str) -> Self {
        let parsed = serde_json::from_slice::<ErrorEnvelope>(body).ok();
        let code = parsed
            .as_ref()
            .and_then(|envelope| envelope.error.code.clone());
        let message = parsed
            .and_then(|envelope| envelope.error.message)
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| format!("{fallback} ({status})."));
        if status == 401 {
            ApiError::Unauthorized { message }
        } else {
            ApiError::Api {
                status,
                code,
                message,
            }
        }
    }
}

impl From<ureq::Error> for ApiError {
    fn from(error: ureq::Error) -> Self {
        match error {
            ureq::Error::Io(io) => ApiError::Transport(io.to_string()),
            other => ApiError::Transport(other.to_string()),
        }
    }
}

/// True when `error` (or anything it wraps) is [`ApiError::Unauthorized`].
pub fn is_unauthorized(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<ApiError>()
            .is_some_and(ApiError::is_unauthorized)
    })
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorDetail,
}

#[derive(Deserialize)]
struct ErrorDetail {
    message: Option<String>,
    code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surfaces_backend_error_message_and_code() {
        let body = br#"{"error":{"code":"ORG_MEMBERSHIP_REQUIRED","message":"Selected organization must be a member organization","status":403,"requestId":"req_1"}}"#;
        let error = ApiError::from_response(403, body, "Request failed");
        assert_eq!(
            error.to_string(),
            "Selected organization must be a member organization"
        );
        assert_eq!(error.code(), Some("ORG_MEMBERSHIP_REQUIRED"));
        assert_eq!(error.status(), Some(403));
        assert!(!error.is_unauthorized());
    }

    #[test]
    fn falls_back_when_body_is_not_an_api_error() {
        let error = ApiError::from_response(502, b"<html>bad gateway</html>", "Request failed");
        assert_eq!(error.to_string(), "Request failed (502).");
    }

    #[test]
    fn distinguishes_401() {
        let body = br#"{"error":{"code":"UNAUTHORIZED","message":"Session expired","status":401,"requestId":null}}"#;
        let error = ApiError::from_response(401, body, "Request failed");
        assert!(error.is_unauthorized());
        assert_eq!(error.to_string(), "Session expired");
        let wrapped = anyhow::Error::from(error).context("Loading organisations");
        assert!(is_unauthorized(&wrapped));
        assert!(!is_unauthorized(&anyhow::anyhow!("other")));
    }
}
