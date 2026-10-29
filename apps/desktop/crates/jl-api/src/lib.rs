//! Blocking HTTP client for the Jittle Lamp backend: browser sign-in with the session in the
//! Keychain, account and organisations, cloud evidence and share links, desktop session sync,
//! downloading cloud evidence for the viewer, and test runs.
//!
//! Every call blocks; [`ApiClient`] is `Send + Sync`, so share it in an `Arc` and call it from
//! background threads. Failures are [`ApiError`]; [`ApiError::Unauthorized`] means the app
//! should ask the user to sign in again.

pub mod account;
pub mod auth;
pub mod config;
pub mod error;
pub mod evidence;
mod http;
pub mod live_run;
pub mod remote;
pub mod sync;
pub mod test_runs;

pub use account::{AccountOrganization, AccountProfile, AccountUser, OrgSummary};
pub use auth::{
    DeviceFlow, KeychainSessionStore, MemorySessionStore, PollOutcome, Session, SessionStore,
};
pub use config::ApiConfig;
pub use error::{ApiError, is_unauthorized};
pub use evidence::{
    ArtifactSummary, CreatedShareLink, EvidencePage, EvidenceQuery, EvidenceStatus,
    EvidenceSummary, EvidenceTag, Playback, ReadUrl, RevokedShareLink, ShareLinkSummary,
};
pub use http::{ApiClient, encode_component};
pub use remote::RemoteEvidence;
pub use sync::{ArtifactKey, SyncFile, SyncInput, SyncPhase, SyncProgress, SyncResult};
pub use test_runs::{TestRunDetail, TestRunPage, TestRunQuery, TestRunStatus, TestRunSummary};

#[cfg(test)]
mod tests {
    #[test]
    fn client_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<super::ApiClient>();
        assert_send_sync::<super::KeychainSessionStore>();
    }
}
