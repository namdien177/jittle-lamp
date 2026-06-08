import React, { useEffect, useState } from "react";
import { UserButton } from "@clerk/clerk-react";
import { Link, NavLink, useLocation } from "react-router";
import {
  Archive,
  Building2,
  ExternalLink,
  FileText,
  FlaskConical,
  LayoutDashboard,
  PanelLeft,
  Puzzle,
  Settings,
  Video,
  X,
} from "lucide-react";

import { cn } from "../../lib/cn";
import { useEvidences } from "../../queries";
import { Badge } from "../ui/badge";
import { buttonVariants } from "../ui/button";
import { Wordmark } from "../brand";
import { EvidenceSearch } from "./evidence-search";
import { OrgSwitcher } from "./org-switcher";
import { userButtonAppearance } from "../../clerk-appearance";

const CHROME_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/ddllejobfkkbmijlflllnnfihfbmhmfh";

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  end?: boolean;
  soon?: boolean;
  count?: number;
};

type NavGroup = { heading: string; items: NavItem[] };

function useNavGroups(): NavGroup[] {
  const evidencesQuery = useEvidences();
  const evidenceCount = evidencesQuery.data?.total;

  return [
    {
      heading: "Workspace",
      items: [
        { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
        {
          to: "/evidence",
          label: "Evidence",
          icon: Video,
          ...(evidenceCount !== undefined ? { count: evidenceCount } : {}),
        },
      ],
    },
    {
      heading: "Library",
      items: [
        {
          to: "/test-cases",
          label: "Test cases",
          icon: FlaskConical,
          soon: true,
        },
        { to: "/documents", label: "Documents", icon: FileText, soon: true },
      ],
    },
    {
      heading: "Tools",
      items: [{ to: "/quick-view", label: "Quick view", icon: Archive }],
    },
    {
      heading: "Organisation",
      items: [
        { to: "/organisations", label: "Organisations", icon: Building2 },
        { to: "/settings", label: "Settings", icon: Settings },
      ],
    },
  ];
}

function SidebarLink({
  item,
  onNavigate,
}: {
  item: NavItem;
  onNavigate?: () => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-base font-medium transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/80 hover:bg-white/[0.04] hover:text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            aria-hidden
            className={cn(
              "size-[1.05rem] shrink-0 transition-colors",
              isActive
                ? "text-primary"
                : "text-muted-foreground group-hover:text-foreground",
            )}
          />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.soon ? (
            <Badge variant="muted" className="px-1.5 py-0 uppercase">
              Soon
            </Badge>
          ) : item.count !== undefined ? (
            <span className="font-mono tabular-nums text-muted-foreground">
              {item.count}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function SidebarContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}): React.JSX.Element {
  const groups = useNavGroups();
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-5 jl-scroll">
      <Link to="/" onClick={onNavigate} className="px-1.5">
        <Wordmark />
      </Link>
      <nav className="flex flex-1 flex-col gap-5" aria-label="Workspace">
        {groups.map((group) => (
          <div key={group.heading} className="flex flex-col gap-1">
            <p className="px-2.5 pb-1 font-semibold uppercase tracking-[0.09em] text-muted-foreground/70">
              {group.heading}
            </p>
            {group.items.map((item) => (
              <SidebarLink
                key={item.to}
                item={item}
                {...(onNavigate ? { onNavigate } : {})}
              />
            ))}
          </div>
        ))}
      </nav>
    </div>
  );
}

export function WorkspaceShell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-[200] md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/65 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-72 animate-rise border-r border-sidebar-border bg-sidebar">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute right-3 top-4 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              onClick={() => setMobileOpen(false)}
            >
              <X className="size-4" aria-hidden />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
          <button
            type="button"
            aria-label="Open navigation"
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground md:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <PanelLeft className="size-5" aria-hidden />
          </button>
          <div className="md:hidden">
            <Wordmark showMark />
          </div>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <EvidenceSearch />
            <a
              href={CHROME_EXTENSION_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Install Chrome Extension"
              title="Install Chrome Extension"
              className={cn(
                buttonVariants({ variant: "outline", size: "icon" }),
                "sm:hidden",
              )}
            >
              <Puzzle aria-hidden />
            </a>
            <a
              href={CHROME_EXTENSION_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "hidden sm:inline-flex",
              )}
            >
              <Puzzle aria-hidden />
              Install Chrome Extension
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
            <OrgSwitcher />
            <div className="h-6 w-px bg-border" aria-hidden />
            <UserButton
              appearance={userButtonAppearance}
              userProfileMode="modal"
            />
          </div>
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
