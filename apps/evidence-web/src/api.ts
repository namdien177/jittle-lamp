import { apiOrigin } from "./env";

export type FetchToken = () => Promise<string | null>;

async function readApiError(
	response: Response,
	fallback: string,
): Promise<string> {
	const payload = (await response.json().catch(() => null)) as {
		error?: { message?: string };
	} | null;
	return payload?.error?.message ?? fallback;
}

async function authedFetch<T>(
	getToken: FetchToken,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const token = await getToken();
	if (!token) throw new Error("Sign in is required.");

	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${token}`);
	if (!headers.has("content-type") && init.body) {
		headers.set("content-type", "application/json");
	}

	const response = await fetch(`${apiOrigin}${path}`, { ...init, headers });
	if (!response.ok) {
		throw new Error(
			await readApiError(response, `Request failed (${response.status}).`),
		);
	}
	return (await response.json()) as T;
}

export type AcceptInvitationResponse = {
	organizationId: string;
	role: OrganizationRoleKey;
	invitationId: string;
	status: "accepted" | "pending_approval";
};

export type OrganizationRoleKey =
	| "admin"
	| "moderator"
	| "developer"
	| "qa_engineer";
export type OrganizationPermission =
	| "evidence.view"
	| "evidence.download"
	| "evidence.comment"
	| "evidence.create"
	| "evidence.update.own"
	| "evidence.delete.own"
	| "evidence.move.own"
	| "evidence.update.any"
	| "evidence.delete.any"
	| "evidence.move.any"
	| "evidence.tags.manage"
	| "invitations.create"
	| "invitations.disable"
	| "join_requests.manage"
	| "roles.manage"
	| "members.assign_role"
	| "members.kick"
	| "activity.view";

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
	requireInvitationApproval: boolean;
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
	role: OrganizationRoleKey;
	status: "pending" | "accepted" | "revoked" | "expired";
	expiresAt: number;
	createdAt: number;
	invitedBy: string;
};

export type ApiInvitationCode = {
	id: string;
	label: string;
	role: OrganizationRoleKey;
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

export type ApiOrganizationRole = {
	key: OrganizationRoleKey;
	name: string;
	permissions: OrganizationPermission[];
	isSystem: boolean;
	updatedAt: number;
};

export type ApiJoinRequest = {
	id: string;
	organizationId: string;
	userId: string;
	clerkUserId: string;
	displayName: string;
	email: string | null;
	requestedRole: OrganizationRoleKey;
	status: "pending" | "approved" | "rejected";
	createdAt: number;
};

export type ApiActivityLog = {
	id: string;
	organizationId: string;
	actorUserId: string | null;
	action: string;
	entityType: string;
	entityId: string | null;
	message: string;
	metadata: Record<string, unknown>;
	ipAddress: string | null;
	createdAt: number;
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
	localUserId: string | null;
	activeOrgId: string | null;
	user: {
		id: string;
		displayName: string;
		email: string | null;
		imageUrl: string | null;
	};
	organizations: ApiOrganization[];
};

export type ApiAiAccessToken = {
	id: string;
	label: string;
	token: string | null;
	tokenVersion: "v1" | "v2";
	tokenPrefix: string;
	scopes: string[];
	createdAt: number;
	expiresAt: number | null;
	lastUsedAt: number | null;
	revokedAt: number | null;
};

export type ApiCreateAiAccessTokenResponse = {
	accessToken: ApiAiAccessToken;
	token: string;
};

export type ApiAutomationApiToken = {
	id: string;
	orgId: string;
	label: string;
	token: string | null;
	tokenPrefix: string;
	scopes: string[];
	createdAt: number;
	expiresAt: number | null;
	lastUsedAt: number | null;
	revokedAt: number | null;
};

export type ApiCreateAutomationApiTokenResponse = {
	apiToken: ApiAutomationApiToken;
	token: string;
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
	thumbnailBase64?: string | null;
	thumbnailMimeType?: string | null;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	status?: "ready" | "pending";
	durationMs: number | null;
	actionCount: number | null;
	tags: ApiEvidenceTag[];
};

export type ApiEvidenceTag = {
	id: string;
	name: string;
	color: string;
};

export type ApiEvidenceListResponse = {
	evidences: ApiEvidenceSummary[];
	orgId: string;
	total: number;
	page: number;
	limit: number;
};

export type ApiEvidenceResponse = {
	evidence: ApiEvidenceSummary;
};

export type ApiCopyEvidenceResponse = {
	evidence: {
		id: string;
		orgId: string;
		sourceEvidenceId: string;
	};
	copy: {
		copiedAt: number;
		copiedBy: string;
		fromOrgId: string;
		toOrgId: string;
		artifactCount: number;
	};
};

export type ApiMoveEvidenceResponse = {
	evidence: {
		id: string;
		orgId: string;
	};
	move: {
		movedAt: number;
		movedBy: string;
		fromOrgId: string;
		toOrgId: string;
		invalidatedShareLinks: number;
	};
};

export type ApiEvidenceComment = {
	id: string;
	evidenceId: string;
	body: string;
	createdBy: string;
	authorLabel: string;
	createdAt: number;
	updatedAt: number;
};

export type ApiEvidenceCommentsResponse = {
	comments: ApiEvidenceComment[];
};

export type ResolveShareLinkResponse = {
	shareLink: {
		id: string;
		slug: string;
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
	slug: string;
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
	slug: string;
	token: string;
	evidenceId: string;
	orgId: string;
	expiresAt: number;
	scope: "internal";
};

export const api = {
	resolveShareLink: (getToken: FetchToken, locator: string) =>
		authedFetch<ResolveShareLinkResponse>(
			getToken,
			`/share-links/${encodeURIComponent(locator)}/resolve`,
		),

	listEvidences: (
		getToken: FetchToken,
		options: {
			orgId?: string;
			createdBy?: string[];
			tagIds?: string[];
			search?: string;
			page?: number;
			limit?: number;
		} = {},
	) => {
		const query = new URLSearchParams();
		if (options.orgId) query.set("orgId", options.orgId);
		if (options.createdBy && options.createdBy.length > 0)
			query.set("createdBy", options.createdBy.join(","));
		if (options.tagIds && options.tagIds.length > 0)
			query.set("tagIds", options.tagIds.join(","));
		if (options.search?.trim()) query.set("search", options.search.trim());
		if (options.page) query.set("page", String(options.page));
		if (options.limit) query.set("limit", String(options.limit));
		const suffix = query.toString() ? `?${query.toString()}` : "";
		return authedFetch<ApiEvidenceListResponse>(
			getToken,
			`/evidences${suffix}`,
		);
	},

	listEvidenceTags: (getToken: FetchToken, orgId?: string) => {
		const query = new URLSearchParams();
		if (orgId) query.set("orgId", orgId);
		const suffix = query.toString() ? `?${query.toString()}` : "";
		return authedFetch<{ tags: ApiEvidenceTag[] }>(
			getToken,
			`/evidences/tags${suffix}`,
		);
	},

	updateEvidenceTags: (
		getToken: FetchToken,
		evidenceId: string,
		tagIds: string[],
	) =>
		authedFetch<{ evidence: { id: string; orgId: string; tags: ApiEvidenceTag[] } }>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/tags`,
			{
				method: "PATCH",
				body: JSON.stringify({ tagIds }),
			},
		),

	createEvidenceTag: (
		getToken: FetchToken,
		input: { orgId: string; name: string; color: string },
	) =>
		authedFetch<{ tag: ApiEvidenceTag }>(getToken, "/evidences/tags", {
			method: "POST",
			body: JSON.stringify(input),
		}),

	updateEvidenceTag: (
		getToken: FetchToken,
		input: { orgId: string; tagId: string; name: string; color: string },
	) =>
		authedFetch<{ tag: ApiEvidenceTag }>(
			getToken,
			`/evidences/tags/${encodeURIComponent(input.tagId)}`,
			{
				method: "PATCH",
				body: JSON.stringify({
					orgId: input.orgId,
					name: input.name,
					color: input.color,
				}),
			},
		),

	deleteEvidenceTag: (
		getToken: FetchToken,
		input: { orgId: string; tagId: string },
	) => {
		const query = new URLSearchParams({ orgId: input.orgId });
		return authedFetch<{ tagId: string }>(
			getToken,
			`/evidences/tags/${encodeURIComponent(input.tagId)}?${query.toString()}`,
			{ method: "DELETE" },
		);
	},

	loadEvidence: (getToken: FetchToken, evidenceId: string, orgId?: string) =>
		authedFetch<ApiEvidenceResponse>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
		),

	deleteEvidence: (getToken: FetchToken, evidenceId: string) =>
		authedFetch<{
			evidence: {
				id: string;
				orgId: string;
				deletedAt: number;
				deletePurgesAt: number;
			};
		}>(getToken, `/evidences/${encodeURIComponent(evidenceId)}`, {
			method: "DELETE",
		}),

	bulkDeleteEvidences: (getToken: FetchToken, evidenceIds: string[]) =>
		authedFetch<{
			evidences: Array<{
				id: string;
				orgId: string;
				deletedAt: number;
				deletePurgesAt: number;
			}>;
			deleted: { mode: "soft"; count: number };
		}>(getToken, "/evidences/bulk-delete", {
			method: "POST",
			body: JSON.stringify({ ids: evidenceIds }),
		}),

	renameEvidence: (getToken: FetchToken, evidenceId: string, title: string) =>
		authedFetch<{
			evidence: { id: string; orgId: string; title: string; updatedAt: number };
		}>(getToken, `/evidences/${encodeURIComponent(evidenceId)}`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		}),

	copyEvidence: (
		getToken: FetchToken,
		evidenceId: string,
		targetOrgId: string,
	) =>
		authedFetch<ApiCopyEvidenceResponse>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/copy`,
			{
				method: "POST",
				body: JSON.stringify({ targetOrgId }),
			},
		),

	moveEvidence: (
		getToken: FetchToken,
		evidenceId: string,
		targetOrgId: string,
	) =>
		authedFetch<ApiMoveEvidenceResponse>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/move`,
			{
				method: "POST",
				body: JSON.stringify({ targetOrgId }),
			},
		),

	listEvidenceArtifacts: (
		getToken: FetchToken,
		evidenceId: string,
		orgId?: string,
	) =>
		authedFetch<{ artifacts: EvidenceArtifact[] }>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/artifacts${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
		),

	listEvidenceComments: (
		getToken: FetchToken,
		evidenceId: string,
		orgId?: string,
	) =>
		authedFetch<ApiEvidenceCommentsResponse>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/comments${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
		),

	createEvidenceComment: (
		getToken: FetchToken,
		evidenceId: string,
		body: string,
		orgId?: string,
	) =>
		authedFetch<{ comment: ApiEvidenceComment }>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/comments${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
			{ method: "POST", body: JSON.stringify({ body }) },
		),

	createArtifactReadUrl: (
		getToken: FetchToken,
		evidenceId: string,
		artifactId: string,
		orgId?: string,
	) =>
		authedFetch<ArtifactReadUrl>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/artifacts/${encodeURIComponent(artifactId)}/read-url${
				orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""
			}`,
		),

	listShareLinks: (getToken: FetchToken, evidenceId: string) =>
		authedFetch<{ shareLinks: ApiShareLinkSummary[] }>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/share-links`,
		),

	createShareLink: (
		getToken: FetchToken,
		evidenceId: string,
		expiresInMs?: number,
	) =>
		authedFetch<{ shareLink: CreatedShareLink }>(
			getToken,
			`/evidences/${encodeURIComponent(evidenceId)}/share-links`,
			{
				method: "POST",
				body: JSON.stringify(expiresInMs !== undefined ? { expiresInMs } : {}),
			},
		),

	revokeShareLink: (getToken: FetchToken, shareLinkId: string) =>
		authedFetch<{ shareLink: { id: string; revokedAt: number } }>(
			getToken,
			`/share-links/${encodeURIComponent(shareLinkId)}/revoke`,
			{ method: "POST" },
		),

	acceptInvitation: (getToken: FetchToken, token: string) =>
		authedFetch<AcceptInvitationResponse>(
			getToken,
			"/orgs/invitations/accept",
			{
				method: "POST",
				body: JSON.stringify({ token }),
			},
		),

	lookupInvitation: (getToken: FetchToken, token: string) =>
		authedFetch<ApiInvitationLookup>(getToken, "/orgs/invitations/lookup", {
			method: "POST",
			body: JSON.stringify({ token }),
		}),

	acceptInvitationWithPassword: (
		getToken: FetchToken,
		token: string,
		password?: string,
	) =>
		authedFetch<AcceptInvitationResponse>(
			getToken,
			"/orgs/invitations/accept",
			{
				method: "POST",
				body: JSON.stringify(password ? { token, password } : { token }),
			},
		),

	fetchAccountProfile: (getToken: FetchToken) =>
		authedFetch<ApiAccountProfile>(getToken, "/protected/me"),

	listAiAccessTokens: (getToken: FetchToken) =>
		authedFetch<{ accessTokens: ApiAiAccessToken[] }>(
			getToken,
			"/ai/access-tokens",
		),

	createAiAccessToken: (
		getToken: FetchToken,
		body: { label?: string; expiresInDays?: number; permanent?: boolean },
	) =>
		authedFetch<ApiCreateAiAccessTokenResponse>(getToken, "/ai/access-tokens", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	revokeAiAccessToken: (getToken: FetchToken, tokenId: string) =>
		authedFetch<{ accessToken: { id: string; revokedAt: number } }>(
			getToken,
			`/ai/access-tokens/${encodeURIComponent(tokenId)}`,
			{ method: "DELETE" },
		),

	listAutomationApiTokens: (getToken: FetchToken) =>
		authedFetch<{ apiTokens: ApiAutomationApiToken[] }>(
			getToken,
			"/automation/api-tokens",
		),

	createAutomationApiToken: (
		getToken: FetchToken,
		body: {
			label?: string;
			orgId?: string;
			expiresInDays?: number;
			permanent?: boolean;
		},
	) =>
		authedFetch<ApiCreateAutomationApiTokenResponse>(
			getToken,
			"/automation/api-tokens",
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		),

	revokeAutomationApiToken: (getToken: FetchToken, tokenId: string) =>
		authedFetch<{ apiToken: { id: string; revokedAt: number } }>(
			getToken,
			`/automation/api-tokens/${encodeURIComponent(tokenId)}`,
			{ method: "DELETE" },
		),

	selectActiveOrganization: (getToken: FetchToken, orgId: string) =>
		authedFetch<{ organizationId: string }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/select-active`,
			{ method: "POST" },
		),

	leaveOrganization: (getToken: FetchToken, orgId: string) =>
		authedFetch<{ ok: true }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/leave`,
			{
				method: "POST",
			},
		),

	deleteOrganization: (getToken: FetchToken, orgId: string) =>
		authedFetch<{ ok: true }>(getToken, `/orgs/${encodeURIComponent(orgId)}`, {
			method: "DELETE",
		}),

	listOrganizations: (getToken: FetchToken) =>
		authedFetch<{ organizations: ApiOrgSummary[] }>(getToken, "/orgs"),

	createOrganization: (getToken: FetchToken, name: string) =>
		authedFetch<{ organization: ApiOrgSummary }>(getToken, "/orgs", {
			method: "POST",
			body: JSON.stringify({ name }),
		}),

	renameOrganization: (getToken: FetchToken, orgId: string, name: string) =>
		authedFetch<{ organizationId: string; name: string }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}`,
			{
				method: "PATCH",
				body: JSON.stringify({ name }),
			},
		),

	listMembers: (
		getToken: FetchToken,
		orgId: string,
		options: {
			search?: string | undefined;
			role?: "all" | OrganizationRoleKey;
			page?: number;
			limit?: number;
		} = {},
	) => {
		const query = new URLSearchParams();
		if (options.search) query.set("search", options.search);
		if (options.role && options.role !== "all") query.set("role", options.role);
		if (options.page) query.set("page", String(options.page));
		if (options.limit) query.set("limit", String(options.limit));
		const suffix = query.toString() ? `?${query.toString()}` : "";
		return authedFetch<ApiMembersResponse>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/members${suffix}`,
		);
	},

	listInvitations: (getToken: FetchToken, orgId: string) =>
		authedFetch<{ invitations: ApiInvitation[]; codes: ApiInvitationCode[] }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/invitations`,
		),

	updateMemberRole: (
		getToken: FetchToken,
		orgId: string,
		membershipId: string,
		role: OrganizationRoleKey,
	) =>
		authedFetch<{ ok: true }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(membershipId)}`,
			{ method: "PATCH", body: JSON.stringify({ role }) },
		),

	removeMember: (getToken: FetchToken, orgId: string, membershipId: string) =>
		authedFetch<{ ok: true }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(membershipId)}`,
			{ method: "DELETE" },
		),

	createInvitationCode: (
		getToken: FetchToken,
		orgId: string,
		body: {
			label: string;
			role: OrganizationRoleKey;
			password?: string;
			emailDomain?: string | null;
			expiresAt?: number | null;
			guestExpiresAfterDays?: number | null;
		},
	) =>
		authedFetch<{ code: ApiCreatedInvitationCode }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/invitation-codes`,
			{ method: "POST", body: JSON.stringify(body) },
		),

	createInvitation: (
		getToken: FetchToken,
		orgId: string,
		body: { email: string; role: OrganizationRoleKey; ttlMs?: number },
	) =>
		authedFetch<{
			invitation: ApiInvitation & { organizationId: string; token: string };
		}>(getToken, `/orgs/${encodeURIComponent(orgId)}/invitations`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

	updateOrganizationSettings: (
		getToken: FetchToken,
		orgId: string,
		requireInvitationApproval: boolean,
	) =>
		authedFetch<{
			settings: { organizationId: string; requireInvitationApproval: boolean };
		}>(getToken, `/orgs/${encodeURIComponent(orgId)}/settings`, {
			method: "PATCH",
			body: JSON.stringify({ requireInvitationApproval }),
		}),

	listOrganizationRoles: (getToken: FetchToken, orgId: string) =>
		authedFetch<{
			permissions: OrganizationPermission[];
			roles: ApiOrganizationRole[];
		}>(getToken, `/orgs/${encodeURIComponent(orgId)}/roles`),

	updateOrganizationRole: (
		getToken: FetchToken,
		orgId: string,
		role: OrganizationRoleKey,
		permissions: OrganizationPermission[],
	) =>
		authedFetch<{ role: ApiOrganizationRole }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(role)}`,
			{ method: "PATCH", body: JSON.stringify({ permissions }) },
		),

	listJoinRequests: (getToken: FetchToken, orgId: string) =>
		authedFetch<{ requests: ApiJoinRequest[] }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/join-requests`,
		),

	reviewJoinRequest: (
		getToken: FetchToken,
		orgId: string,
		joinRequestId: string,
		decision: "approved" | "rejected",
	) =>
		authedFetch<{
			review: { requestId: string; status: "approved" | "rejected" };
		}>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/join-requests/${encodeURIComponent(joinRequestId)}/review`,
			{ method: "POST", body: JSON.stringify({ decision }) },
		),

	listActivityLogs: (
		getToken: FetchToken,
		orgId: string,
		options: {
			userId?: string;
			action?: string;
			from?: number;
			to?: number;
			page?: number;
			limit?: number;
		} = {},
	) => {
		const query = new URLSearchParams();
		if (options.userId) query.set("userId", options.userId);
		if (options.action) query.set("action", options.action);
		if (options.from) query.set("from", String(options.from));
		if (options.to) query.set("to", String(options.to));
		if (options.page) query.set("page", String(options.page));
		if (options.limit) query.set("limit", String(options.limit));
		const suffix = query.toString() ? `?${query.toString()}` : "";
		return authedFetch<{ logs: ApiActivityLog[]; page: number; limit: number }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/activity${suffix}`,
		);
	},

	setInvitationCodeLocked: (
		getToken: FetchToken,
		orgId: string,
		codeId: string,
		locked: boolean,
	) =>
		authedFetch<{ code: ApiInvitationCode }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/invitation-codes/${encodeURIComponent(codeId)}/lock`,
			{ method: "POST", body: JSON.stringify({ locked }) },
		),

	deleteInvitationCode: (getToken: FetchToken, orgId: string, codeId: string) =>
		authedFetch<{ ok: true }>(
			getToken,
			`/orgs/${encodeURIComponent(orgId)}/invitation-codes/${encodeURIComponent(codeId)}`,
			{ method: "DELETE" },
		),
};
