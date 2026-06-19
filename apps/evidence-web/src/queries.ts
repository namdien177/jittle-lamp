import {
	QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	type ApiAccountProfile,
	type ApiActivityLog,
	type ApiAiAccessToken,
	type ApiAutomationApiToken,
	type ApiCreateAiAccessTokenResponse,
	type ApiCreateAutomationApiTokenResponse,
	type ApiCreatedInvitationCode,
	type ApiEvidenceComment,
	type ApiEvidenceListResponse,
	type ApiEvidenceSummary,
	type ApiInvitation,
	type ApiInvitationCode,
	type ApiJoinRequest,
	type ApiMembersResponse,
	type ApiOrganization,
	type ApiOrganizationRole,
	type ApiOrgSummary,
	type ApiShareLinkSummary,
	type ArtifactReadUrl,
	api,
	type CreatedShareLink,
	type EvidenceArtifact,
	type FetchToken,
	type OrganizationPermission,
	type OrganizationRoleKey,
} from "./api";
import {
	clearCachedAiAccessTokenSecret,
	clearCachedInactiveAiAccessTokenSecrets,
} from "./ai-prompt";
import { useAuth } from "./auth";
import { type LoadedSession, loadRemoteSessionArtifacts } from "./loader";

export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 45_000,
				gcTime: 10 * 60_000,
				refetchOnWindowFocus: true,
				refetchOnReconnect: true,
				retry: (failureCount, error) => {
					const message = error instanceof Error ? error.message : "";
					if (message === "Sign in is required.") return false;
					if (
						message.includes("not authorized") ||
						message.includes("forbidden")
					)
						return false;
					return failureCount < 2;
				},
			},
			mutations: {
				retry: false,
			},
		},
	});
}

export const queryKeys = {
	accountProfile: () => ["account-profile"] as const,
	aiAccessTokens: () => ["ai-access-tokens"] as const,
	automationApiTokens: () => ["automation-api-tokens"] as const,
	organizations: () => ["organizations"] as const,
	organizationMembers: (
		orgId: string,
		options: {
			search?: string;
			role?: "all" | OrganizationRoleKey;
			page?: number;
			limit?: number;
		} = {},
	) =>
		[
			"organization-members",
			orgId,
			options.search?.trim() ?? "",
			options.role ?? "all",
			options.page ?? 1,
			options.limit ?? 20,
		] as const,
	organizationInvitations: (orgId: string) =>
		["organization-invitations", orgId] as const,
	organizationRoles: (orgId: string) => ["organization-roles", orgId] as const,
	organizationJoinRequests: (orgId: string) =>
		["organization-join-requests", orgId] as const,
	organizationActivity: (
		orgId: string,
		options: {
			userId?: string;
			action?: string;
			from?: number;
			to?: number;
			page?: number;
			limit?: number;
		} = {},
	) =>
		[
			"organization-activity",
			orgId,
			options.userId ?? "",
			options.action ?? "",
			options.from ?? "",
			options.to ?? "",
			options.page ?? 1,
			options.limit ?? 25,
		] as const,
	evidences: (
		options: {
			orgId?: string;
			createdBy?: string[];
			page?: number;
			limit?: number;
		} = {},
	) =>
		[
			"evidences",
			options.orgId ?? "active",
			options.createdBy?.join(",") ?? "",
			options.page ?? 1,
			options.limit ?? 24,
		] as const,
	evidenceArtifacts: (evidenceId: string, orgId: string | undefined) =>
		["evidence-artifacts", evidenceId, orgId ?? null] as const,
	evidenceComments: (evidenceId: string, orgId: string | undefined) =>
		["evidence-comments", evidenceId, orgId ?? null] as const,
	shareLinks: (evidenceId: string) => ["share-links", evidenceId] as const,
	remoteEvidence: (key: { shareToken?: string; remoteEvidenceId?: string }) =>
		[
			"remote-evidence",
			key.shareToken ?? null,
			key.remoteEvidenceId ?? null,
		] as const,
};

function useAuthToken(): FetchToken {
	const auth = useAuth();
	return () => auth.getToken();
}

export function useAccountProfile() {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<ApiAccountProfile>({
		queryKey: queryKeys.accountProfile(),
		queryFn: () => api.fetchAccountProfile(getToken),
		enabled: auth.isLoaded && Boolean(auth.isSignedIn),
	});
}

export function useAiAccessTokens() {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{ accessTokens: ApiAiAccessToken[] }>({
		queryKey: queryKeys.aiAccessTokens(),
		queryFn: async () => {
			const data = await api.listAiAccessTokens(getToken);
			clearCachedInactiveAiAccessTokenSecrets(data.accessTokens);
			return data;
		},
		enabled: auth.isLoaded && Boolean(auth.isSignedIn),
	});
}

export function useCreateAiAccessToken() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			label?: string;
			expiresInDays?: number;
			permanent?: boolean;
		}) => api.createAiAccessToken(getToken, input),
		onSuccess: (data: ApiCreateAiAccessTokenResponse) => {
			queryClient.setQueryData<{ accessTokens: ApiAiAccessToken[] }>(
				queryKeys.aiAccessTokens(),
				(current) => ({
					accessTokens: [
						data.accessToken,
						...(current?.accessTokens.filter(
							(token) => token.id !== data.accessToken.id,
						) ?? []),
					],
				}),
			);
		},
	});
}

export function useRevokeAiAccessToken() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (tokenId: string) => api.revokeAiAccessToken(getToken, tokenId),
		onSuccess: (data) => {
			clearCachedAiAccessTokenSecret(data.accessToken.id);
			queryClient.setQueryData<{ accessTokens: ApiAiAccessToken[] }>(
				queryKeys.aiAccessTokens(),
				(current) => ({
					accessTokens:
						current?.accessTokens.map((token) =>
							token.id === data.accessToken.id
								? { ...token, revokedAt: data.accessToken.revokedAt }
								: token,
						) ?? [],
				}),
			);
		},
	});
}

export function useAutomationApiTokens() {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{ apiTokens: ApiAutomationApiToken[] }>({
		queryKey: queryKeys.automationApiTokens(),
		queryFn: () => api.listAutomationApiTokens(getToken),
		enabled: auth.isLoaded && Boolean(auth.isSignedIn),
	});
}

export function useCreateAutomationApiToken() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			label?: string;
			orgId?: string;
			expiresInDays?: number;
			permanent?: boolean;
		}) => api.createAutomationApiToken(getToken, input),
		onSuccess: (data: ApiCreateAutomationApiTokenResponse) => {
			queryClient.setQueryData<{ apiTokens: ApiAutomationApiToken[] }>(
				queryKeys.automationApiTokens(),
				(current) => ({
					apiTokens: [
						data.apiToken,
						...(current?.apiTokens.filter(
							(token) => token.id !== data.apiToken.id,
						) ?? []),
					],
				}),
			);
		},
	});
}

export function useRevokeAutomationApiToken() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (tokenId: string) =>
			api.revokeAutomationApiToken(getToken, tokenId),
		onSuccess: (data) => {
			queryClient.setQueryData<{ apiTokens: ApiAutomationApiToken[] }>(
				queryKeys.automationApiTokens(),
				(current) => ({
					apiTokens:
						current?.apiTokens.map((token) =>
							token.id === data.apiToken.id
								? { ...token, revokedAt: data.apiToken.revokedAt }
								: token,
						) ?? [],
				}),
			);
		},
	});
}

export function useEvidences(
	options: {
		orgId?: string;
		createdBy?: string[];
		page?: number;
		limit?: number;
	} = {},
) {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<ApiEvidenceListResponse>({
		queryKey: queryKeys.evidences(options),
		queryFn: () => api.listEvidences(getToken, options),
		enabled: auth.isLoaded && Boolean(auth.isSignedIn),
	});
}

export function useDeleteEvidence() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (evidenceId: string) =>
			api.deleteEvidence(getToken, evidenceId),
		onSuccess: (_data, evidenceId) => {
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
			queryClient.removeQueries({
				queryKey: queryKeys.remoteEvidence({ remoteEvidenceId: evidenceId }),
			});
		},
	});
}

export function useBulkDeleteEvidences() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (evidenceIds: string[]) =>
			api.bulkDeleteEvidences(getToken, evidenceIds),
		onSuccess: (_data, evidenceIds) => {
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
			for (const evidenceId of evidenceIds) {
				queryClient.removeQueries({
					queryKey: queryKeys.remoteEvidence({ remoteEvidenceId: evidenceId }),
				});
			}
		},
	});
}

export function useRenameEvidence() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { evidenceId: string; title: string }) =>
			api.renameEvidence(getToken, input.evidenceId, input.title),
		onSuccess: (data, input) => {
			const updatedAt = data.evidence.updatedAt;
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.remoteEvidence({
					remoteEvidenceId: input.evidenceId,
				}),
			});
		},
	});
}

export function useCopyEvidence() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { evidenceId: string; targetOrgId: string }) =>
			api.copyEvidence(getToken, input.evidenceId, input.targetOrgId),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationActivity(data.copy.fromOrgId),
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationActivity(data.copy.toOrgId),
			});
		},
	});
}

export function useMoveEvidence() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { evidenceId: string; targetOrgId: string }) =>
			api.moveEvidence(getToken, input.evidenceId, input.targetOrgId),
		onSuccess: (data, input) => {
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
			queryClient.removeQueries({
				queryKey: queryKeys.remoteEvidence({
					remoteEvidenceId: input.evidenceId,
				}),
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationActivity(data.move.fromOrgId),
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationActivity(data.move.toOrgId),
			});
		},
	});
}

export function useEvidenceComments(evidenceId: string | null, orgId?: string) {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{ comments: ApiEvidenceComment[] }>({
		queryKey: queryKeys.evidenceComments(evidenceId ?? "none", orgId),
		queryFn: () => api.listEvidenceComments(getToken, evidenceId ?? "", orgId),
		enabled: auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(evidenceId),
	});
}

export function useCreateEvidenceComment() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { evidenceId: string; body: string; orgId?: string }) =>
			api.createEvidenceComment(
				getToken,
				input.evidenceId,
				input.body,
				input.orgId,
			),
		onSuccess: (_data, input) => {
			return queryClient.invalidateQueries({
				queryKey: queryKeys.evidenceComments(input.evidenceId, input.orgId),
			});
		},
	});
}

export function useShareLinks(evidenceId: string | null) {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{ shareLinks: ApiShareLinkSummary[] }>({
		queryKey: queryKeys.shareLinks(evidenceId ?? "none"),
		queryFn: () => api.listShareLinks(getToken, evidenceId ?? ""),
		enabled: auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(evidenceId),
	});
}

export function useCreateShareLink() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { evidenceId: string; expiresInMs?: number }) =>
			api.createShareLink(getToken, input.evidenceId, input.expiresInMs),
		onSuccess: (_data: { shareLink: CreatedShareLink }, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.shareLinks(input.evidenceId),
			});
		},
	});
}

export function useRevokeShareLink() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { shareLinkId: string; evidenceId: string }) =>
			api.revokeShareLink(getToken, input.shareLinkId),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.shareLinks(input.evidenceId),
			});
		},
	});
}

export function useSelectActiveOrganization() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (orgId: string) =>
			api.selectActiveOrganization(getToken, orgId),
		onSuccess: (_data, orgId) => {
			queryClient.setQueryData<ApiAccountProfile | undefined>(
				queryKeys.accountProfile(),
				(prev) =>
					prev
						? {
								...prev,
								activeOrgId: orgId,
								organizations: prev.organizations.map((org) => ({
									...org,
									isActive: org.id === orgId,
								})),
							}
						: prev,
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
		},
	});
}

export function useAcceptInvitation() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { token: string; password?: string }) =>
			api.acceptInvitationWithPassword(getToken, input.token, input.password),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accountProfile() });
			queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
		},
	});
}

export function useOrganizations() {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{ organizations: ApiOrgSummary[] }>({
		queryKey: queryKeys.organizations(),
		queryFn: () => api.listOrganizations(getToken),
		enabled: auth.isLoaded && Boolean(auth.isSignedIn),
	});
}

export function useCreateOrganization() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api.createOrganization(getToken, name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
			queryClient.invalidateQueries({ queryKey: queryKeys.accountProfile() });
		},
	});
}

export function useLeaveOrganization() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (orgId: string) => api.leaveOrganization(getToken, orgId),
		onSuccess: (_data, orgId) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
			queryClient.invalidateQueries({ queryKey: queryKeys.accountProfile() });
			queryClient.removeQueries({ queryKey: ["organization-members", orgId] });
			queryClient.removeQueries({
				queryKey: queryKeys.organizationInvitations(orgId),
			});
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
		},
	});
}

export function useDeleteOrganization() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (orgId: string) => api.deleteOrganization(getToken, orgId),
		onSuccess: (_data, orgId) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
			queryClient.invalidateQueries({ queryKey: queryKeys.accountProfile() });
			queryClient.removeQueries({ queryKey: ["organization-members", orgId] });
			queryClient.removeQueries({
				queryKey: queryKeys.organizationInvitations(orgId),
			});
			queryClient.removeQueries({
				queryKey: queryKeys.organizationActivity(orgId),
			});
			queryClient.invalidateQueries({ queryKey: ["evidences"] });
		},
	});
}

export function useOrganizationMembers(
	orgId: string | null,
	options: {
		search?: string;
		role?: "all" | OrganizationRoleKey;
		page?: number;
		limit?: number;
	} = {},
) {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<ApiMembersResponse>({
		queryKey: queryKeys.organizationMembers(orgId ?? "none", options),
		queryFn: () => api.listMembers(getToken, orgId ?? "", options),
		enabled: auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(orgId),
	});
}

export function useUpdateMemberRole() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			orgId: string;
			membershipId: string;
			role: OrganizationRoleKey;
		}) =>
			api.updateMemberRole(
				getToken,
				input.orgId,
				input.membershipId,
				input.role,
			),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({
				queryKey: ["organization-members", input.orgId],
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
		},
	});
}

export function useRemoveMember() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { orgId: string; membershipId: string }) =>
			api.removeMember(getToken, input.orgId, input.membershipId),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({
				queryKey: ["organization-members", input.orgId],
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
			queryClient.invalidateQueries({ queryKey: queryKeys.accountProfile() });
		},
	});
}

export function useOrganizationInvitations(
	orgId: string | null,
	enabled: boolean,
) {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{ invitations: ApiInvitation[]; codes: ApiInvitationCode[] }>(
		{
			queryKey: queryKeys.organizationInvitations(orgId ?? "none"),
			queryFn: () => api.listInvitations(getToken, orgId ?? ""),
			enabled:
				auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(orgId) && enabled,
		},
	);
}

export function useCreateInvitationCode() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			orgId: string;
			body: {
				label: string;
				role: OrganizationRoleKey;
				password?: string;
				emailDomain?: string | null;
				expiresAt?: number | null;
				guestExpiresAfterDays?: number | null;
			};
		}) => api.createInvitationCode(getToken, input.orgId, input.body),
		onSuccess: (_data: { code: ApiCreatedInvitationCode }, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationInvitations(input.orgId),
			});
		},
	});
}

export function useCreateInvitation() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			orgId: string;
			body: { email: string; role: OrganizationRoleKey; ttlMs?: number };
		}) => api.createInvitation(getToken, input.orgId, input.body),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationInvitations(input.orgId),
			});
		},
	});
}

export function useUpdateOrganizationSettings() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			orgId: string;
			requireInvitationApproval: boolean;
		}) =>
			api.updateOrganizationSettings(
				getToken,
				input.orgId,
				input.requireInvitationApproval,
			),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
			queryClient.invalidateQueries({ queryKey: queryKeys.accountProfile() });
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationActivity(input.orgId),
			});
		},
	});
}

export function useOrganizationRoles(orgId: string | null) {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{
		permissions: OrganizationPermission[];
		roles: ApiOrganizationRole[];
	}>({
		queryKey: queryKeys.organizationRoles(orgId ?? "none"),
		queryFn: () => api.listOrganizationRoles(getToken, orgId ?? ""),
		enabled: auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(orgId),
	});
}

type OrganizationRolesQueryData = {
	permissions: OrganizationPermission[];
	roles: ApiOrganizationRole[];
};

export function useUpdateOrganizationRole() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			orgId: string;
			role: OrganizationRoleKey;
			permissions: OrganizationPermission[];
		}) =>
			api.updateOrganizationRole(
				getToken,
				input.orgId,
				input.role,
				input.permissions,
			),
		onMutate: async (input) => {
			const queryKey = queryKeys.organizationRoles(input.orgId);
			await queryClient.cancelQueries({ queryKey });
			const previous =
				queryClient.getQueryData<OrganizationRolesQueryData>(queryKey);

			queryClient.setQueryData<OrganizationRolesQueryData>(
				queryKey,
				(current) =>
					current
						? {
								...current,
								roles: current.roles.map((role) =>
									role.key === input.role
										? {
												...role,
												permissions: input.permissions,
												updatedAt: Date.now(),
											}
										: role,
								),
							}
						: current,
			);

			return { previous };
		},
		onError: (_error, input, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					queryKeys.organizationRoles(input.orgId),
					context.previous,
				);
			}
		},
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationActivity(input.orgId),
			});
		},
		onSettled: (_data, _error, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationRoles(input.orgId),
			});
		},
	});
}

export function useOrganizationJoinRequests(
	orgId: string | null,
	enabled = true,
) {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{ requests: ApiJoinRequest[] }>({
		queryKey: queryKeys.organizationJoinRequests(orgId ?? "none"),
		queryFn: () => api.listJoinRequests(getToken, orgId ?? ""),
		enabled:
			auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(orgId) && enabled,
	});
}

export function useReviewJoinRequest() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			orgId: string;
			joinRequestId: string;
			decision: "approved" | "rejected";
		}) =>
			api.reviewJoinRequest(
				getToken,
				input.orgId,
				input.joinRequestId,
				input.decision,
			),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationJoinRequests(input.orgId),
			});
			queryClient.invalidateQueries({
				queryKey: ["organization-members", input.orgId],
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationActivity(input.orgId),
			});
		},
	});
}

export function useOrganizationActivity(
	orgId: string | null,
	options: {
		userId?: string;
		action?: string;
		from?: number;
		to?: number;
		page?: number;
		limit?: number;
	} = {},
	enabled = true,
) {
	const auth = useAuth();
	const getToken = useAuthToken();
	return useQuery<{ logs: ApiActivityLog[]; page: number; limit: number }>({
		queryKey: queryKeys.organizationActivity(orgId ?? "none", options),
		queryFn: () => api.listActivityLogs(getToken, orgId ?? "", options),
		enabled:
			auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(orgId) && enabled,
	});
}

export function useSetInvitationCodeLocked() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { orgId: string; codeId: string; locked: boolean }) =>
			api.setInvitationCodeLocked(
				getToken,
				input.orgId,
				input.codeId,
				input.locked,
			),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationInvitations(input.orgId),
			});
		},
	});
}

export function useDeleteInvitationCode() {
	const getToken = useAuthToken();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { orgId: string; codeId: string }) =>
			api.deleteInvitationCode(getToken, input.orgId, input.codeId),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.organizationInvitations(input.orgId),
			});
		},
	});
}

export type RemoteEvidenceData = {
	session: LoadedSession;
	evidence: ApiEvidenceSummary;
	evidenceId: string;
	shareSlug: string | null;
	orgId: string | undefined;
	recordingArtifact: EvidenceArtifact;
	videoArtifact: EvidenceArtifact;
	archiveArtifact: EvidenceArtifact;
	videoReadUrl: ArtifactReadUrl;
	archiveReadUrl: ArtifactReadUrl;
};

export type RemoteEvidenceResult =
	| { kind: "loaded"; data: RemoteEvidenceData }
	| { kind: "restricted"; orgName: string };

function shouldBufferRemoteVideoForPlayback(): boolean {
	if (typeof navigator === "undefined") return false;
	return /\bFirefox\//.test(navigator.userAgent);
}

function isPlaybackRecordingArtifact(artifact: EvidenceArtifact): boolean {
	return (
		artifact.kind === "recording" &&
		artifact.uploadStatus === "uploaded" &&
		(artifact.mimeType === "video/mp4" ||
			artifact.mimeType === "application/x-mpegURL" ||
			artifact.mimeType === "application/vnd.apple.mpegurl")
	);
}

function isOriginalRecordingArtifact(artifact: EvidenceArtifact): boolean {
	return (
		artifact.kind === "recording" &&
		artifact.uploadStatus === "uploaded" &&
		artifact.mimeType === "video/webm"
	);
}

function selectEvidenceVideoArtifact(artifacts: EvidenceArtifact[]): {
	recordingArtifact: EvidenceArtifact | undefined;
	videoArtifact: EvidenceArtifact | undefined;
} {
	const recordingArtifact = artifacts.find(isOriginalRecordingArtifact);
	const videoArtifact =
		artifacts.find(isPlaybackRecordingArtifact) ??
		recordingArtifact ??
		artifacts.find(
			(artifact) =>
				artifact.kind === "recording" && artifact.uploadStatus === "uploaded",
		);

	return { recordingArtifact, videoArtifact };
}

async function fetchRemoteEvidence(
	getToken: FetchToken,
	locator: { shareToken?: string; remoteEvidenceId?: string },
	signal?: AbortSignal,
): Promise<RemoteEvidenceResult> {
	let evidenceId: string;
	let shareSlug: string | null = null;
	let orgId: string | undefined;
	if (locator.shareToken) {
		const resolved = await api.resolveShareLink(getToken, locator.shareToken);
		if (resolved.shareLink.access === "denied") {
			return { kind: "restricted", orgName: resolved.organization.name };
		}
		evidenceId = resolved.shareLink.evidenceId;
		shareSlug = resolved.shareLink.slug;
		orgId = resolved.shareLink.orgId;
	} else if (locator.remoteEvidenceId) {
		evidenceId = locator.remoteEvidenceId;
	} else {
		throw new Error("No evidence locator provided.");
	}

	const artifactResult = await api.listEvidenceArtifacts(
		getToken,
		evidenceId,
		orgId,
	);
	const { recordingArtifact, videoArtifact } = selectEvidenceVideoArtifact(
		artifactResult.artifacts,
	);
	const archiveArtifact = artifactResult.artifacts.find(
		(artifact) =>
			artifact.kind === "network-log" && artifact.uploadStatus === "uploaded",
	);
	if (!videoArtifact || !archiveArtifact) {
		throw new Error("Evidence is missing recording or archive artifacts.");
	}

	const [videoReadUrl, archiveReadUrl] = await Promise.all([
		api.createArtifactReadUrl(getToken, evidenceId, videoArtifact.id, orgId),
		api.createArtifactReadUrl(getToken, evidenceId, archiveArtifact.id, orgId),
	]);
	const evidenceResult = await api.loadEvidence(getToken, evidenceId, orgId);
	const session = await loadRemoteSessionArtifacts({
		archiveUrl: archiveReadUrl.url,
		videoUrl: videoReadUrl.url,
		videoMimeType: videoArtifact.mimeType,
		bufferVideo:
			videoArtifact.mimeType === "video/webm" &&
			shouldBufferRemoteVideoForPlayback(),
		...(signal ? { signal } : {}),
	});

	return {
		kind: "loaded",
		data: {
			session,
			evidence: evidenceResult.evidence,
			evidenceId,
			shareSlug,
			orgId,
			recordingArtifact: recordingArtifact ?? videoArtifact,
			videoArtifact,
			archiveArtifact,
			videoReadUrl,
			archiveReadUrl,
		},
	};
}

export function useRemoteEvidence(locator: {
	shareToken?: string;
	remoteEvidenceId?: string;
}) {
	const auth = useAuth();
	const getToken = useAuthToken();
	const enabled =
		auth.isLoaded &&
		Boolean(auth.isSignedIn) &&
		Boolean(locator.shareToken || locator.remoteEvidenceId);
	return useQuery<RemoteEvidenceResult>({
		queryKey: queryKeys.remoteEvidence(locator),
		queryFn: ({ signal }) => fetchRemoteEvidence(getToken, locator, signal),
		enabled,
		staleTime: Infinity,
		gcTime: 5 * 60_000,
		retry: 0,
	});
}

export type { ApiOrganization };
