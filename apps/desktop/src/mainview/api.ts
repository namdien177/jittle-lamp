export const apiOrigin = (process.env.JITTLE_LAMP_API_ORIGIN?.trim() || "http://127.0.0.1:3001").replace(/\/+$/, "");
export const webOrigin = (process.env.JITTLE_LAMP_WEB_ORIGIN?.trim() || "http://127.0.0.1:4173").replace(/\/+$/, "");

export type ApiOrganization = {
  id: string;
  name: string;
  role: string;
  isPersonal: boolean;
  isActive: boolean;
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

export type ApiCreatedInvitation = ApiInvitation & {
  organizationId: string;
  token: string;
};

export type ApiEvidenceSummary = {
  id: string;
  orgId: string;
  title: string;
  sourceType: string;
  sourceExternalId?: string | null;
  sourceMetadata?: string | null;
  thumbnailBase64?: string | null;
  thumbnailMimeType?: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  status?: "ready" | "pending";
};

export type ApiEvidenceArtifactSummary = {
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

export type StartedEvidenceUpload = {
  uploadId: string;
  evidenceId: string;
  organizationId: string;
  uploadSession: {
    expiresAt: number;
    uploadUrl: string;
    method: "PUT";
    headers: {
      "content-type": string;
    };
    storageKey: string;
  };
};

export type StartedDesktopSessionSync = {
  evidenceId: string;
  organizationId: string;
  uploadSessions: Array<{
    key: string;
    uploadId: string;
    expiresAt: number;
    uploadUrl: string;
    method: "PUT";
    headers: {
      "content-type": string;
    };
    storageKey: string;
  }>;
};

async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? fallback;
}

export type FetchToken = () => Promise<string | null>;

async function authedFetch<T>(getToken: FetchToken, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("No API session token available.");

  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(await readApiError(response, `Request failed (${response.status}).`));
  }

  if (response.status === 204) return undefined as unknown as T;
  return (await response.json()) as T;
}

export const api = {
  fetchAccountProfile: (getToken: FetchToken) =>
    authedFetch<ApiAccountProfile>(getToken, "/protected/me"),

  selectActiveOrganization: (getToken: FetchToken, orgId: string) =>
    authedFetch<{ organizationId: string }>(getToken, `/orgs/${encodeURIComponent(orgId)}/select-active`, {
      method: "POST"
    }),

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
      {
        method: "PATCH",
        body: JSON.stringify({ role })
      }
    ),

  removeMember: (getToken: FetchToken, orgId: string, membershipId: string) =>
    authedFetch<{ ok: true }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(membershipId)}`,
      { method: "DELETE" }
    ),

  createInvitation: (
    getToken: FetchToken,
    orgId: string,
    body: { email: string; role?: "owner" | "moderator" | "member"; ttlMs?: number }
  ) =>
    authedFetch<{ invitation: ApiCreatedInvitation }>(getToken, `/orgs/${encodeURIComponent(orgId)}/invitations`, {
      method: "POST",
      body: JSON.stringify(body)
    }),

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
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    ),

  setInvitationCodeLocked: (getToken: FetchToken, orgId: string, codeId: string, locked: boolean) =>
    authedFetch<{ code: ApiInvitationCode }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/invitation-codes/${encodeURIComponent(codeId)}/lock`,
      {
        method: "POST",
        body: JSON.stringify({ locked })
      }
    ),

  deleteInvitationCode: (getToken: FetchToken, orgId: string, codeId: string) =>
    authedFetch<{ ok: true }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/invitation-codes/${encodeURIComponent(codeId)}`,
      { method: "DELETE" }
    ),

  revokeInvitation: (getToken: FetchToken, orgId: string, invitationId: string) =>
    authedFetch<{ invitation: ApiInvitation }>(
      getToken,
      `/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
      { method: "POST" }
    ),

  lookupInvitation: (getToken: FetchToken, token: string) =>
    authedFetch<ApiInvitationLookup>(getToken, "/orgs/invitations/lookup", {
      method: "POST",
      body: JSON.stringify({ token })
    }),

  acceptInvitation: (getToken: FetchToken, token: string, password?: string) =>
    authedFetch<{ organizationId: string; role: "owner" | "moderator" | "member"; invitationId: string }>(
      getToken,
      "/orgs/invitations/accept",
      {
        method: "POST",
        body: JSON.stringify(password ? { token, password } : { token })
      }
    ),

  listEvidences: (getToken: FetchToken, orgId?: string) =>
    authedFetch<{ evidences: ApiEvidenceSummary[]; orgId: string }>(
      getToken,
      orgId ? `/evidences?orgId=${encodeURIComponent(orgId)}` : "/evidences"
    ),

  listEvidenceArtifacts: (getToken: FetchToken, evidenceId: string, orgId?: string) =>
    authedFetch<{ artifacts: ApiEvidenceArtifactSummary[] }>(
      getToken,
      `/evidences/${encodeURIComponent(evidenceId)}/artifacts${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`
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

  startEvidenceUpload: (
    getToken: FetchToken,
    body: {
      title: string;
      sourceType: string;
      sourceExternalId: string;
      sourceMetadata?: string;
      artifact: {
        kind: "recording" | "transcript" | "screenshot" | "network-log" | "attachment";
        mimeType: string;
        bytes: number;
        checksum: string;
      };
    }
  ) =>
    authedFetch<StartedEvidenceUpload>(getToken, "/evidences/uploads/start", {
      method: "POST",
      body: JSON.stringify(body)
    }),

  startDesktopSessionSync: (
    getToken: FetchToken,
    body: {
      sessionId: string;
      title: string;
      sourceMetadata?: string;
      thumbnailBase64?: string;
      thumbnailMimeType?: string;
      replaceEvidenceId?: string;
      artifacts: Array<{
        key: "recording" | "archive";
        kind: "recording" | "network-log";
        mimeType: string;
        bytes: number;
        checksum: string;
      }>;
    }
  ) =>
    authedFetch<StartedDesktopSessionSync>(getToken, "/evidences/desktop-sessions/sync/start", {
      method: "POST",
      body: JSON.stringify(body)
    }),

  uploadEvidenceBlob: async (
    getToken: FetchToken,
    uploadUrl: string,
    payload: Uint8Array,
    mimeType: string
  ): Promise<void> => {
    const token = await getToken();
    if (!token) throw new Error("No API session token available.");

    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": mimeType
      },
      body: new Blob([payload.slice().buffer as ArrayBuffer], { type: mimeType })
    });
    if (!response.ok) {
      throw new Error(await readApiError(response, `Upload failed (${response.status}).`));
    }
  },

  completeEvidenceUpload: (
    getToken: FetchToken,
    uploadId: string,
    body: { bytes: number; checksum: string; mimeType: string }
  ) =>
    authedFetch<{ uploadId: string; evidenceId: string; status: "committed" }>(
      getToken,
      `/evidences/uploads/${encodeURIComponent(uploadId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    ),

  revokeShareLink: (getToken: FetchToken, shareLinkId: string) =>
    authedFetch<{ shareLink: { id: string; revokedAt: number } }>(
      getToken,
      `/share-links/${encodeURIComponent(shareLinkId)}/revoke`,
      { method: "POST" }
    )
};
