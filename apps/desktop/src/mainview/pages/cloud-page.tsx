import React, { useMemo, useState } from "react";
import { Search } from "lucide-react";

import type { ApiEvidenceSummary } from "../api";
import { useCreateShareLink, useEvidences, useRevokeShareLink, useShareLinks } from "../queries";
import { Dialog } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { copyToClipboard, formatRelativeTime } from "../utils";

const EXPIRY_OPTIONS = [
  { label: "Permanent", value: 0 },
  { label: "1 hour", value: 60 * 60 * 1000 },
  { label: "24 hours", value: 24 * 60 * 60 * 1000 },
  { label: "7 days", value: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", value: 30 * 24 * 60 * 60 * 1000 }
];

export function CloudPage(): React.JSX.Element {
  const toast = useToast();
  const evidencesQuery = useEvidences();
  const [search, setSearch] = useState("");
  const [shareTarget, setShareTarget] = useState<ApiEvidenceSummary | null>(null);

  const evidences = evidencesQuery.data?.evidences ?? [];
  const orgId = evidencesQuery.data?.orgId ?? null;
  const loading = evidencesQuery.isFetching;
  const error = evidencesQuery.error instanceof Error ? evidencesQuery.error.message : null;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return evidences;
    return evidences.filter((evidence) =>
      [evidence.title, evidence.sourceType, evidence.id].some((field) => field.toLowerCase().includes(query))
    );
  }, [evidences, search]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Cloud evidences</h1>
          <p className="page-subtitle">
            Evidence assets uploaded to your active workspace. Generate share links and audit existing access from a
            single place.
          </p>
        </div>
        <div className="row">
          <button className="button ghost sm" type="button" onClick={() => void evidencesQuery.refetch()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="library-toolbar">
        <div className="search-input-wrap">
          <Search className="search-input-icon" aria-hidden size={14} strokeWidth={2} />
          <input
            type="text"
            className="input search-input"
            placeholder="Search evidences by title, type, or id…"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <div />
        <div className="row" style={{ gap: 8 }}>
          {orgId ? (
            <span className="muted mono" style={{ fontSize: 11 }}>
              workspace · {orgId.slice(0, 8)}
            </span>
          ) : null}
          <span className="muted" style={{ fontSize: 11 }}>
            {filtered.length} evidence{filtered.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {error ? <div className="auth-error">{error}</div> : null}

      {filtered.length === 0 ? (
        <div className="empty-state">
          <h3>{loading ? "Loading evidences…" : "No evidences in this workspace"}</h3>
          <p>
            Upload evidence from a recording session or another tool to make it shareable here. New uploads land in
            your active organisation automatically.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Last updated</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((evidence) => (
                <tr key={evidence.id}>
                  <td>
                    <div className="column" style={{ gap: 2 }}>
                      <span style={{ fontWeight: 600 }}>{evidence.title}</span>
                      <span className="mono soft" style={{ fontSize: 10.5 }}>
                        {evidence.id}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="chip neutral">{evidence.sourceType}</span>
                  </td>
                  <td className="muted">{formatRelativeTime(evidence.updatedAt)}</td>
                  <td>
                    <div className="table-actions">
                      <button className="button primary sm" type="button" onClick={() => setShareTarget(evidence)}>
                        Share
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shareTarget ? (
        <ShareDialog
          evidence={shareTarget}
          onClose={() => setShareTarget(null)}
          onMessage={(message, tone) =>
            tone === "success" ? toast.success(message) : tone === "error" ? toast.error(message) : toast.info(message)
          }
        />
      ) : null}
    </div>
  );
}

function ShareDialog(props: {
  evidence: ApiEvidenceSummary;
  onClose: () => void;
  onMessage: (message: string, tone: "success" | "error" | "neutral") => void;
}): React.JSX.Element {
  const { evidence, onClose, onMessage } = props;
  const shareLinksQuery = useShareLinks(evidence.id);
  const createShareLink = useCreateShareLink();
  const revokeShareLink = useRevokeShareLink();
  const [expiry, setExpiry] = useState<number>(0);
  const [createdToken, setCreatedToken] = useState<{ id: string; token: string; expiresAt: number } | null>(null);

  const shareLinks = shareLinksQuery.data?.shareLinks ?? [];
  const loading = shareLinksQuery.isFetching;
  const busy = createShareLink.isPending || revokeShareLink.isPending;

  const handleCreate = async (): Promise<void> => {
    try {
      const result = await createShareLink.mutateAsync({ evidenceId: evidence.id, expiresInMs: expiry });
      setCreatedToken({
        id: result.shareLink.id,
        token: result.shareLink.token,
        expiresAt: result.shareLink.expiresAt
      });
      onMessage("Share link created", "success");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Unable to create share link.", "error");
    }
  };

  const handleRevoke = async (id: string): Promise<void> => {
    try {
      await revokeShareLink.mutateAsync({ evidenceId: evidence.id, shareLinkId: id });
      onMessage("Share link revoked", "success");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Unable to revoke share link.", "error");
    }
  };

  const activeLinks = shareLinks.filter((link) => link.revokedAt === null && (link.expiresAt === 0 || link.expiresAt > Date.now()));
  const inactiveLinks = shareLinks.filter((link) => !(link.revokedAt === null && (link.expiresAt === 0 || link.expiresAt > Date.now())));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Share · ${evidence.title}`}
      description="Internal share links can be opened by other members of your organisation. Tokens are shown only once after creation."
      footer={
        <button className="button secondary sm" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="card-section" style={{ padding: 0 }}>
        <h3 className="card-title" style={{ marginBottom: 8 }}>Create new link</h3>
        <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Expires after</span>
            <select
              className="select field-input"
              value={expiry}
              onChange={(event) => setExpiry(Number.parseInt(event.currentTarget.value, 10))}
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button className="button primary sm" type="button" onClick={() => void handleCreate()} disabled={busy}>
            {busy ? "Working…" : "Generate link"}
          </button>
        </div>
        {createdToken ? (
          <div className="invite-token-box" style={{ marginTop: 12 }}>
            <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Share token (copy now — won't be shown again)
            </span>
            <span>{createdToken.token}</span>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="button primary xs"
                type="button"
                onClick={async () => {
                  await copyToClipboard(createdToken.token);
                  onMessage("Token copied to clipboard", "success");
                }}
              >
                Copy token
              </button>
              <button
                className="button ghost xs"
                type="button"
                onClick={() => setCreatedToken(null)}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "8px 0" }} />

      <div>
        <h3 className="card-title" style={{ marginBottom: 8 }}>Active links ({activeLinks.length})</h3>
        {loading ? (
          <div className="skeleton-row" style={{ height: 36 }} />
        ) : activeLinks.length === 0 ? (
          <p className="muted" style={{ fontSize: 12 }}>No active share links yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Link</th>
                <th>Created</th>
                <th>Expires</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeLinks.map((link) => (
                <tr key={link.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{link.id.slice(0, 14)}…</td>
                  <td className="muted">{formatRelativeTime(link.createdAt)}</td>
                  <td className="muted">{link.expiresAt === 0 ? "Never" : formatRelativeTime(link.expiresAt)}</td>
                  <td>
                    <div className="table-actions">
                      <button className="button ghost xs" type="button" onClick={() => void handleRevoke(link.id)} disabled={busy}>
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {inactiveLinks.length > 0 ? (
        <div>
          <h3 className="card-title" style={{ marginBottom: 8 }}>History ({inactiveLinks.length})</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Link</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {inactiveLinks.map((link) => {
                const status = link.revokedAt !== null ? "Revoked" : "Expired";
                const when = link.revokedAt ?? link.expiresAt;
                return (
                  <tr key={link.id}>
                    <td className="mono" style={{ fontSize: 11 }}>{link.id.slice(0, 14)}…</td>
                    <td>
                      <span className={`chip ${link.revokedAt !== null ? "danger" : "warning"}`}>{status}</span>
                    </td>
                    <td className="muted">{formatRelativeTime(when)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Dialog>
  );
}
