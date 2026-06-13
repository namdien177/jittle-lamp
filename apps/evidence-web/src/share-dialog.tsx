import React, { useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";

import type { ApiEvidenceSummary } from "./api";
import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Field } from "./components/ui/field";
import { Select } from "./components/ui/select";
import { EmptyState, Skeleton } from "./components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "./components/ui/table";
import { useCreateShareLink, useRevokeShareLink, useShareLinks } from "./queries";
import { useToast } from "./toast";
import { copyToClipboard, formatRelativeTime } from "./utils";

const EXPIRY_OPTIONS = [
  { label: "Permanent", value: "0" },
  { label: "1 hour", value: "3600000" },
  { label: "24 hours", value: "86400000" },
  { label: "7 days", value: "604800000" },
  { label: "30 days", value: "2592000000" }
];

const DEFAULT_EXPIRY = "0";

function buildShareUrl(slug: string): string {
  return `${window.location.origin}/share/${encodeURIComponent(slug)}`;
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
  const [expiry, setExpiry] = useState<string>(DEFAULT_EXPIRY);
  const [createdLink, setCreatedLink] = useState<{ slug: string; expiresAt: number } | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);

  const shareLinks = shareLinksQuery.data?.shareLinks ?? [];
  const loading = shareLinksQuery.isFetching;
  const busy = createShareLink.isPending || revokeShareLink.isPending;

  const handleCreate = async (): Promise<void> => {
    try {
      const result = await createShareLink.mutateAsync({
        evidenceId: evidence.id,
        expiresInMs: Number.parseInt(expiry, 10)
      });
      setCreatedLink({ slug: result.shareLink.slug, expiresAt: result.shareLink.expiresAt });
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

  const handleCopy = async (slug: string, copiedId: string): Promise<void> => {
    try {
      await copyToClipboard(buildShareUrl(slug));
      setCopiedLinkId(copiedId);
      window.setTimeout(() => setCopiedLinkId((current) => (current === copiedId ? null : current)), 1800);
      toast.success("Share URL copied");
    } catch (error) {
      toast.error("Unable to copy URL", error instanceof Error ? error.message : undefined);
    }
  };

  const activeLinks = shareLinks.filter((l) => l.revokedAt === null && (l.expiresAt === 0 || l.expiresAt > Date.now()));
  const inactiveLinks = shareLinks.filter((l) => !(l.revokedAt === null && (l.expiresAt === 0 || l.expiresAt > Date.now())));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Share · ${evidence.title}`}
      description="Internal share links open in this workspace for members of your organisation. Active links can be copied again later."
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex items-end gap-2 rounded-lg border border-border bg-black/20 p-3">
        <Field label="Expires after" className="w-44">
          <Select
            ariaLabel="Link expiry"
            options={EXPIRY_OPTIONS}
            value={expiry}
            onValueChange={setExpiry}
          />
        </Field>
        <Button onClick={() => void handleCreate()} disabled={busy}>
          <Link2 aria-hidden />
          {createShareLink.isPending ? "Generating…" : "Generate link"}
        </Button>
      </div>

      {createdLink ? (
        <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/[0.07] p-3">
          <p className="text-base font-semibold uppercase tracking-[0.06em] text-brand-300">
            Share URL ready
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-black/40 px-2.5 py-2 font-mono text-base text-muted-foreground">
              {buildShareUrl(createdLink.slug)}
            </code>
            <Button size="sm" onClick={() => void handleCopy(createdLink.slug, "created")}>
              {copiedLinkId === "created" ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copiedLinkId === "created" ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-base font-semibold">Active links ({activeLinks.length})</h3>
        {loading ? (
          <Skeleton className="h-10 w-full" />
        ) : activeLinks.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={<Link2 aria-hidden />}
            title="No active share links"
            description="Generate one above to give your team scoped access."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Link</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeLinks.map((link) => (
                  <TableRow key={link.id}>
                    <TableCell className="font-mono text-base">{link.id.slice(0, 14)}…</TableCell>
                    <TableCell className="text-base text-muted-foreground">
                      {formatRelativeTime(link.createdAt)}
                    </TableCell>
                    <TableCell className="text-base text-muted-foreground">
                      {link.expiresAt === 0 ? "Never" : formatRelativeTime(link.expiresAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleCopy(link.slug, link.id)}
                        disabled={busy}
                      >
                        {copiedLinkId === link.id ? <Check aria-hidden /> : <Copy aria-hidden />}
                        {copiedLinkId === link.id ? "Copied" : "Copy"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRevoke(link.id)}
                        disabled={busy}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {inactiveLinks.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-base font-semibold">History ({inactiveLinks.length})</h3>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Link</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inactiveLinks.map((link) => {
                  const revoked = link.revokedAt !== null;
                  return (
                    <TableRow key={link.id}>
                      <TableCell className="font-mono text-base">{link.id.slice(0, 14)}…</TableCell>
                      <TableCell>
                        <Badge variant={revoked ? "danger" : "warning"}>
                          {revoked ? "Revoked" : "Expired"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-base text-muted-foreground">
                        {formatRelativeTime(link.revokedAt ?? link.expiresAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </Dialog>
  );
}
