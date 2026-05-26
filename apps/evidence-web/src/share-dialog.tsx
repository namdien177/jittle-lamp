import React, { useState } from "react";
import { Dialog } from "@jittle-lamp/ui";

import type { ApiEvidenceSummary } from "./api";
import { useCreateShareLink, useRevokeShareLink, useShareLinks } from "./queries";
import { useToast } from "./toast";
import { copyToClipboard, formatRelativeTime } from "./utils";

const EXPIRY_OPTIONS = [
  { label: "1 hour", value: 60 * 60 * 1000 },
  { label: "24 hours", value: 24 * 60 * 60 * 1000 },
  { label: "7 days", value: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", value: 30 * 24 * 60 * 60 * 1000 }
];

const DEFAULT_EXPIRY = EXPIRY_OPTIONS[2]?.value ?? 7 * 24 * 60 * 60 * 1000;

function buildShareUrl(token: string): string {
  return `${window.location.origin}/share/${encodeURIComponent(token)}`;
}

export function ShareDialog(props: {
  evidence: ApiEvidenceSummary;
  onClose: () => void;
}): React.JSX.Element {
  const { evidence, onClose } = props;
  const toast = useToast();
  const shareLinksQuery = useShareLinks(evidence.id);
  const createShareLink = useCreateShareLink();
  const revokeShareLink = useRevokeShareLink();
  const [expiry, setExpiry] = useState<number>(DEFAULT_EXPIRY);
  const [createdLink, setCreatedLink] = useState<{ id: string; token: string; expiresAt: number } | null>(null);

  const shareLinks = shareLinksQuery.data?.shareLinks ?? [];
  const loading = shareLinksQuery.isFetching;
  const busy = createShareLink.isPending || revokeShareLink.isPending;

  const handleCreate = async (): Promise<void> => {
    try {
      const result = await createShareLink.mutateAsync({ evidenceId: evidence.id, expiresInMs: expiry });
      setCreatedLink({
        id: result.shareLink.id,
        token: result.shareLink.token,
        expiresAt: result.shareLink.expiresAt
      });
      toast.success("Share link created");
    } catch (error) {
      toast.error("Unable to create share link", error instanceof Error ? error.message : undefined);
    }
  };

  const handleRevoke = async (shareLinkId: string): Promise<void> => {
    try {
      await revokeShareLink.mutateAsync({ shareLinkId, evidenceId: evidence.id });
      toast.success("Share link revoked");
    } catch (error) {
      toast.error("Unable to revoke share link", error instanceof Error ? error.message : undefined);
    }
  };

  const handleCopyUrl = async (token: string): Promise<void> => {
    try {
      await copyToClipboard(buildShareUrl(token));
      toast.success("Share URL copied to clipboard");
    } catch (error) {
      toast.error("Unable to copy URL", error instanceof Error ? error.message : undefined);
    }
  };

  const activeLinks = shareLinks.filter((link) => link.revokedAt === null && link.expiresAt > Date.now());
  const inactiveLinks = shareLinks.filter((link) => !(link.revokedAt === null && link.expiresAt > Date.now()));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Share · ${evidence.title}`}
      description="Internal share links open in this workspace for members of your organisation. Share URLs are visible only on creation."
      footer={
        <button className="button secondary sm" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="card-section">
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
            {busy && createShareLink.isPending ? "Working…" : "Generate link"}
          </button>
        </div>
        {createdLink ? (
          <div className="invite-token-box" style={{ marginTop: 12 }}>
            <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Share URL (copy now — token won't be shown again)
            </span>
            <span style={{ wordBreak: "break-all" }}>{buildShareUrl(createdLink.token)}</span>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="button primary xs"
                type="button"
                onClick={() => void handleCopyUrl(createdLink.token)}
              >
                Copy URL
              </button>
              <button
                className="button ghost xs"
                type="button"
                onClick={() => setCreatedLink(null)}
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
                  <td className="muted">{formatRelativeTime(link.expiresAt)}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        className="button ghost xs"
                        type="button"
                        onClick={() => void handleRevoke(link.id)}
                        disabled={busy}
                      >
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
