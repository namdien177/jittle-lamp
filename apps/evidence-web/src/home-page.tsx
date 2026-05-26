import React, { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@jittle-lamp/ui";
import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  SignInButton,
  SignedIn,
  SignedOut,
  useAuth
} from "@clerk/clerk-react";
import { ChevronDown, MoreVertical } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { AuthenticatedWebLayout } from "./auth-layout";
import { downloadEvidenceAsZip } from "./download-evidence";
import type { ApiEvidenceSummary, FetchToken } from "./api";
import { useAccountProfile, useDeleteEvidence, useEvidences } from "./queries";
import { ShareDialog } from "./share-dialog";
import { useToast } from "./toast";
import { formatRelativeTime } from "./utils";

export function HomePage(): React.JSX.Element {
  return (
    <>
      <ClerkFailed>
        <PublicHomePage />
      </ClerkFailed>
      <ClerkDegraded>
        <PublicHomePage />
      </ClerkDegraded>
      <ClerkLoading>
        <main className="desktop-auth-page">
          <section className="desktop-auth-panel">
            <h1>Loading…</h1>
          </section>
        </main>
      </ClerkLoading>
      <ClerkLoaded>
        <SignedOut>
          <PublicHomePage />
        </SignedOut>
        <SignedIn>
          <AuthenticatedHome />
        </SignedIn>
      </ClerkLoaded>
    </>
  );
}

export function PublicHomePage(): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <main className="ed-page">
      <header className="ed-topbar">
        <Link to="/" className="ed-wordmark">
          Jittle Lamp
        </Link>
        <nav className="ed-topnav" aria-label="Primary">
          <Link to="/quick-view" className="ed-topnav-link">
            Quick view
          </Link>
          <Link to="/privacy" className="ed-topnav-link">
            Privacy
          </Link>
          <SignedOut>
            <SignInButton mode="modal">
              <button type="button" className="ed-topnav-link ed-topnav-link-action">
                Sign in
              </button>
            </SignInButton>
          </SignedOut>
        </nav>
      </header>

      <section className="ed-hero" aria-label="Jittle Lamp evidence review">
        <p className="ed-eyebrow">Session evidence review</p>
        <h1 className="ed-headline">
          See the whole session,
          <br />
          not just the screen.
        </h1>
        <p className="ed-lede">
          Video, network, console, and timeline — one synced view. Open a local archive, or move
          it to a workspace when you need to share.
        </p>
        <div className="ed-actions">
          <button type="button" className="ed-link-action" onClick={() => navigate("/quick-view")}>
            Open quick view
            <span aria-hidden="true" className="ed-arrow">
              →
            </span>
          </button>
          <span className="ed-actions-sep" aria-hidden="true" />
          <button
            type="button"
            className="ed-link-action ed-link-action-quiet"
            onClick={() => navigate("/organisations")}
          >
            Go to workspace
          </button>
        </div>
      </section>

      <section className="ed-points" aria-label="What Jittle Lamp does">
        <article className="ed-point">
          <span className="ed-point-num">01</span>
          <h2 className="ed-point-title">One timeline.</h2>
          <p className="ed-point-body">
            Playback stays in sync with network calls, console events, and pinned markers. Spot the
            symptom, see the cause.
          </p>
        </article>
        <article className="ed-point">
          <span className="ed-point-num">02</span>
          <h2 className="ed-point-title">Open in seconds.</h2>
          <p className="ed-point-body">
            Drop a session ZIP into quick view and review it on your machine. No upload, no setup.
          </p>
        </article>
        <article className="ed-point">
          <span className="ed-point-num">03</span>
          <h2 className="ed-point-title">Share when ready.</h2>
          <p className="ed-point-body">
            Move evidence into a workspace and hand teammates a stable link. Searchable and scoped
            to your organisation.
          </p>
        </article>
      </section>

      <footer className="ed-footer">
        <span>© Jittle Lamp</span>
        <span className="ed-footer-sep" aria-hidden="true">
          ·
        </span>
        <Link to="/privacy" className="ed-footer-link">
          Privacy
        </Link>
      </footer>
    </main>
  );
}

function AuthenticatedHome(): React.JSX.Element {
  const navigate = useNavigate();
  const auth = useAuth();
  const profileQuery = useAccountProfile();
  const evidencesQuery = useEvidences();
  const deleteEvidence = useDeleteEvidence();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [shareTarget, setShareTarget] = useState<ApiEvidenceSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ApiEvidenceSummary | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const getToken: FetchToken = () => auth.getToken();

  const evidences = evidencesQuery.data?.evidences ?? [];
  const orgId = evidencesQuery.data?.orgId ?? null;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return evidences;
    return evidences.filter((evidence) =>
      [evidence.title, evidence.sourceType, evidence.id].some((field) =>
        field.toLowerCase().includes(query)
      )
    );
  }, [evidences, search]);

  const loading = profileQuery.isFetching || evidencesQuery.isFetching;
  const deletingId = deleteEvidence.variables ?? null;
  const error =
    profileQuery.error instanceof Error
      ? profileQuery.error.message
      : evidencesQuery.error instanceof Error
        ? evidencesQuery.error.message
        : deleteEvidence.error instanceof Error
          ? deleteEvidence.error.message
        : null;

  const handleDownload = async (evidence: ApiEvidenceSummary): Promise<void> => {
    setDownloadingId(evidence.id);
    try {
      await downloadEvidenceAsZip({
        getToken,
        evidenceId: evidence.id,
        orgId: evidence.orgId,
        title: evidence.title
      });
      toast.success("Download started", "ZIP saved to your downloads folder.");
    } catch (downloadError) {
      toast.error(
        "Download failed",
        downloadError instanceof Error ? downloadError.message : undefined
      );
    } finally {
      setDownloadingId(null);
    }
  };

  const confirmDelete = (): void => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    deleteEvidence.mutate(target.id, {
      onSuccess: () => {
        toast.success("Evidence deleted", target.title);
        setPendingDelete(null);
      },
      onError: (mutationError) => {
        toast.error(
          "Delete failed",
          mutationError instanceof Error ? mutationError.message : undefined
        );
      }
    });
  };

  return (
    <AuthenticatedWebLayout evidenceCount={evidences.length}>
      <div className="ed-app-main">
        <header className="ed-app-header">
          <p className="ed-eyebrow">Workspace</p>
          <h1 className="ed-app-title">Evidences</h1>
          <p className="ed-app-subtitle">
            Sessions uploaded to this workspace. Open one to review the timeline, video, and
            network.
          </p>
        </header>

        <section className="ed-app-toolbar" aria-label="Search and refresh">
          <label className="ed-search">
            <span className="ed-search-label">Search</span>
            <input
              type="text"
              className="ed-search-input"
              placeholder="Title, type, or id"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </label>
          <div className="ed-toolbar-meta">
            {orgId ? <span className="ed-toolbar-org">{orgId.slice(0, 8)}</span> : null}
            <span className="ed-toolbar-count">
              {filtered.length} record{filtered.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="button ghost sm"
              onClick={() => void evidencesQuery.refetch()}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </section>

        {error ? <div className="ed-banner-error">{error}</div> : null}

        {filtered.length === 0 ? (
          <div className="ed-empty">
            <p className="ed-empty-title">
              {loading ? "Loading evidences…" : "No evidences in this workspace yet."}
            </p>
            <p className="ed-empty-body">
              Upload from the desktop app or open a local archive in quick view. Uploads land in the
              active organisation automatically.
            </p>
            <button
              type="button"
              className="button secondary sm"
              onClick={() => navigate("/quick-view")}
            >
              Open a local archive
            </button>
          </div>
        ) : (
          <ul className="ed-list" aria-label="Evidence records">
            {filtered.map((evidence) => (
              <EvidenceRow
                key={evidence.id}
                evidence={evidence}
                downloading={downloadingId === evidence.id}
                deleting={deletingId === evidence.id}
                onReview={() => navigate(`/evidence/${encodeURIComponent(evidence.id)}`)}
                onShare={() => setShareTarget(evidence)}
                onDownload={() => void handleDownload(evidence)}
                onDelete={() => setPendingDelete(evidence)}
              />
            ))}
          </ul>
        )}
      </div>

      {shareTarget ? (
        <ShareDialog evidence={shareTarget} onClose={() => setShareTarget(null)} />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this evidence?"
        description={
          pendingDelete
            ? `This permanently removes ${pendingDelete.title} from the workspace. Active share links will stop working.`
            : ""
        }
        confirmLabel="Delete"
        destructive
        busy={deleteEvidence.isPending}
        onConfirm={confirmDelete}
        onCancel={() => (deleteEvidence.isPending ? null : setPendingDelete(null))}
      />
    </AuthenticatedWebLayout>
  );
}

function EvidenceRow(props: {
  evidence: ApiEvidenceSummary;
  downloading: boolean;
  deleting: boolean;
  onReview: () => void;
  onShare: () => void;
  onDownload: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const { evidence, downloading, deleting, onReview, onShare, onDownload, onDelete } = props;
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!overflowOpen) return;
    const handleClickOutside = (event: MouseEvent): void => {
      if (!overflowRef.current?.contains(event.target as Node)) {
        setOverflowOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOverflowOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [overflowOpen]);

  const busy = downloading || deleting;

  return (
    <li className="ed-row">
      <button type="button" className="ed-row-main" onClick={onReview}>
        <span className="ed-row-title">{evidence.title}</span>
        <span className="ed-row-meta">
          <span className="ed-row-type">{evidence.sourceType}</span>
          <span className="ed-row-sep" aria-hidden="true">·</span>
          <span className="ed-row-id">{evidence.id.slice(0, 12)}</span>
          <span className="ed-row-sep" aria-hidden="true">·</span>
          <span className="ed-row-time" title={new Date(evidence.updatedAt).toISOString()}>
            {formatRelativeTime(evidence.updatedAt)}
          </span>
        </span>
      </button>
      <div className="ed-row-actions">
        <button className="button primary sm" type="button" onClick={onReview}>
          Review
        </button>
        <button className="button ghost sm" type="button" onClick={onShare} disabled={busy}>
          <span className="button-label-with-icon">
            Share <ChevronDown aria-hidden size={14} strokeWidth={2} />
          </span>
        </button>
        <div className="share-menu-wrap" ref={overflowRef}>
          <button
            className="button ghost sm icon-only"
            type="button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            disabled={busy}
            onClick={() => setOverflowOpen((prev) => !prev)}
          >
            <MoreVertical aria-hidden size={16} strokeWidth={2} />
          </button>
          {overflowOpen ? (
            <div className="share-menu session-overflow-menu" role="menu">
              <button
                className="share-menu-item"
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setOverflowOpen(false);
                  onDownload();
                }}
              >
                {downloading ? "Downloading…" : "Download as ZIP"}
              </button>
              <button
                className="share-menu-item danger"
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setOverflowOpen(false);
                  onDelete();
                }}
              >
                {deleting ? "Deleting…" : "Delete from cloud"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
