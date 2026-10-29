// Account and organisation endpoints (apps/backend/src/routes/protected.ts, orgs.ts).

use serde::Deserialize;

use crate::error::ApiError;
use crate::http::{ApiClient, encode_component};

/// GET /protected/me
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub user_id: String,
    #[serde(default)]
    pub local_user_id: Option<String>,
    #[serde(default)]
    pub org_id: Option<String>,
    pub active_org_id: Option<String>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub user: AccountUser,
    pub organizations: Vec<AccountOrganization>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOrganization {
    pub id: String,
    pub name: String,
    pub role: String,
    pub is_personal: bool,
    pub is_active: bool,
    #[serde(default)]
    pub migration_access_state: Option<String>,
    #[serde(default)]
    pub migration_destination_web_origin: Option<String>,
}

impl AccountProfile {
    /// The name shown on the account chip (auth-context.tsx `getAccountDisplayLabel`).
    pub fn display_label(&self) -> String {
        let display_name = self.user.display_name.trim();
        if !display_name.is_empty() && display_name != self.user.id {
            return display_name.to_string();
        }
        self.user
            .email
            .clone()
            .unwrap_or_else(|| display_name.to_string())
    }

    pub fn active_organization(&self) -> Option<&AccountOrganization> {
        self.organizations
            .iter()
            .find(|org| org.is_active)
            .or_else(|| {
                let active = self.active_org_id.as_deref()?;
                self.organizations.iter().find(|org| org.id == active)
            })
    }
}

/// GET /orgs item.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgSummary {
    pub id: String,
    pub name: String,
    /// `admin`, `moderator`, `developer` or `qa_engineer` (custom roles may follow).
    pub role: String,
    pub is_personal: bool,
    #[serde(default)]
    pub require_invitation_approval: bool,
    pub member_count: u64,
    pub evidence_count: u64,
    pub comment_count: u64,
    pub created_at: i64,
    pub joined_at: i64,
    #[serde(default)]
    pub migration_access_state: Option<String>,
    #[serde(default)]
    pub migration_destination_web_origin: Option<String>,
}

#[derive(Deserialize)]
struct OrgList {
    organizations: Vec<OrgSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectedOrg {
    organization_id: String,
}

#[derive(Deserialize)]
struct OkResponse {
    #[allow(dead_code)]
    ok: bool,
}

impl ApiClient {
    pub fn account_profile(&self) -> Result<AccountProfile, ApiError> {
        self.get("/protected/me")
    }

    pub fn list_organizations(&self) -> Result<Vec<OrgSummary>, ApiError> {
        Ok(self.get::<OrgList>("/orgs")?.organizations)
    }

    /// POST /orgs/:orgId/select-active; returns the selected organisation ID.
    pub fn select_active_organization(&self, org_id: &str) -> Result<String, ApiError> {
        let path = format!("/orgs/{}/select-active", encode_component(org_id));
        Ok(self
            .post::<SelectedOrg>(&path, None::<&()>)?
            .organization_id)
    }

    pub fn leave_organization(&self, org_id: &str) -> Result<(), ApiError> {
        let path = format!("/orgs/{}/leave", encode_component(org_id));
        self.post::<OkResponse>(&path, None::<&()>).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape of protectedMeResponseSchema.
    const ME: &str = r#"{
        "userId": "user_2abc", "localUserId": "u_1", "orgId": "org_1", "activeOrgId": "org_1",
        "roles": ["admin"], "scopes": ["evidence:write", "share:write"],
        "user": {"id": "user_2abc", "displayName": "user_2abc", "email": "qa@example.com", "imageUrl": null},
        "organizations": [
            {"id": "org_0", "name": "Personal", "role": "admin", "isPersonal": true, "isActive": false, "migrationAccessState": null, "migrationDestinationWebOrigin": null},
            {"id": "org_1", "name": "Acme QA", "role": "qa_engineer", "isPersonal": false, "isActive": true, "migrationAccessState": null, "migrationDestinationWebOrigin": null}
        ]
    }"#;

    #[test]
    fn parses_profile_and_picks_label() {
        let profile: AccountProfile = serde_json::from_str(ME).unwrap();
        assert_eq!(profile.display_label(), "qa@example.com");
        assert_eq!(profile.active_organization().unwrap().name, "Acme QA");
        let mut named = profile.clone();
        named.user.display_name = "Dana Q".into();
        assert_eq!(named.display_label(), "Dana Q");
    }

    #[test]
    fn parses_org_list() {
        let list: OrgList = serde_json::from_str(
            r#"{"organizations":[{"id":"org_1","name":"Acme QA","role":"admin","isPersonal":false,"requireInvitationApproval":true,
            "memberCount":4,"evidenceCount":12,"commentCount":3,"createdAt":1700000000000,"joinedAt":1700000000001,
            "migrationAccessState":null,"migrationDestinationWebOrigin":null}]}"#,
        )
        .unwrap();
        assert_eq!(list.organizations[0].member_count, 4);
        assert!(list.organizations[0].require_invitation_approval);
    }
}
