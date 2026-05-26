import { apiOrigin } from "./env";

export type FetchToken = () => Promise<string | null>;

async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? fallback;
}

async function authedFetch<T>(getToken: FetchToken, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Sign in is required.");

  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(await readApiError(response, `Request failed (${response.status}).`));
  }
  return (await response.json()) as T;
}

export type AcceptInvitationResponse = {
  organizationId: string;
  role: "owner" | "moderator" | "member";
  invitationId: string;
};

export type ApiOrganization = {
  id: string;
  name: string;
  role: string;
  isPersonal: boolean;
  isActive: boolean;
};

export type ApiOrgSummary = {
  id: string;
  name: string;
  role: string;
  isPersonal: boolean;
  memberCount: number;
  createdAt: number;
  joinedAt: number;
};

export type ApiMember = {
  membershipId: string;
  userId: string;
  clerkUserId: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  role: string;
  joinedAt: number;
  guestExpiresAt: number | null;
};

export type ApiMembersResponse = {
  members: ApiMember[];
  total: number;
  page: number;
  limit: number;
};

export type ApiInvitation = {
  id: string;
  email: string;
  role: "owner" | "moderator" | "member";
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: number;
  createdAt: number;
  invitedBy: string;
};

export type ApiInvitationCode = {
  id: string;
  label: string;
  role: "moderator" | "member";
  hasPassword: boolean;
  emailDomain: string | null;
  expiresAt: number | null;
  guestExpiresAfterDays: number | null;
  lockedAt: number | null;
  createdAt: number;
  createdBy: string;
};

export type ApiCreatedInvitationCode = ApiInvitationCode & {
  code: string;
  organizationId: string;
};

export type ApiInvitationLookup = {
  code: {
    codeId: string;
    organizationId: string;
    label: string;
    requiresPassword: boolean;
    emailDomain: string | null;
    guestExpiresAfterDays: number | null;
  };
};

export type ApiAccountProfile = {
  userId: string;
  activeOrgId: string | null;
  user: {
    id: string;
    displayName: string;
    email: string | null;
    imageUrl: string | null;
  };
  organizations: ApiOrganization[];
};

export type EvidenceArtifact = {
  id: string;
  evidenceId: string;
  kind: string;
  mimeType: string;
  bytes: number;
  checksum: string;
  uploadStatus: string;
  createdAt: number;
  updatedAt: number;
};

export type ArtifactReadUrl = {
  url: string;
  expiresAt: number;
  renewAfterMs: number;
};

export type ApiEvidenceSummary = {
  id: string;
  orgId: string;
  title: string;
  sourceType: string;
  sourceExternalId?: string | null;
  sourceMetadata?: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ResolveShareLinkResponse = {
  shareLink: {
    id: string;
    evidenceId: string;
    orgId: string;
    expiresAt: number;
    access: "granted" | "denied";
  };
  organization: {
    id: string;
    name: string;
  };
};

export type ApiShareLinkSummary = {
  id: string;
  evidenceId: string;
  orgId: string;
  scope: "internal";
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  createdBy: string;
};

export type CreatedShareLink = {
  id: string;
  token: string;
  evidenceId: string;
  orgId: string;
  expiresAt: number;
  scope: "internal";
};

export const api = {
  resolveShareLink: (getToken: FetchToken, token: string) =>
    authedFetch<ResolveShareLinkResponse>(
      getToken,
      `/share-links/${encodeURIComponent(token)}/resolve`
    ),

  listEvidences: (getToken: FetchToken, orgId?: string) =>
    authedFetch<{ evidences: ApiEvidenceSummary[]; orgId: string }>(
      getToken,
      orgId ? `/evidences?orgId=${encodeURIComponent(orgId)}` : "/evidences"
    ),

  deleteEvidence: (getToken: FetchToken, evidenceId: string) =>
    authedFetch<{ evidence: { id: string; orgId: string } }>(
      getToken,
      `/evidences/${encodeURIComponent(evidenceId)}`,
      { method: "DELETE" }
    ),

  listEvidenceArtifacts: (getToken: FetchToken, evidenceId: string, orgId?: string) =>
    authedFetch<{ artifacts: EvidenceArtifact[] }>(
      getToken,
      `/evidences/${encodeURIComponent(evidenceId)}/artifacts${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`
    ),

  createArtifactReadUrl: (getToken: FetchToken, evidenceId: string, artifactId: string, orgId?: string) =>
    authedFetch<ArtifactReadUrl>(
      getToken,
      `/evidences/${encodeURIComponent(evidenceId)}/artifacts/${encodeURIComponent(artifactId)}/read-url${
        orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""
      }`
    ),

  listShareLinks: (getToken: FetchToken, evidenceId: string) =>
    authedFetch<{ shareLinks: ApiShareLinkSummary[] }>(
      getToken,
      `/evidences/${encodeURIComponent(evidenceId)}/share-links`
    ),

  createShareLink: (getToken: FetchToken, evidenceId: string, expiresInMs?: number) =>
    authedFetch<{ shareLink: CreatedShareLink }>(
      getToken,
      `/evidences/${encodeURIComponent(evidenceId)}/share-links`,
      {
        method: "POST",
        body: JSON.stringify(expiresInMs !== undefined ? { expiresInMs } : {})
      }
    ),

  revokeShareLink: (getToken: FetchToken, shareLinkId: string) =>
    authedFetch<{ shareLink: { id: string; revokedAt: number } }>(
      getToken,
      `/share-links/${encodeURIComponent(shareLinkId)}/revoke`,
      { method: "POST" }
    ),

  acceptInvitation: (getToken: FetchToken, token: string) =>
    authedFetch<AcceptInvitationResponse>(getToken, "/orgs/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token })
    }),

  lookupInvitation: (getToken: FetchToken, token: string) =>
    authedFetch<ApiInvitationLookup>(getToken, "/orgs/invitations/lookup", {
      method: "POST",
      body: JSON.stringify({ token })
    }),

  acceptInvitationWithPassword: (getToken: FetchToken, token: string, password?: string) =>
    authedFetch<AcceptInvitationResponse>(getToken, "/orgs/invitations/accept", {
      method: "POST",
      body: JSON.stringify(password ? { token, password } : { token })
    }),

  fetchAccountProfile: (getToken: FetchToken) =>
    authedFetch<ApiAccountProfile>(getToken, "/protected/me"),

  selectActiveOrganization: (getToken: FetchToken, orgId: string) =>
    authedFetch<{ organizationId: string }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/select-active`,
      { method: "POST" }
    ),

  leaveOrganization: (getToken: FetchToken, orgId: string) =>
    authedFetch<{ ok: true }>(getToken, `/orgs/${encodeURIComponent(orgId)}/leave`, {
      method: "POST"
    }),

  listOrganizations: (getToken: FetchToken) =>
    authedFetch<{ organizations: ApiOrgSummary[] }>(getToken, "/orgs"),

  createOrganization: (getToken: FetchToken, name: string) =>
    authedFetch<{ organization: ApiOrgSummary }>(getToken, "/orgs", {
      method: "POST",
      body: JSON.stringify({ name })
    }),

  renameOrganization: (getToken: FetchToken, orgId: string, name: string) =>
    authedFetch<{ organizationId: string; name: string }>(getToken, `/orgs/${encodeURIComponent(orgId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    }),

  listMembers: (
    getToken: FetchToken,
    orgId: string,
    options: { search?: string | undefined; role?: "all" | "owner" | "moderator" | "member"; page?: number; limit?: number } = {}
  ) => {
    const query = new URLSearchParams();
    if (options.search) query.set("search", options.search);
    if (options.role && options.role !== "all") query.set("role", options.role);
    if (options.page) query.set("page", String(options.page));
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return authedFetch<ApiMembersResponse>(getToken, `/orgs/${encodeURIComponent(orgId)}/members${suffix}`);
  },

  listInvitations: (getToken: FetchToken, orgId: string) =>
    authedFetch<{ invitations: ApiInvitation[]; codes: ApiInvitationCode[] }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/invitations`
    ),

  updateMemberRole: (getToken: FetchToken, orgId: string, membershipId: string, role: "moderator" | "member") =>
    authedFetch<{ ok: true }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(membershipId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) }
    ),

  removeMember: (getToken: FetchToken, orgId: string, membershipId: string) =>
    authedFetch<{ ok: true }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(membershipId)}`,
      { method: "DELETE" }
    ),

  createInvitationCode: (
    getToken: FetchToken,
    orgId: string,
    body: {
      label: string;
      role?: "moderator" | "member";
      password?: string;
      emailDomain?: string | null;
      expiresAt?: number | null;
      guestExpiresAfterDays?: number | null;
    }
  ) =>
    authedFetch<{ code: ApiCreatedInvitationCode }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/invitation-codes`,
      { method: "POST", body: JSON.stringify(body) }
    ),

  setInvitationCodeLocked: (getToken: FetchToken, orgId: string, codeId: string, locked: boolean) =>
    authedFetch<{ code: ApiInvitationCode }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/invitation-codes/${encodeURIComponent(codeId)}/lock`,
      { method: "POST", body: JSON.stringify({ locked }) }
    ),

  deleteInvitationCode: (getToken: FetchToken, orgId: string, codeId: string) =>
    authedFetch<{ ok: true }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/invitation-codes/${encodeURIComponent(codeId)}`,
      { method: "DELETE" }
    )
};
