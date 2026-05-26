import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { BrowserRouter, useNavigate, useParams, useRoutes } from "react-router";
import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  SignIn,
  SignedIn,
  SignedOut,
  useAuth
} from "@clerk/clerk-react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { JittleRouteObject } from "@jittle-lamp/viewer-react";
import { Upload } from "lucide-react";

import { AppHeader } from "./app-header";
import {
  createWebNotesAdapter,
  createWebPlaybackAdapter,
  createWebShareAdapter,
  createWebStorageAdapter
} from "./adapters";
import { api, type ArtifactReadUrl, type FetchToken } from "./api";
import { DesktopAuthApprovalPage } from "./desktop-auth-page";
import { clerkPublishableKey } from "./env";
import { EvidenceViewerContent } from "./evidence-viewer-content";
import { HomePage, PublicHomePage } from "./home-page";
import { JoinOrganizationPage } from "./join-org-page";
import type { LoadedSession } from "./loader";
import { OrganisationsPage } from "./organisations-page";
import { createQueryClient, useRemoteEvidence, type RemoteEvidenceData } from "./queries";
import { ToastProvider } from "./toast";
import { useWebFileAdapter } from "./web-adapter";

const queryClient = createQueryClient();

function StatusScreen(props: { title: string; detail?: string }): React.JSX.Element {
  return (
    <main className="desktop-auth-page">
      <section className="desktop-auth-panel" aria-live="polite">
        <h1>{props.title}</h1>
        {props.detail ? <p>{props.detail}</p> : null}
      </section>
    </main>
  );
}

function RestrictedShareScreen(props: { orgName: string }): React.JSX.Element {
  const navigate = useNavigate();
  const goToJoin = (): void => {
    const here = window.location.pathname + window.location.search;
    navigate(`/join?redirect=${encodeURIComponent(here)}`);
  };
  return (
    <main className="desktop-auth-page">
      <section className="desktop-auth-panel" aria-live="polite">
        <h1>Evidence is restricted</h1>
        <p>
          This evidence is only available to members of <strong>{props.orgName}</strong>. Ask an
          owner of {props.orgName} to invite you, then reload this page.
        </p>
        <div className="join-actions">
          <button className="drop-btn" type="button" onClick={goToJoin}>
            I have the code
          </button>
        </div>
      </section>
    </main>
  );
}

function RemoteEvidenceLoader(props: {
  shareToken?: string;
  remoteEvidenceId?: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const auth = useAuth();
  const query = useRemoteEvidence({
    ...(props.shareToken !== undefined ? { shareToken: props.shareToken } : {}),
    ...(props.remoteEvidenceId !== undefined ? { remoteEvidenceId: props.remoteEvidenceId } : {})
  });

  const stableGetToken: FetchToken = useRef(() => auth.getToken()).current;

  const latestUrlsRef = useRef<{
    videoReadUrl: ArtifactReadUrl;
    archiveReadUrl: ArtifactReadUrl;
  } | null>(null);

  const loaded: RemoteEvidenceData | null =
    query.data?.kind === "loaded" ? query.data.data : null;

  if (loaded) {
    latestUrlsRef.current = {
      videoReadUrl: loaded.videoReadUrl,
      archiveReadUrl: loaded.archiveReadUrl
    };
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

  if (query.isLoading || !auth.isLoaded) {
    return (
      <StatusScreen
        title="Loading evidence"
        detail={props.shareToken ? "Validating the share link…" : "Fetching evidence artifacts…"}
      />
    );
  }

  if (query.isError) {
    return (
      <StatusScreen
        title="Unable to load evidence"
        detail={query.error instanceof Error ? query.error.message : "Unknown error"}
      />
    );
  }

  if (query.data?.kind === "restricted") {
    return <RestrictedShareScreen orgName={query.data.orgName} />;
  }

  if (!loaded) return <StatusScreen title="Loading evidence" />;

  const shareLinkUrl = props.shareToken
    ? `${window.location.origin}/share/${encodeURIComponent(props.shareToken)}`
    : null;

  const fetchVideoBytes = async (): Promise<Uint8Array | null> => {
    const url = latestUrlsRef.current?.videoReadUrl.url ?? loaded.videoReadUrl.url;
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

  return (
    <EvidenceViewerContent
      key={loaded.evidenceId}
      loadedArchive={loaded.session.archive}
      loadedTimeline={loaded.session.timeline}
      loadedMergeGroups={loaded.session.mergeGroups}
      videoSrc={loaded.session.videoUrl}
      recordingBytesInitial={null}
      source={props.shareToken ? "share" : "cloud"}
      isOwner={!props.shareToken}
      shareLinkUrl={shareLinkUrl}
      fetchVideoBytes={fetchVideoBytes}
      onVideoError={handleVideoError}
      onClose={() => navigate("/")}
    />
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
          api.createArtifactReadUrl(getToken, loaded.evidenceId, loaded.recordingArtifact.id, loaded.orgId),
          api.createArtifactReadUrl(getToken, loaded.evidenceId, loaded.archiveArtifact.id, loaded.orgId)
        ]);
        if (cancelled) return;
        onRenewedRef.current({ videoReadUrl, archiveReadUrl });
      } catch {
        // Renewal failure is non-fatal; the next attempt or a video error will recover.
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

type ZipPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "viewing"; loaded: LoadedSession };

function ZipEvidencePage(): React.JSX.Element {
  const storageAdapter = useMemo(() => createWebStorageAdapter(), []);
  const playbackAdapter = useMemo(() => createWebPlaybackAdapter(), []);
  const notesAdapter = useMemo(() => createWebNotesAdapter(), []);
  const shareAdapter = useMemo(() => createWebShareAdapter(), []);
  void notesAdapter;
  void shareAdapter;

  const [phase, setPhase] = useState<ZipPhase>({ kind: "idle" });
  const previousVideoUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previousVideoUrlRef.current) {
        playbackAdapter.releaseSource?.({ videoPath: previousVideoUrlRef.current });
      }
    };
  }, [playbackAdapter]);

  const handleFile = async (file: File): Promise<void> => {
    setPhase({ kind: "loading" });
    try {
      const loaded = await storageAdapter.loadFromZipFile?.(file);
      if (!loaded) throw new Error("Web ZIP storage adapter is unavailable.");

      if (previousVideoUrlRef.current) {
        playbackAdapter.releaseSource?.({ videoPath: previousVideoUrlRef.current });
      }
      previousVideoUrlRef.current = loaded.videoUrl;
      playbackAdapter.loadSource({ videoPath: loaded.videoUrl, mimeType: "video/webm" });

      setPhase({ kind: "viewing", loaded });
    } catch (err) {
      setPhase({ kind: "error", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const fileAdapter = useWebFileAdapter({
    disabled: phase.kind === "loading",
    onFile: handleFile
  });

  const closeViewer = (): void => {
    if (previousVideoUrlRef.current) {
      playbackAdapter.releaseSource?.({ videoPath: previousVideoUrlRef.current });
      previousVideoUrlRef.current = null;
    }
    setPhase({ kind: "idle" });
  };

  if (phase.kind === "viewing") {
    const fetchVideoBytes = async (): Promise<Uint8Array | null> => {
      if (phase.loaded.recordingBytes.length > 0) return phase.loaded.recordingBytes;
      try {
        const response = await fetch(phase.loaded.videoUrl);
        if (!response.ok) throw new Error(`Failed to fetch recording (${response.status}).`);
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        return null;
      }
    };
    return (
      <EvidenceViewerContent
        key={phase.loaded.archive.sessionId}
        loadedArchive={phase.loaded.archive}
        loadedTimeline={phase.loaded.timeline}
        loadedMergeGroups={phase.loaded.mergeGroups}
        videoSrc={phase.loaded.videoUrl}
        recordingBytesInitial={phase.loaded.recordingBytes}
        source="zip"
        isOwner={true}
        shareLinkUrl={null}
        fetchVideoBytes={fetchVideoBytes}
        onVideoError={() => undefined}
        onClose={closeViewer}
      />
    );
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <div className="drop-zone">
        <div
          className="drop-area"
          data-dragover={fileAdapter.isDragOver ? "true" : "false"}
          onDragOver={fileAdapter.onDragOver}
          onDragLeave={fileAdapter.onDragLeave}
          onDrop={fileAdapter.onDrop}
          onClick={fileAdapter.openDialog}
        >
          <Upload className="drop-icon" aria-hidden size={42} strokeWidth={1.75} />
          <p className="drop-title">{phase.kind === "loading" ? "Loading…" : "Drop a session ZIP here"}</p>
          <p className="drop-sub">
            {phase.kind === "loading" ? "Extracting and validating…" : "or click to browse"}
          </p>
          {phase.kind === "error" ? <p className="drop-error">{phase.error}</p> : null}
          {phase.kind !== "loading" ? (
            <label className="drop-btn">
              <input
                type="file"
                accept=".zip"
                style={{ display: "none" }}
                ref={fileAdapter.inputRef}
                onChange={fileAdapter.onInputChange}
              />
              Browse file
            </label>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PrivacyPage(): React.JSX.Element {
  return (
    <main className="legal-page">
      <article className="legal-panel">
        <p className="legal-eyebrow">Jittle Lamp</p>
        <h1>Privacy Policy</h1>
        <p className="legal-updated">Last updated: April 27, 2026</p>

        <section>
          <h2>Overview</h2>
          <p>
            Jittle Lamp is a local browser recording and evidence review tool. The extension
            records browser activity only when you start a capture, and recorded sessions are
            intended to stay on your machine unless you choose to export or share them.
          </p>
        </section>

        <section>
          <h2>Data We Handle</h2>
          <p>
            A recording can include the page URL, screen recording, network request and response
            details, console output, and other diagnostic events from the captured browser session.
            This data may include personal or sensitive information if it appears in the pages,
            requests, or responses you record.
          </p>
        </section>

        <section>
          <h2>How Data Is Used</h2>
          <p>
            Captured data is used to help you replay, review, debug, and share browser sessions.
            We do not sell your data. We do not use captured session data for advertising.
          </p>
        </section>

        <section>
          <h2>Sharing</h2>
          <p>
            Session files remain under your control. If you export, upload, or share a session,
            the people or services you share it with may be able to view the included recording
            and diagnostic data.
          </p>
        </section>

        <section>
          <h2>Retention</h2>
          <p>
            Locally saved sessions remain on your device until you delete them. Shared or uploaded
            sessions are retained only as needed to provide the sharing or review functionality you
            selected.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            For privacy questions, contact the Jittle Lamp maintainer through the support channel
            listed in the Chrome Web Store listing.
          </p>
        </section>
      </article>
    </main>
  );
}

function ClerkAuthGate(props: { children: React.ReactNode }): React.JSX.Element {
  const currentUrl = window.location.href;
  return (
    <>
      <ClerkFailed>
        <StatusScreen title="Unable to load sign-in" detail="Check the Clerk publishable key and network access." />
      </ClerkFailed>
      <ClerkDegraded>
        <StatusScreen title="Unable to load sign-in" detail="Check the Clerk publishable key and network access." />
      </ClerkDegraded>
      <ClerkLoading>
        <StatusScreen title="Loading sign-in" />
      </ClerkLoading>
      <ClerkLoaded>
        <SignedOut>
          <main className="desktop-auth-page">
            <SignIn
              routing="hash"
              forceRedirectUrl={currentUrl}
              fallbackRedirectUrl={currentUrl}
              signUpForceRedirectUrl={currentUrl}
              signUpFallbackRedirectUrl={currentUrl}
            />
          </main>
        </SignedOut>
        <SignedIn>{props.children}</SignedIn>
      </ClerkLoaded>
    </>
  );
}

function SharedEvidencePage(): React.JSX.Element {
  const { shareToken } = useParams();
  if (!shareToken) return <StatusScreen title="Missing share token" />;
  return <RemoteEvidenceLoader shareToken={shareToken} />;
}

function CloudEvidencePage(): React.JSX.Element {
  const { evidenceId } = useParams();
  if (!evidenceId) return <StatusScreen title="Missing evidence id" />;
  return <RemoteEvidenceLoader remoteEvidenceId={evidenceId} />;
}

const evidenceWebRoutes: JittleRouteObject[] = [
  {
    path: "/",
    element: clerkPublishableKey ? <HomePage /> : <PublicHomePage />
  },
  {
    path: "/quick-view",
    element: <ZipEvidencePage />
  },
  {
    path: "/evidence/:evidenceId",
    element: clerkPublishableKey ? (
      <ClerkAuthGate>
        <CloudEvidencePage />
      </ClerkAuthGate>
    ) : (
      <StatusScreen
        title="Clerk is not configured"
        detail="Set CLERK_PUBLISHABLE_KEY before opening cloud evidence."
      />
    )
  },
  {
    path: "/share/:shareToken",
    element: clerkPublishableKey ? (
      <ClerkAuthGate>
        <SharedEvidencePage />
      </ClerkAuthGate>
    ) : (
      <StatusScreen
        title="Clerk is not configured"
        detail="Set CLERK_PUBLISHABLE_KEY before opening shared evidence."
      />
    )
  },
  { path: "/desktop-auth", element: <DesktopAuthApprovalPage /> },
  {
    path: "/organisations",
    element: clerkPublishableKey ? (
      <ClerkAuthGate>
        <OrganisationsPage />
      </ClerkAuthGate>
    ) : (
      <StatusScreen title="Clerk is not configured" detail="Set CLERK_PUBLISHABLE_KEY before managing organisations." />
    )
  },
  {
    path: "/organisations/:orgId",
    element: clerkPublishableKey ? (
      <ClerkAuthGate>
        <OrganisationsPage />
      </ClerkAuthGate>
    ) : (
      <StatusScreen title="Clerk is not configured" detail="Set CLERK_PUBLISHABLE_KEY before managing organisations." />
    )
  },
  {
    path: "/organisations/:orgId/invitations",
    element: clerkPublishableKey ? (
      <ClerkAuthGate>
        <OrganisationsPage section="invitations" />
      </ClerkAuthGate>
    ) : (
      <StatusScreen title="Clerk is not configured" detail="Set CLERK_PUBLISHABLE_KEY before managing organisations." />
    )
  },
  {
    path: "/organisations/:orgId/library",
    element: clerkPublishableKey ? (
      <ClerkAuthGate>
        <OrganisationsPage section="library" />
      </ClerkAuthGate>
    ) : (
      <StatusScreen title="Clerk is not configured" detail="Set CLERK_PUBLISHABLE_KEY before managing organisations." />
    )
  },
  {
    path: "/organisations/:orgId/options",
    element: clerkPublishableKey ? (
      <ClerkAuthGate>
        <OrganisationsPage section="options" />
      </ClerkAuthGate>
    ) : (
      <StatusScreen title="Clerk is not configured" detail="Set CLERK_PUBLISHABLE_KEY before managing organisations." />
    )
  },
  { path: "/join", element: <JoinOrganizationPage /> },
  { path: "/privacy", element: <PrivacyPage /> }
];

function EvidenceWebRoutes(): React.JSX.Element {
  const element = useRoutes(evidenceWebRoutes);
  return <>{element}</>;
}

export function bootstrap(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Evidence web root element was not found.");
  const app = (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <EvidenceWebRoutes />
        </BrowserRouter>
        <Analytics />
      </ToastProvider>
    </QueryClientProvider>
  );

  createRoot(root).render(
    clerkPublishableKey ? (
      <ClerkProvider publishableKey={clerkPublishableKey}>{app}</ClerkProvider>
    ) : app
  );
}
