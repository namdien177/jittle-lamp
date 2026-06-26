import React, { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import {
  Archive,
  ArrowRight,
  Building2,
  Clock,
  ExternalLink,
  Plus,
  Settings,
  Video,
} from "lucide-react";

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
    <Card className="p-0">
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="jl-stat-label">
            {props.label}
          </p>
          <div className="jl-stat-value truncate tabular-nums">
            {props.value}
          </div>
          {props.hint ? (
            <p className="truncate font-mono text-xs text-muted-foreground">{props.hint}</p>
          ) : null}
        </div>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-primary [&_svg]:size-5">
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
    [evidences],
  );
  const lastCapture = recent[0] ?? null;
  const loading = evidencesQuery.isPending || profileQuery.isPending;

  return (
    <>
      <PageHeader
        eyebrow={activeOrg ? activeOrg.name : "Workspace"}
        title="Dashboard"
        description={`Workspace overview for ${firstName}.`}
        actions={
          <>
            <Link
              to="/quick-view"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
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
        <div className="jl-stat-grid">
          <StatCard
            icon={<Video aria-hidden />}
            label="Evidence captured"
            value={loading ? <Skeleton className="h-8 w-12" /> : evidenceTotal}
            hint="workspace"
          />
          <StatCard
            icon={<Building2 aria-hidden />}
            label="Organisations"
            value={
              loading ? (
                <Skeleton className="h-8 w-12" />
              ) : (
                (profile?.organizations.length ?? 0)
              )
            }
            hint={activeOrg?.name ?? "No active workspace"}
          />
          <StatCard
            icon={<Clock aria-hidden />}
            label="Last capture"
            value={
              loading ? (
                <Skeleton className="h-8 w-24" />
              ) : lastCapture ? (
                <span className="text-xl">
                  {formatRelativeTime(lastCapture.updatedAt)}
                </span>
              ) : (
                <span className="text-xl text-muted-foreground">—</span>
              )
            }
            {...(lastCapture ? { hint: lastCapture.title } : {})}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-xl font-bold">Recent evidence</h2>
              <Link
                to="/evidence"
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
              >
                View all
                <ArrowRight aria-hidden />
              </Link>
            </div>
            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <EmptyState
                className="border-0 bg-transparent py-10"
                icon={<Video aria-hidden />}
                title="No evidence yet"
                description="Install the extension or open a ZIP."
                action={
                  <Button size="sm" onClick={() => navigate("/quick-view")}>
                    <Plus aria-hidden />
                    Open local archive
                  </Button>
                }
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {recent.map((evidence) => (
                  <li key={evidence.id}>
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/evidence/${encodeURIComponent(evidence.id)}`)
                      }
                      className="jl-row-card w-full text-left"
                    >
                      <span className="jl-thumb h-10 w-16 shrink-0">
                        <Video aria-hidden className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-display text-base font-bold text-foreground">
                          {evidence.title}
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {evidence.sourceType} · {evidence.id.slice(0, 16)}…
                        </span>
                      </span>
                      <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:block">
                        {formatRelativeTime(evidence.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside>
            <div className="mb-4">
              <h2 className="font-display text-xl font-bold">Quick actions</h2>
            </div>
            <div className="flex flex-col gap-3">
              <Link to="/quick-view" className="jl-row-card">
                <Archive className="size-5 shrink-0 text-primary" aria-hidden />
                <span>
                  <strong className="block">Open local ZIP</strong>
                  <span className="text-sm text-muted-foreground">Review without upload</span>
                </span>
              </Link>
              <Link to="/evidence" className="jl-row-card">
                <Video className="size-5 shrink-0 text-primary" aria-hidden />
                <span>
                  <strong className="block">Browse evidence</strong>
                  <span className="text-sm text-muted-foreground">Search cloud records</span>
                </span>
              </Link>
              <Link to="/organisations" className="jl-row-card">
                <Building2 className="size-5 shrink-0 text-primary" aria-hidden />
                <span>
                  <strong className="block">Manage team</strong>
                  <span className="text-sm text-muted-foreground">People and roles</span>
                </span>
              </Link>
              <Link to="/settings" className="jl-row-card">
                <Settings className="size-5 shrink-0 text-primary" aria-hidden />
                <span>
                  <strong className="block">Tokens</strong>
                  <span className="text-sm text-muted-foreground">AI and API access</span>
                </span>
              </Link>
              <a
                href="https://chromewebstore.google.com/detail/ddllejobfkkbmijlflllnnfihfbmhmfh"
                target="_blank"
                rel="noreferrer"
                className="jl-row-card"
              >
                <ExternalLink className="size-5 shrink-0 text-primary" aria-hidden />
                <span>
                  <strong className="block">Install extension</strong>
                  <span className="text-sm text-muted-foreground">Capture from Chromium</span>
                </span>
              </a>
            </div>
          </aside>
        </div>
      </PageBody>
    </>
  );
}
