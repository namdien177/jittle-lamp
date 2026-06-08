import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { useAuth } from "../auth";
import { api, type ArtifactReadUrl, type FetchToken } from "../api";
import { Button } from "../components/ui/button";
import { StatusScreen } from "../components/status-screen";
import { RequireAuth } from "../components/workspace/require-auth";
import { EvidenceViewerContent } from "../evidence-viewer-content";
import {
  useCreateEvidenceComment,
  useEvidenceComments,
  useRemoteEvidence,
  type RemoteEvidenceData
} from "../queries";

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
  viewerMode?: "modal" | "page";
}): React.JSX.Element {
  const navigate = useNavigate();
  const auth = useAuth();
  const query = useRemoteEvidence({
    ...(props.shareToken !== undefined ? { shareToken: props.shareToken } : {}),
    ...(props.remoteEvidenceId !== undefined ? { remoteEvidenceId: props.remoteEvidenceId } : {})
  });

  const stableGetToken: FetchToken = useRef(() => auth.getToken()).current;
  const latestUrlsRef = useRef<{ videoReadUrl: ArtifactReadUrl; archiveReadUrl: ArtifactReadUrl } | null>(null);
  const loaded: RemoteEvidenceData | null = query.data?.kind === "loaded" ? query.data.data : null;
  const [commentDraft, setCommentDraft] = useState("");
  const commentsQuery = useEvidenceComments(loaded?.evidenceId ?? null, loaded?.orgId);
  const createComment = useCreateEvidenceComment();

  if (loaded) {
    latestUrlsRef.current = { videoReadUrl: loaded.videoReadUrl, archiveReadUrl: loaded.archiveReadUrl };
  }

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

  const shareLinkUrl = props.shareToken
    ? `${window.location.origin}/share/${encodeURIComponent(props.shareToken)}`
    : null;

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

  return (
    <EvidenceViewerContent
      key={loaded.evidenceId}
      loadedArchive={loaded.session.archive}
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
      discussionComments={comments}
      discussionValue={commentDraft}
      discussionSaving={createComment.isPending}
      discussionNotice={discussionNotice}
      onDiscussionChange={setCommentDraft}
      onSubmitDiscussion={() => void submitComment()}
      {...(props.viewerMode ? { viewerMode: props.viewerMode } : {})}
    />
  );
}

export function SharedEvidencePage(): React.JSX.Element {
  const { shareToken } = useParams();
  if (!shareToken) return <StatusScreen tone="error" title="Missing share token" />;
  return (
    <RequireAuth>
      <RemoteEvidenceLoader shareToken={shareToken} />
    </RequireAuth>
  );
}

export function CloudEvidencePage(): React.JSX.Element {
  const { evidenceId } = useParams();
  if (!evidenceId) return <StatusScreen tone="error" title="Missing evidence id" />;
  return <RemoteEvidenceLoader remoteEvidenceId={evidenceId} viewerMode="page" />;
}
