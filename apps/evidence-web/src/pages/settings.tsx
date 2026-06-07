import React, { useState } from "react";
import { useClerk } from "@clerk/clerk-react";
import { Link } from "react-router";
import {
  Building2,
  Check,
  Copy,
  ExternalLink,
  Terminal,
  UserCog,
} from "lucide-react";

import { PageBody, PageHeader } from "../components/page";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/misc";
import { cn } from "../lib/cn";
import { useAccountProfile } from "../queries";
import { copyToClipboard } from "../utils";

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | bash";

function SettingCard(props: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card className="p-0">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">{props.title}</h2>
        {props.description ? (
          <p className="text-base text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      <CardContent className="p-5 pt-5">{props.children}</CardContent>
    </Card>
  );
}

export function SettingsPage(): React.JSX.Element {
  const clerk = useClerk();
  const profileQuery = useAccountProfile();
  const profile = profileQuery.data ?? null;
  const activeOrg = profile?.organizations.find((org) => org.isActive) ?? null;
  const [copied, setCopied] = useState(false);

  const initials = (profile?.user.displayName ?? profile?.user.email ?? "?")
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const onCopy = (): void => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
    void copyToClipboard(INSTALL_COMMAND).catch(() => undefined);
  };

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        description="Manage your account, active workspace, and the desktop companion."
      />
      <PageBody className="max-w-3xl">
        <SettingCard
          title="Account"
          description="Your profile is managed by Clerk."
        >
          {profileQuery.isPending ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <div className="flex items-center gap-3">
              {profile?.user.imageUrl ? (
                <img
                  src={profile.user.imageUrl}
                  alt=""
                  className="size-11 rounded-lg border border-border object-cover"
                />
              ) : (
                <span className="grid size-11 place-items-center rounded-lg border border-border bg-secondary text-base font-semibold">
                  {initials}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-foreground">
                  {profile?.user.displayName ?? "Signed in"}
                </p>
                <p className="truncate text-base text-muted-foreground">
                  {profile?.user.email ?? "—"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => clerk.openUserProfile()}
              >
                <UserCog aria-hidden />
                Manage account
              </Button>
            </div>
          )}
        </SettingCard>

        <SettingCard
          title="Active workspace"
          description="New uploads land in the active organisation."
        >
          <div className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-lg border border-border bg-secondary text-primary">
              <Building2 className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-foreground">
                {activeOrg?.name ?? "No active workspace"}
              </p>
              <p className="text-base text-muted-foreground">
                {profile
                  ? `${profile.organizations.length} organisation${profile.organizations.length === 1 ? "" : "s"}`
                  : "—"}
              </p>
            </div>
            {activeOrg ? <Badge variant="brand">{activeOrg.role}</Badge> : null}
            <Link
              to="/organisations"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              Switch
            </Link>
          </div>
        </SettingCard>

        <SettingCard
          title="Desktop companion"
          description="Install the macOS companion to receive captures from the extension."
        >
          <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-black/30 pl-3 pr-1.5 font-mono text-base">
            <Terminal aria-hidden className="size-4 shrink-0 text-primary" />
            <code
              className="flex-1 truncate py-2.5 text-muted-foreground"
              title={INSTALL_COMMAND}
            >
              curl ... | bash
            </code>
            <button
              type="button"
              onClick={onCopy}
              className="my-1 inline-flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-white/[0.08]"
            >
              {copied ? (
                <Check className="size-3.5 text-primary" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <a
            href="https://chromewebstore.google.com/detail/ddllejobfkkbmijlflllnnfihfbmhmfh"
            target="_blank"
            rel="noreferrer"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "mt-3",
            )}
          >
            Get the browser extension
            <ExternalLink aria-hidden />
          </a>
        </SettingCard>
      </PageBody>
    </>
  );
}
