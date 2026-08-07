import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import {
  buildTargetEvidenceLlmPrompt,
  cacheAiAccessTokenSecret,
  clearCachedInactiveAiAccessTokenSecrets,
  readCachedActivePermanentAiAccessTokenSecret
} from "../ai-prompt";
import { useAuth } from "../auth";
import { api, type ApiAiAccessToken, type ApiEvidenceSummary, type ApiOrganization, type ArtifactReadUrl, type FetchToken } from "../api";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { StatusScreen } from "../components/status-screen";
import { RequireAuth } from "../components/workspace/require-auth";
import { EvidenceViewerContent } from "../evidence-viewer-content";
import {
  useAccountProfile,
  useAiAccessTokens,
  useCopyEvidence,
  useCreateAiAccessToken,
  useCreateEvidenceComment,
  useEvidenceComments,
  useEvidenceTags,
  useMoveEvidence,
  useRenameEvidence,
  useRemoteEvidence,
  useShareLinkResolution,
  useUpdateEvidenceTags,
  type RemoteEvidenceData
} from "../queries";
import { useToast } from "../toast";
import { copyToClipboard } from "../utils";

const evidenceTitlePrefix = "Jittle Lamp";
const evidenceTitleMaxLength = 80;
const permanentAiTokenLabel = "AI evidence debugger";

function formatEvidenceDocumentTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, " ");
  if (!trimmed) return `${evidenceTitlePrefix} | Evidence`;
  const suffix =
    trimmed.length > evidenceTitleMaxLength
      ? `${trimmed.slice(0, evidenceTitleMaxLength - 1).trimEnd()}…`
      : trimmed;
  return `${evidenceTitlePrefix} | ${suffix}`;
}

function latestActivePermanentAiToken(tokens: ApiAiAccessToken[]): ApiAiAccessToken | null {
  const now = Date.now();
  return (
    tokens
      .filter((token) => token.revokedAt === null)
      .filter((token) => token.expiresAt === null || token.expiresAt > now)
      .filter((token) => token.expiresAt === null)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  );
}

function latestVisiblePermanentAiTokenSecret(tokens: ApiAiAccessToken[]): string | null {
  return latestActivePermanentAiToken(tokens.filter((token) => token.token !== null))?.token ?? null;
}

function RestrictedShareScreen({ orgName }: { orgName: string }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <StatusScreen
      tone="error"
      title="Evidence is restricted"
      detail={
        <>
          This evidence is only available to members of <strong>{orgName}</strong>. Ask an owner to
          invite you, then reload this page.
        </>
      }
    >
      <Button
        onClick={() => {
          const here = window.location.pathname + window.location.search;
          navigate(`/join?redirect=${encodeURIComponent(here)}`);
        }}
      >
        I have a code
      </Button>
    </StatusScreen>
  );
}

function useRenewArtifactUrls(input: {
  enabled: boolean;
  loaded: RemoteEvidenceData | null;
  getToken: FetchToken;
  onRenewed: (urls: { videoReadUrl: ArtifactReadUrl; archiveReadUrl: ArtifactReadUrl }) => void;
}): void {
  const { enabled, loaded, getToken, onRenewed } = input;
  const onRenewedRef = useRef(onRenewed);
  onRenewedRef.current = onRenewed;

  useEffect(() => {
    if (!enabled || !loaded) return;
    let cancelled = false;
    const renew = async (): Promise<void> => {
      try {
        const [videoReadUrl, archiveReadUrl] = await Promise.all([
          api.createArtifactReadUrl(getToken, loaded.evidenceId, loaded.videoArtifact.id, loaded.orgId),
          api.createArtifactReadUrl(getToken, loaded.evidenceId, loaded.archiveArtifact.id, loaded.orgId)
        ]);
        if (cancelled) return;
        onRenewedRef.current({ videoReadUrl, archiveReadUrl });
      } catch {
        // Non-fatal; the next attempt or a video error will recover.
      }
    };
    const delay = Math.max(30_000, loaded.videoReadUrl.renewAfterMs);
    const timer = window.setInterval(() => void renew(), delay);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, loaded, getToken]);
}

function RemoteEvidenceLoader(props: {
  shareToken?: string;
  remoteEvidenceId?: string;
  remoteOrgId?: string | undefined;
  viewerMode?: "modal" | "page";
}): React.JSX.Element {
  const navigate = useNavigate();
  const auth = useAuth();
  const toast = useToast();
  const query = useRemoteEvidence({
    ...(props.shareToken !== undefined ? { shareToken: props.shareToken } : {}),
    ...(props.remoteEvidenceId !== undefined ? { remoteEvidenceId: props.remoteEvidenceId } : {}),
    ...(props.remoteOrgId !== undefined ? { orgId: props.remoteOrgId } : {})
  });
  const accountQuery = useAccountProfile();
  const aiTokensQuery = useAiAccessTokens();

  const stableGetToken: FetchToken = useRef(() => auth.getToken()).current;
  const latestUrlsRef = useRef<{ videoReadUrl: ArtifactReadUrl; archiveReadUrl: ArtifactReadUrl } | null>(null);
  const loaded: RemoteEvidenceData | null = query.data?.kind === "loaded" ? query.data.data : null;
  const [commentDraft, setCommentDraft] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [workspaceAction, setWorkspaceAction] = useState<"copy" | "transfer" | null>(null);
  const commentsQuery = useEvidenceComments(loaded?.evidenceId ?? null, loaded?.orgId);
  const tagsQuery = useEvidenceTags(loaded?.orgId);
  const createAiToken = useCreateAiAccessToken();
  const createComment = useCreateEvidenceComment();
  const updateTags = useUpdateEvidenceTags();
  const renameEvidence = useRenameEvidence();

  if (loaded) {
    latestUrlsRef.current = { videoReadUrl: loaded.videoReadUrl, archiveReadUrl: loaded.archiveReadUrl };
  }

  useEffect(() => {
    if (!loaded) return;
    const previousTitle = document.title;
    document.title = formatEvidenceDocumentTitle(loaded.evidence.title || loaded.session.archive.name);
    return () => {
      document.title = previousTitle;
    };
  }, [loaded]);

  useRenewArtifactUrls({
    enabled: Boolean(loaded && auth.isSignedIn),
    loaded,
    getToken: stableGetToken,
    onRenewed: (urls) => {
      latestUrlsRef.current = urls;
    }
  });

  if (auth.isLoaded && !auth.isSignedIn) {
    return <StatusScreen title="Sign in required" detail="Sign in to view this evidence." />;
  }
  if (query.isPending || !auth.isLoaded) {
    return (
      <StatusScreen
        loading
        title="Loading evidence"
        detail={props.shareToken ? "Validating the share link…" : "Fetching evidence artifacts…"}
      />
    );
  }
  if (query.isError) {
    return (
      <StatusScreen
        tone="error"
        title="Unable to load evidence"
        detail={query.error instanceof Error ? query.error.message : "Unknown error"}
      />
    );
  }
  if (query.data?.kind === "restricted") {
    return <RestrictedShareScreen orgName={query.data.orgName} />;
  }
  if (!loaded) return <StatusScreen loading title="Loading evidence" />;

  const shareLinkUrl = loaded.shareSlug
    ? `${window.location.origin}/share/${encodeURIComponent(loaded.shareSlug)}`
    : null;
  const currentUserId = accountQuery.data?.localUserId ?? accountQuery.data?.userId ?? null;
  const canRenameEvidence =
    !props.shareToken &&
    currentUserId !== null &&
    (loaded.evidence.createdBy === currentUserId ||
      accountQuery.data?.organizations.some(
        (org) =>
          org.id === loaded.evidence.orgId &&
          (org.role === "owner" || org.role === "admin" || org.role === "moderator"),
      ) === true);
  const canCopyEvidence = !props.shareToken;
  const canCopyLlmPrompt = !props.shareToken;
  const canTransferEvidence =
    !props.shareToken && currentUserId !== null && loaded.evidence.createdBy === currentUserId;
  const canUpdateEvidenceTags =
    !props.shareToken &&
    accountQuery.data?.organizations.some(
      (org) =>
        org.id === loaded.evidence.orgId &&
        (org.role === "owner" || org.role === "admin" || org.role === "moderator"),
    ) === true;

  const openRenameDialog = (): void => {
    setRenameValue(loaded.evidence.title || loaded.session.archive.name);
    setRenameOpen(true);
  };

  const submitRename = (): void => {
    const title = renameValue.trim();
    if (title.length === 0 || title === loaded.evidence.title) {
      setRenameOpen(false);
      return;
    }
    renameEvidence.mutate(
      { evidenceId: loaded.evidenceId, title },
      {
        onSuccess: () => {
          toast.success("Evidence renamed", title);
          setRenameOpen(false);
        },
        onError: (error) =>
          toast.error(
            "Rename failed",
            error instanceof Error ? error.message : undefined,
          ),
      },
    );
  };

  const fetchVideoBytes = async (): Promise<Uint8Array | null> => {
    let url = latestUrlsRef.current?.videoReadUrl.url ?? loaded.videoReadUrl.url;
    if (loaded.recordingArtifact.id !== loaded.videoArtifact.id) {
      try {
        url = (
          await api.createArtifactReadUrl(
            stableGetToken,
            loaded.evidenceId,
            loaded.recordingArtifact.id,
            loaded.orgId
          )
        ).url;
      } catch {
        return null;
      }
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch recording (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
  };

  const handleVideoError = (videoEl: HTMLVideoElement): void => {
    const latest = latestUrlsRef.current;
    if (!latest) return;
    if (videoEl.src === latest.videoReadUrl.url) return;
    const currentTime = videoEl.currentTime;
    const wasPaused = videoEl.paused;
    videoEl.src = latest.videoReadUrl.url;
    videoEl.load();
    videoEl.currentTime = currentTime;
    if (!wasPaused) void videoEl.play().catch(() => undefined);
  };

  const submitComment = async (): Promise<void> => {
    const body = commentDraft.trim();
    if (!body || createComment.isPending) return;
    try {
      await createComment.mutateAsync({
        evidenceId: loaded.evidenceId,
        body,
        ...(loaded.orgId ? { orgId: loaded.orgId } : {})
      });
      setCommentDraft("");
    } catch {
      // The mutation state drives the inline discussion notice.
    }
  };

  const updateEvidenceTags = (tagIds: string[]): void => {
    updateTags.mutate(
      { evidenceId: loaded.evidenceId, tagIds },
      {
        onSuccess: () => toast.success("Tags updated", loaded.evidence.title),
        onError: (error) =>
          toast.error(
            "Unable to update tags",
            error instanceof Error ? error.message : undefined,
          ),
      },
    );
  };

  const copyLlmPrompt = async (): Promise<void> => {
    if (createAiToken.isPending) return;
    try {
      const tokenResult = await aiTokensQuery.refetch();
      const accessTokens = tokenResult.data?.accessTokens ?? [];
      clearCachedInactiveAiAccessTokenSecrets(accessTokens);
      let token =
        latestVisiblePermanentAiTokenSecret(accessTokens) ??
        readCachedActivePermanentAiAccessTokenSecret(accessTokens);

      if (!token) {
        const payload = await createAiToken.mutateAsync({
          label: permanentAiTokenLabel,
          permanent: true
        });
        token = payload.accessToken.token ?? payload.token;
        cacheAiAccessTokenSecret(payload.accessToken.id, payload.token);
      }

      await copyToClipboard(
        buildTargetEvidenceLlmPrompt({
          token,
          evidenceId: loaded.evidenceId,
          evidenceUrl: `${window.location.origin}/evidence/${encodeURIComponent(loaded.evidenceId)}`,
          title: loaded.evidence.title || loaded.session.archive.name,
          ...(loaded.orgId ? { orgId: loaded.orgId } : {})
        })
      );
      toast.success("LLM prompt copied", "Paste it into your AI chat to investigate this evidence.");
    } catch (error) {
      toast.error(
        "Unable to copy LLM prompt",
        error instanceof Error ? error.message : undefined,
      );
    }
  };

  const comments = (commentsQuery.data?.comments ?? []).map((comment) => ({
    id: comment.id,
    body: comment.body,
    authorLabel: comment.authorLabel,
    createdAt: comment.createdAt
  }));

  const discussionNotice =
    commentsQuery.isError
      ? commentsQuery.error instanceof Error
        ? commentsQuery.error.message
        : "Unable to load discussion."
      : createComment.isError
        ? createComment.error instanceof Error
          ? createComment.error.message
          : "Unable to add comment."
        : commentsQuery.isPending
          ? "Loading discussion..."
          : null;
  const viewerArchive =
    loaded.evidence.title === loaded.session.archive.name
      ? loaded.session.archive
      : { ...loaded.session.archive, name: loaded.evidence.title };

  return (
    <>
    <EvidenceViewerContent
      key={loaded.evidenceId}
      loadedArchive={viewerArchive}
      loadedTimeline={loaded.session.timeline}
      loadedMergeGroups={loaded.session.mergeGroups}
      videoSrc={loaded.session.videoUrl}
      recordingBytesInitial={loaded.session.recordingBytes}
      source={props.shareToken ? "share" : "cloud"}
      isOwner={!props.shareToken}
      shareLinkUrl={shareLinkUrl}
      fetchVideoBytes={fetchVideoBytes}
      onVideoError={handleVideoError}
      onClose={() => navigate(props.viewerMode === "page" ? "/evidence" : "/")}
      recordedBy={loaded.evidence.createdByProfile ?? null}
      discussionComments={comments}
      discussionValue={commentDraft}
      discussionSaving={createComment.isPending}
      discussionNotice={discussionNotice}
      onDiscussionChange={setCommentDraft}
      onSubmitDiscussion={() => void submitComment()}
      evidenceTags={loaded.evidence.tags}
      availableEvidenceTags={tagsQuery.data?.tags ?? []}
      canUpdateEvidenceTags={canUpdateEvidenceTags}
      evidenceTagsSaving={updateTags.isPending || tagsQuery.isPending}
      onEvidenceTagsChange={updateEvidenceTags}
      {...(canRenameEvidence ? { onRenameEvidence: openRenameDialog } : {})}
      {...(canRenameEvidence ? { renamingEvidence: renameEvidence.isPending } : {})}
      {...(canCopyEvidence ? { onCopyEvidence: () => setWorkspaceAction("copy") } : {})}
      {...(canCopyLlmPrompt ? { onCopyLlmPrompt: () => void copyLlmPrompt() } : {})}
      {...(canCopyLlmPrompt
        ? { copyingLlmPrompt: createAiToken.isPending || aiTokensQuery.isFetching }
        : {})}
      {...(canTransferEvidence ? { onTransferEvidence: () => setWorkspaceAction("transfer") } : {})}
      {...(props.viewerMode ? { viewerMode: props.viewerMode } : {})}
    />
      {workspaceAction ? (
        <WorkspaceEvidenceActionDialog
          evidence={loaded.evidence}
          action={workspaceAction}
          organizations={accountQuery.data?.organizations ?? []}
          onClose={() => setWorkspaceAction(null)}
        />
      ) : null}
      <Dialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        size="sm"
        title="Rename evidence"
        description="Keep it searchable."
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRenameOpen(false)}
              disabled={renameEvidence.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={submitRename}
              disabled={
                renameEvidence.isPending ||
                renameValue.trim().length === 0 ||
                renameValue.trim() === loaded.evidence.title
              }
            >
              {renameEvidence.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitRename();
          }}
        >
          <Field label="Session name">
            <Input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.currentTarget.value)}
              maxLength={200}
            />
          </Field>
        </form>
      </Dialog>
    </>
  );
}

function WorkspaceEvidenceActionDialog(props: {
  evidence: ApiEvidenceSummary;
  action: "copy" | "transfer";
  organizations: ApiOrganization[];
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const copyEvidence = useCopyEvidence();
  const moveEvidence = useMoveEvidence();
  const targetOrganizations = props.organizations.filter(
    (org) => org.id !== props.evidence.orgId,
  );
  const [targetOrgId, setTargetOrgId] = useState(
    targetOrganizations[0]?.id ?? "",
  );
  const targetOrg = targetOrganizations.find((org) => org.id === targetOrgId);
  const mutation = props.action === "copy" ? copyEvidence : moveEvidence;
  const busy = mutation.isPending;
  const verb = props.action === "copy" ? "Copy" : "Transfer";

  const submit = (): void => {
    if (!targetOrgId || busy) return;
    mutation.mutate(
      { evidenceId: props.evidence.id, targetOrgId },
      {
        onSuccess: () => {
          toast.success(
            props.action === "copy" ? "Evidence copied" : "Evidence transferred",
            targetOrg ? `${props.evidence.title} -> ${targetOrg.name}` : undefined,
          );
          props.onClose();
        },
        onError: (error) =>
          toast.error(
            `${verb} failed`,
            error instanceof Error ? error.message : undefined,
          ),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      size="sm"
      title={`${verb} evidence`}
      description={
        props.action === "copy"
          ? "Create a separate evidence entry in another workspace."
          : "Move this evidence to another workspace and invalidate existing share links."
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={busy || targetOrganizations.length === 0 || !targetOrgId}
          >
            {busy ? `${verb}ing…` : verb}
          </Button>
        </>
      }
    >
      {targetOrganizations.length === 0 ? (
        <p className="text-base text-muted-foreground">
          Join or create another workspace before using this action.
        </p>
      ) : (
        <Field label="Destination workspace">
          <Select
            ariaLabel="Destination workspace"
            value={targetOrgId}
            onValueChange={setTargetOrgId}
            options={targetOrganizations.map((org) => ({
              label: org.name,
              value: org.id,
            }))}
          />
        </Field>
      )}
    </Dialog>
  );
}

export function SharedEvidencePage(): React.JSX.Element {
  const { shareToken } = useParams();
  if (!shareToken) return <StatusScreen tone="error" title="Missing share token" />;
  return (
    <RequireAuth>
      <SharedEvidenceRedirect shareToken={shareToken} />
    </RequireAuth>
  );
}

function SharedEvidenceRedirect({ shareToken }: { shareToken: string }): React.JSX.Element {
  const navigate = useNavigate();
  const query = useShareLinkResolution(shareToken);

  useEffect(() => {
    if (query.data?.shareLink.access !== "granted") return;
    const evidencePath = `/evidence/${encodeURIComponent(query.data.shareLink.evidenceId)}`;
    const search = new URLSearchParams({ orgId: query.data.shareLink.orgId });
    navigate(`${evidencePath}?${search.toString()}`, { replace: true });
  }, [navigate, query.data]);

  if (query.isPending) {
    return <StatusScreen loading title="Opening evidence" detail="Checking share access..." />;
  }
  if (query.isError) {
    return (
      <StatusScreen
        tone="error"
        title="Unable to open share link"
        detail={query.error instanceof Error ? query.error.message : "Unknown error"}
      />
    );
  }
  if (query.data?.shareLink.access === "denied") {
    return <RestrictedShareScreen orgName={query.data.organization.name} />;
  }

  return <StatusScreen loading title="Opening evidence" />;
}

export function CloudEvidencePage(): React.JSX.Element {
  const { evidenceId } = useParams();
  const [searchParams] = useSearchParams();
  if (!evidenceId) return <StatusScreen tone="error" title="Missing evidence id" />;
  return (
    <RemoteEvidenceLoader
      remoteEvidenceId={evidenceId}
      remoteOrgId={searchParams.get("orgId") ?? undefined}
      viewerMode="page"
    />
  );
}
