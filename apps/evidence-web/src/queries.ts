import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/clerk-react";

import {
  api,
  type ApiAccountProfile,
  type ApiEvidenceListResponse,
  type ApiEvidenceSummary,
  type ApiOrganization,
  type ApiShareLinkSummary,
  type ArtifactReadUrl,
  type CreatedShareLink,
  type EvidenceArtifact,
  type FetchToken
} from "./api";
import { loadRemoteSessionArtifacts, type LoadedSession } from "./loader";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1
      }
    }
  });
}

export const queryKeys = {
  accountProfile: () => ["account-profile"] as const,
  organizations: () => ["organizations"] as const,
  organizationMembers: (orgId: string) => ["organization-members", orgId] as const,
  organizationInvitations: (orgId: string) => ["organization-invitations", orgId] as const,
  evidences: (options: { createdBy?: string[]; page?: number; limit?: number } = {}) =>
    ["evidences", options.createdBy?.join(",") ?? "", options.page ?? 1, options.limit ?? 24] as const,
  evidenceArtifacts: (evidenceId: string, orgId: string | undefined) =>
    ["evidence-artifacts", evidenceId, orgId ?? null] as const,
  shareLinks: (evidenceId: string) => ["share-links", evidenceId] as const,
  remoteEvidence: (key: { shareToken?: string; remoteEvidenceId?: string }) =>
    ["remote-evidence", key.shareToken ?? null, key.remoteEvidenceId ?? null] as const
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
    enabled: auth.isLoaded && Boolean(auth.isSignedIn)
  });
}

export function useEvidences(options: { createdBy?: string[]; page?: number; limit?: number } = {}) {
  const auth = useAuth();
  const getToken = useAuthToken();
  return useQuery<ApiEvidenceListResponse>({
    queryKey: queryKeys.evidences(options),
    queryFn: () => api.listEvidences(getToken, options),
    enabled: auth.isLoaded && Boolean(auth.isSignedIn)
  });
}

export function useDeleteEvidence() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (evidenceId: string) => api.deleteEvidence(getToken, evidenceId),
    onSuccess: (_data, evidenceId) => {
      queryClient.invalidateQueries({ queryKey: ["evidences"] });
      queryClient.removeQueries({ queryKey: queryKeys.remoteEvidence({ remoteEvidenceId: evidenceId }) });
    }
  });
}

export function useBulkDeleteEvidences() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (evidenceIds: string[]) => api.bulkDeleteEvidences(getToken, evidenceIds),
    onSuccess: (_data, evidenceIds) => {
      queryClient.invalidateQueries({ queryKey: ["evidences"] });
      for (const evidenceId of evidenceIds) {
        queryClient.removeQueries({ queryKey: queryKeys.remoteEvidence({ remoteEvidenceId: evidenceId }) });
      }
    }
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
        queryKey: queryKeys.remoteEvidence({ remoteEvidenceId: input.evidenceId })
      });
    }
  });
}

export function useShareLinks(evidenceId: string | null) {
  const auth = useAuth();
  const getToken = useAuthToken();
  return useQuery<{ shareLinks: ApiShareLinkSummary[] }>({
    queryKey: queryKeys.shareLinks(evidenceId ?? "none"),
    queryFn: () => api.listShareLinks(getToken, evidenceId ?? ""),
    enabled: auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(evidenceId)
  });
}

export function useCreateShareLink() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { evidenceId: string; expiresInMs?: number }) =>
      api.createShareLink(getToken, input.evidenceId, input.expiresInMs),
    onSuccess: (_data: { shareLink: CreatedShareLink }, input) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(input.evidenceId) });
    }
  });
}

export function useRevokeShareLink() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { shareLinkId: string; evidenceId: string }) =>
      api.revokeShareLink(getToken, input.shareLinkId),
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(input.evidenceId) });
    }
  });
}

export function useSelectActiveOrganization() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orgId: string) => api.selectActiveOrganization(getToken, orgId),
    onSuccess: (_data, orgId) => {
      queryClient.setQueryData<ApiAccountProfile | undefined>(queryKeys.accountProfile(), (prev) =>
        prev
          ? { ...prev, organizations: prev.organizations.map((org) => ({ ...org, isActive: org.id === orgId })) }
          : prev
      );
      queryClient.invalidateQueries({ queryKey: ["evidences"] });
    }
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
      queryClient.invalidateQueries({ queryKey: ["evidences"] });
    }
  });
}

export function useOrganizations() {
  const auth = useAuth();
  const getToken = useAuthToken();
  return useQuery({
    queryKey: queryKeys.organizations(),
    queryFn: () => api.listOrganizations(getToken),
    enabled: auth.isLoaded && Boolean(auth.isSignedIn)
  });
}

export function useOrganizationMembers(
  orgId: string | null,
  options: { search?: string; role?: "all" | "owner" | "moderator" | "member"; page?: number; limit?: number } = {}
) {
  const auth = useAuth();
  const getToken = useAuthToken();
  return useQuery({
    queryKey: [...queryKeys.organizationMembers(orgId ?? "none"), options.search ?? "", options.role ?? "all", options.page ?? 1, options.limit ?? 20],
    queryFn: () => api.listMembers(getToken, orgId ?? "", options),
    enabled: auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(orgId)
  });
}

export function useOrganizationInvitations(orgId: string | null, enabled: boolean) {
  const auth = useAuth();
  const getToken = useAuthToken();
  return useQuery({
    queryKey: queryKeys.organizationInvitations(orgId ?? "none"),
    queryFn: () => api.listInvitations(getToken, orgId ?? ""),
    enabled: auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(orgId) && enabled
  });
}

export type RemoteEvidenceData = {
  session: LoadedSession;
  evidenceId: string;
  orgId: string | undefined;
  recordingArtifact: EvidenceArtifact;
  archiveArtifact: EvidenceArtifact;
  videoReadUrl: ArtifactReadUrl;
  archiveReadUrl: ArtifactReadUrl;
};

export type RemoteEvidenceResult =
  | { kind: "loaded"; data: RemoteEvidenceData }
  | { kind: "restricted"; orgName: string };

async function fetchRemoteEvidence(
  getToken: FetchToken,
  locator: { shareToken?: string; remoteEvidenceId?: string }
): Promise<RemoteEvidenceResult> {
  let evidenceId: string;
  let orgId: string | undefined;
  if (locator.shareToken) {
    const resolved = await api.resolveShareLink(getToken, locator.shareToken);
    if (resolved.shareLink.access === "denied") {
      return { kind: "restricted", orgName: resolved.organization.name };
    }
    evidenceId = resolved.shareLink.evidenceId;
    orgId = resolved.shareLink.orgId;
  } else if (locator.remoteEvidenceId) {
    evidenceId = locator.remoteEvidenceId;
  } else {
    throw new Error("No evidence locator provided.");
  }

  const artifactResult = await api.listEvidenceArtifacts(getToken, evidenceId, orgId);
  const recordingArtifact = artifactResult.artifacts.find((artifact) => artifact.kind === "recording");
  const archiveArtifact = artifactResult.artifacts.find((artifact) => artifact.kind === "network-log");
  if (!recordingArtifact || !archiveArtifact) {
    throw new Error("Evidence is missing recording or archive artifacts.");
  }

  const [videoReadUrl, archiveReadUrl] = await Promise.all([
    api.createArtifactReadUrl(getToken, evidenceId, recordingArtifact.id, orgId),
    api.createArtifactReadUrl(getToken, evidenceId, archiveArtifact.id, orgId)
  ]);
  const session = await loadRemoteSessionArtifacts({
    archiveUrl: archiveReadUrl.url,
    videoUrl: videoReadUrl.url
  });

  return {
    kind: "loaded",
    data: { session, evidenceId, orgId, recordingArtifact, archiveArtifact, videoReadUrl, archiveReadUrl }
  };
}

export function useRemoteEvidence(locator: { shareToken?: string; remoteEvidenceId?: string }) {
  const auth = useAuth();
  const getToken = useAuthToken();
  const enabled =
    auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(locator.shareToken || locator.remoteEvidenceId);
  return useQuery<RemoteEvidenceResult>({
    queryKey: queryKeys.remoteEvidence(locator),
    queryFn: () => fetchRemoteEvidence(getToken, locator),
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: 0
  });
}

export type { ApiOrganization };
