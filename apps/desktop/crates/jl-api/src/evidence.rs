// Cloud evidence, artifacts and share links (apps/backend/src/routes/evidence-uploads.ts,
// share-links.ts). Evidence is organisation-scoped: without `org_id` the backend uses the
// session's active organisation.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::http::{ApiClient, encode_component, query_string};

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSummary {
    pub id: String,
    pub org_id: String,
    pub title: String,
    /// `desktop-session`, `manual-upload`, `test-run`, …
    pub source_type: String,
    #[serde(default)]
    pub source_external_id: Option<String>,
    /// JSON string written by the uploader (see `sync::SourceMetadata` for desktop sessions).
    #[serde(default)]
    pub source_metadata: Option<String>,
    #[serde(default)]
    pub thumbnail_base64: Option<String>,
    #[serde(default)]
    pub thumbnail_mime_type: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub status: EvidenceStatus,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    #[serde(default)]
    pub action_count: Option<u64>,
    #[serde(default)]
    pub request_count: Option<u64>,
    #[serde(default)]
    pub tags: Vec<EvidenceTag>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceStatus {
    #[default]
    Ready,
    /// At least one artifact is still uploading.
    Pending,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct EvidenceTag {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// GET /evidences
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePage {
    pub evidences: Vec<EvidenceSummary>,
    pub org_id: String,
    #[serde(default)]
    pub total: u64,
    #[serde(default = "first_page")]
    pub page: u32,
    #[serde(default)]
    pub limit: u32,
}

fn first_page() -> u32 {
    1
}

/// Filters for GET /evidences. The backend defaults to page 1 of 24, at most 100 per page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EvidenceQuery {
    pub org_id: Option<String>,
    pub search: Option<String>,
    /// Local user IDs.
    pub created_by: Vec<String>,
    pub tag_ids: Vec<String>,
    pub page: Option<u32>,
    pub limit: Option<u32>,
}

impl EvidenceQuery {
    pub fn for_org(org_id: impl Into<String>) -> Self {
        Self {
            org_id: Some(org_id.into()),
            ..Self::default()
        }
    }

    pub(crate) fn to_path(&self) -> String {
        let join = |values: &[String]| (!values.is_empty()).then(|| values.join(","));
        let query = query_string([
            ("orgId", self.org_id.clone()),
            ("createdBy", join(&self.created_by)),
            ("tagIds", join(&self.tag_ids)),
            (
                "search",
                self.search
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(String::from),
            ),
            ("page", self.page.map(|page| page.to_string())),
            ("limit", self.limit.map(|limit| limit.to_string())),
        ]);
        format!("/evidences{query}")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub id: String,
    pub evidence_id: String,
    /// `recording`, `network-log` (the session archive), `screenshot`, …
    pub kind: String,
    pub mime_type: String,
    pub bytes: u64,
    /// `sha256:<hex>` for desktop uploads.
    pub checksum: String,
    /// `uploading` or `uploaded`.
    pub upload_status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
struct ArtifactList {
    artifacts: Vec<ArtifactSummary>,
}

/// A short-lived signed URL. Fetch it without credentials; renew after `renew_after_ms`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadUrl {
    pub url: String,
    pub expires_at: i64,
    pub renew_after_ms: f64,
}

/// GET /evidences/:id/playback: the evidence plus read URLs for its video and archive.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    pub evidence: PlaybackEvidence,
    pub artifacts: Vec<ArtifactSummary>,
    pub read_urls: Vec<PlaybackReadUrl>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackEvidence {
    #[serde(flatten)]
    pub summary: EvidenceSummary,
    #[serde(default)]
    pub created_by_profile: Option<CreatorProfile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorProfile {
    pub display_name: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackReadUrl {
    pub artifact_id: String,
    pub url: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub renew_after_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkSummary {
    pub id: String,
    pub slug: String,
    pub evidence_id: String,
    pub org_id: String,
    /// Always `internal` today.
    pub scope: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
    pub created_by: String,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedShareLink {
    pub id: String,
    pub slug: String,
    /// Shown once by the backend; the desktop app links by slug and never needs it.
    pub token: String,
    pub evidence_id: String,
    pub org_id: String,
    pub expires_at: i64,
    pub scope: String,
}

impl std::fmt::Debug for CreatedShareLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedShareLink")
            .field("id", &self.id)
            .field("slug", &self.slug)
            .field("token", &"<redacted>")
            .field("evidence_id", &self.evidence_id)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedShareLink {
    pub id: String,
    pub revoked_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareLinkList {
    share_links: Vec<ShareLinkSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareLinkEnvelope<T> {
    share_link: T,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateShareLinkBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_in_ms: Option<u64>,
}

fn org_query(org_id: Option<&str>) -> String {
    query_string([("orgId", org_id.map(String::from))])
}

impl ApiClient {
    pub fn list_evidences(&self, query: &EvidenceQuery) -> Result<EvidencePage, ApiError> {
        self.get(&query.to_path())
    }

    pub fn list_evidence_artifacts(
        &self,
        evidence_id: &str,
        org_id: Option<&str>,
    ) -> Result<Vec<ArtifactSummary>, ApiError> {
        let path = format!(
            "/evidences/{}/artifacts{}",
            encode_component(evidence_id),
            org_query(org_id)
        );
        Ok(self.get::<ArtifactList>(&path)?.artifacts)
    }

    /// GET /evidences/:id/artifacts/:artifactId/read-url (409 `ARTIFACT_NOT_READY` while uploading).
    pub fn artifact_read_url(
        &self,
        evidence_id: &str,
        artifact_id: &str,
        org_id: Option<&str>,
    ) -> Result<ReadUrl, ApiError> {
        let path = format!(
            "/evidences/{}/artifacts/{}/read-url{}",
            encode_component(evidence_id),
            encode_component(artifact_id),
            org_query(org_id)
        );
        self.get(&path)
    }

    /// GET /evidences/:id/playback (409 `EVIDENCE_NOT_READY` while uploading).
    pub fn evidence_playback(
        &self,
        evidence_id: &str,
        org_id: Option<&str>,
    ) -> Result<Playback, ApiError> {
        let path = format!(
            "/evidences/{}/playback{}",
            encode_component(evidence_id),
            org_query(org_id)
        );
        self.get(&path)
    }

    pub fn list_share_links(&self, evidence_id: &str) -> Result<Vec<ShareLinkSummary>, ApiError> {
        let path = format!("/evidences/{}/share-links", encode_component(evidence_id));
        Ok(self.get::<ShareLinkList>(&path)?.share_links)
    }

    /// `expires_in` defaults to the backend's own TTL; at most one year.
    pub fn create_share_link(
        &self,
        evidence_id: &str,
        expires_in: Option<Duration>,
    ) -> Result<CreatedShareLink, ApiError> {
        let path = format!("/evidences/{}/share-links", encode_component(evidence_id));
        let body = CreateShareLinkBody {
            expires_in_ms: expires_in.map(|ttl| ttl.as_millis() as u64),
        };
        Ok(self
            .post::<ShareLinkEnvelope<CreatedShareLink>>(&path, Some(&body))?
            .share_link)
    }

    pub fn revoke_share_link(&self, share_link_id: &str) -> Result<RevokedShareLink, ApiError> {
        let path = format!("/share-links/{}/revoke", encode_component(share_link_id));
        Ok(self
            .post::<ShareLinkEnvelope<RevokedShareLink>>(&path, None::<&()>)?
            .share_link)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVIDENCE: &str = r##"{
        "id": "ev_1", "orgId": "org_1", "title": "Checkout bug", "sourceType": "desktop-session",
        "sourceExternalId": "2026-10-29T10-00-00-000Z-abc", "sourceMetadata": "{\"durationMs\":1200}",
        "thumbnailBase64": null, "thumbnailMimeType": null, "createdBy": "u_1",
        "createdAt": 1761700000000, "updatedAt": 1761700000500, "status": "pending",
        "durationMs": 1200, "actionCount": null, "requestCount": 4,
        "tags": [{"id": "t_1", "name": "Bug", "color": "#ef4444"}]
    }"##;

    #[test]
    fn builds_evidence_list_paths() {
        assert_eq!(EvidenceQuery::default().to_path(), "/evidences");
        let query = EvidenceQuery {
            org_id: Some("org/1".into()),
            search: Some("  login  ".into()),
            tag_ids: vec!["t1".into(), "t2".into()],
            page: Some(2),
            limit: Some(50),
            ..EvidenceQuery::default()
        };
        assert_eq!(
            query.to_path(),
            "/evidences?orgId=org%2F1&tagIds=t1%2Ct2&search=login&page=2&limit=50"
        );
    }

    #[test]
    fn parses_evidence_page() {
        let page: EvidencePage = serde_json::from_str(&format!(
            r#"{{"evidences":[{EVIDENCE}],"orgId":"org_1","total":1,"page":1,"limit":24}}"#
        ))
        .unwrap();
        let evidence = &page.evidences[0];
        assert_eq!(evidence.status, EvidenceStatus::Pending);
        assert_eq!(evidence.duration_ms, Some(1200.0));
        assert_eq!(evidence.tags[0].name, "Bug");
        assert_eq!(page.total, 1);
    }

    #[test]
    fn parses_playback() {
        let mut evidence: serde_json::Value = serde_json::from_str(EVIDENCE).unwrap();
        evidence["createdByProfile"] = serde_json::json!({"displayName": "Dana", "email": null});
        let playback: Playback = serde_json::from_value(serde_json::json!({
            "evidence": evidence,
            "artifacts": [{"id":"a_1","evidenceId":"ev_1","kind":"recording","mimeType":"video/mp4","bytes":10,"checksum":"sha256:00","uploadStatus":"uploaded","createdAt":1,"updatedAt":2}],
            "readUrls": [{"artifactId":"a_1","url":"https://s3.example.com/x","expiresAt":5,"renewAfterMs":30000}]
        }))
        .unwrap();
        assert_eq!(playback.evidence.summary.id, "ev_1");
        assert_eq!(
            playback.evidence.created_by_profile.unwrap().display_name,
            "Dana"
        );
        assert_eq!(playback.read_urls[0].artifact_id, "a_1");
    }

    #[test]
    fn parses_share_links() {
        let list: ShareLinkList = serde_json::from_str(
            r#"{"shareLinks":[{"id":"s_1","slug":"abc123","evidenceId":"ev_1","orgId":"org_1","scope":"internal","createdAt":1,"expiresAt":2,"revokedAt":null,"createdBy":"u_1"}]}"#,
        )
        .unwrap();
        assert_eq!(list.share_links[0].revoked_at, None);
        let created: ShareLinkEnvelope<CreatedShareLink> = serde_json::from_str(
            r#"{"shareLink":{"id":"s_2","slug":"def456","token":"tok_secret","evidenceId":"ev_1","orgId":"org_1","expiresAt":9,"scope":"internal"}}"#,
        )
        .unwrap();
        assert!(!format!("{:?}", created.share_link).contains("tok_secret"));
        assert_eq!(
            serde_json::to_string(&CreateShareLinkBody {
                expires_in_ms: None
            })
            .unwrap(),
            "{}"
        );
        assert_eq!(
            serde_json::to_string(&CreateShareLinkBody {
                expires_in_ms: Some(60_000)
            })
            .unwrap(),
            r#"{"expiresInMs":60000}"#
        );
    }
}
