import React, { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { Archive, ArrowRight, Building2, Clock, Plus, Video } from "lucide-react";

import { PageBody, PageHeader } from "../components/page";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { EmptyState, Skeleton } from "../components/ui/misc";
import { cn } from "../lib/cn";
import { useAccountProfile, useEvidences } from "../queries";
import { formatRelativeTime } from "../utils";

function StatCard(props: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {props.label}
          </p>
          <p className="font-display text-3xl font-bold tracking-tight tabular-nums">{props.value}</p>
          {props.hint ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
        </div>
        <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-secondary text-primary [&_svg]:size-5">
          {props.icon}
        </span>
      </CardContent>
    </Card>
  );
}

export function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate();
  const profileQuery = useAccountProfile();
  const evidencesQuery = useEvidences();

  const profile = profileQuery.data ?? null;
  const evidences = evidencesQuery.data?.evidences ?? [];
  const evidenceTotal = evidencesQuery.data?.total ?? evidences.length;
  const activeOrg = profile?.organizations.find((org) => org.isActive) ?? null;
  const firstName = profile?.user.displayName?.split(" ")[0] ?? "there";

  const recent = useMemo(
    () => [...evidences].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [evidences]
  );
  const lastCapture = recent[0] ?? null;
  const loading = evidencesQuery.isPending || profileQuery.isPending;

  return (
    <>
      <PageHeader
        eyebrow={activeOrg ? activeOrg.name : "Workspace"}
        title={`Welcome back, ${firstName}`}
        description="Your QA evidence at a glance. Capture from the extension, review here, and share scoped links with your team."
        actions={
          <>
            <Link to="/quick-view" className={cn(buttonVariants({ variant: "outline" }))}>
              <Archive aria-hidden />
              Open a ZIP
            </Link>
            <Button onClick={() => navigate("/evidence")}>
              <Video aria-hidden />
              Browse evidence
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            icon={<Video aria-hidden />}
            label="Evidence captured"
            value={loading ? <Skeleton className="h-8 w-12" /> : evidenceTotal}
            hint="in this workspace"
          />
          <StatCard
            icon={<Building2 aria-hidden />}
            label="Organisations"
            value={loading ? <Skeleton className="h-8 w-12" /> : profile?.organizations.length ?? 0}
            hint={activeOrg ? `Active: ${activeOrg.name}` : "No active workspace"}
          />
          <StatCard
            icon={<Clock aria-hidden />}
            label="Last capture"
            value={
              loading ? (
                <Skeleton className="h-8 w-24" />
              ) : lastCapture ? (
                <span className="text-xl">{formatRelativeTime(lastCapture.updatedAt)}</span>
              ) : (
                <span className="text-xl text-muted-foreground">—</span>
              )
            }
            {...(lastCapture ? { hint: lastCapture.title } : {})}
          />
        </div>

        <Card>
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <h2 className="font-display text-base font-semibold tracking-tight">Recent evidence</h2>
              <p className="text-sm text-muted-foreground">The latest sessions uploaded here.</p>
            </div>
            <Link
              to="/evidence"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              View all
              <ArrowRight aria-hidden />
            </Link>
          </div>
          <CardContent className="p-2">
            {loading ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <EmptyState
                className="m-2 border-0 bg-transparent py-10"
                icon={<Video aria-hidden />}
                title="No evidence yet"
                description="Capture a session with the extension or open a local ZIP to get started."
                action={
                  <Button size="sm" onClick={() => navigate("/quick-view")}>
                    <Plus aria-hidden />
                    Open a local archive
                  </Button>
                }
              />
            ) : (
              <ul>
                {recent.map((evidence) => (
                  <li key={evidence.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/evidence/${encodeURIComponent(evidence.id)}`)}
                      className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left transition-colors hover:bg-white/[0.03]"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground">
                        <Video aria-hidden className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {evidence.title}
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {evidence.id.slice(0, 16)}…
                        </span>
                      </span>
                      <Badge variant="muted" className="capitalize">
                        {evidence.sourceType}
                      </Badge>
                      <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                        {formatRelativeTime(evidence.updatedAt)}
                      </span>
                      <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
