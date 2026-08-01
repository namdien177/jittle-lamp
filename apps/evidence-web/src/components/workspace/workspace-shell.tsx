import React, { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import {
  Archive,
  Bell,
  Building2,
  ChevronRight,
  ExternalLink,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
  Settings,
  Sun,
  Video,
  X,
} from "lucide-react";

import { cn } from "../../lib/cn";
import { UserButton } from "../../auth";
import { useAccountProfile, useEvidences } from "../../queries";
import { Badge } from "../ui/badge";
import { buttonVariants } from "../ui/button";
import { UploadEvidenceButton } from "../upload-evidence-button";
import { EvidenceSearch } from "./evidence-search";
import { OrgSwitcher } from "./org-switcher";

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

function getCollapsedNavLabel(item: NavItem): string {
  return item.count === undefined ? item.label : `${item.label} · ${item.count}`;
}

function SidebarLink({
  item,
  onNavigate,
  collapsed = false,
}: {
  item: NavItem;
  onNavigate?: () => void;
  collapsed?: boolean;
}): React.JSX.Element {
  const Icon = item.icon;
  const collapsedLabel = getCollapsedNavLabel(item);
  return (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      onClick={onNavigate}
      title={collapsed ? collapsedLabel : undefined}
      aria-label={collapsed ? collapsedLabel : undefined}
      data-tooltip={collapsed ? collapsedLabel : undefined}
      className={({ isActive }) =>
        cn(
          "jl-nav-item",
          isActive && "is-active font-medium",
        )
      }
    >
      {() => (
        <>
          <span className="jl-nav-icon-wrap">
            <Icon
              aria-hidden
              className={cn(
                "jl-nav-icon",
              )}
            />
            {item.soon ? (
              <span className="jl-nav-soon-dot" aria-hidden />
            ) : null}
          </span>
          <span className="jl-nav-label min-w-0 flex-1 truncate">
            {item.label}
          </span>
          {item.soon ? (
            <Badge variant="muted" className="jl-nav-extra px-1.5 py-0 text-[10px] uppercase">
              Soon
            </Badge>
          ) : item.count !== undefined ? (
            <span className="jl-nav-count jl-nav-extra tabular-nums">
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
  collapsed,
  onToggleCollapsed,
}: {
  onNavigate?: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}): React.JSX.Element {
  const groups = useNavGroups();
  const mainGroups = groups.filter((group) => group.heading !== "Tools");
  const toolsGroup = groups.find((group) => group.heading === "Tools");
  return (
    <>
      <div className="jl-sidebar-brand-row">
        <Link
          to="/"
          onClick={onNavigate}
          className="jl-sidebar-brand"
          title={collapsed ? "Jittle Lamp" : undefined}
          aria-label={collapsed ? "Jittle Lamp" : undefined}
        >
          <img
            src="/logo.jpg"
            alt=""
            className="size-7 shrink-0 rounded-md border border-border object-cover"
          />
          <span className="jl-sidebar-brand-text">Jittle Lamp</span>
        </Link>
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="jl-sidebar-collapse-btn"
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden />
          ) : (
            <PanelLeftClose aria-hidden />
          )}
        </button>
      </div>
      <nav className="flex flex-1 flex-col" aria-label="Workspace">
        {mainGroups.map((group) => (
          <div key={group.heading} className="jl-sidebar-section flex flex-col gap-1">
            <p className="jl-sidebar-section-label">
              {group.heading}
            </p>
            {group.items.map((item) => (
              <SidebarLink
                key={item.to}
                item={item}
                collapsed={collapsed}
                {...(onNavigate ? { onNavigate } : {})}
              />
            ))}
          </div>
        ))}
      </nav>
      <div className="jl-sidebar-footer">
        {toolsGroup ? (
          <div className="flex flex-col gap-1">
            <p className="jl-sidebar-section-label">
              {toolsGroup.heading}
            </p>
            {toolsGroup.items.map((item) => (
              <SidebarLink
                key={item.to}
                item={item}
                collapsed={collapsed}
                {...(onNavigate ? { onNavigate } : {})}
              />
            ))}
          </div>
        ) : null}
        <OrgSwitcher collapsed={collapsed} />
      </div>
    </>
  );
}

function breadcrumbFor(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  if (/^\/evidence\/[^/]+/.test(pathname)) return "Evidence";
  if (pathname.startsWith("/evidence")) return "Evidence library";
  if (pathname.startsWith("/quick-view")) return "Quick view";
  if (pathname.startsWith("/organisations")) return "Organisations";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/test-cases")) return "Test cases";
  if (pathname.startsWith("/documents")) return "Documents";
  return "Workspace";
}

export function WorkspaceShell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const accountProfile = useAccountProfile();
  const activeOrganization = accountProfile.data?.organizations.find(
    (organization) => organization.id === accountProfile.data.activeOrgId,
  );
  const migrationReadOnly = Boolean(
    activeOrganization?.migrationAccessState &&
      !["writable", "diverged"].includes(
        activeOrganization.migrationAccessState,
      ),
  );
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("jl-theme");
    if (stored === "dark") return true;
    if (stored === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("jl-sidebar-collapsed") === "true";
  });

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    window.localStorage.setItem("jl-theme", dark ? "dark" : "light");
  }, [dark]);

  const crumb = breadcrumbFor(location.pathname);
  const isEvidenceDetail = /^\/evidence\/[^/]+/.test(location.pathname);
  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem("jl-sidebar-collapsed", String(next));
      return next;
    });
  };

  return (
    <div
      className="jl-app"
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
    >
      <aside
        className="jl-sidebar jl-scroll"
        data-open={mobileOpen}
        data-collapsed={sidebarCollapsed ? "true" : "false"}
      >
        <SidebarContent
          collapsed={sidebarCollapsed}
          onNavigate={() => setMobileOpen(false)}
          onToggleCollapsed={toggleSidebarCollapsed}
        />
        <button
          type="button"
          aria-label="Close navigation"
          className="jl-sidebar-close absolute right-3 top-4"
          onClick={() => setMobileOpen(false)}
        >
          <X className="size-4" aria-hidden />
        </button>
      </aside>
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="jl-sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

        <header className="jl-topbar">
          <button
            type="button"
            aria-label="Open navigation"
            className="jl-mobile-menu-btn"
            onClick={() => setMobileOpen(true)}
          >
            <Menu aria-hidden />
          </button>
          <div className="jl-breadcrumb">
            {isEvidenceDetail ? (
              <Link to="/evidence" className="jl-breadcrumb-link">
                Workspace
              </Link>
            ) : (
              <span>Workspace</span>
            )}
            <ChevronRight className="size-3.5" aria-hidden />
            <span className="jl-breadcrumb-current">{crumb}</span>
          </div>
          <div className="jl-topbar-spacer" />
          <div className="jl-topbar-actions">
            {!migrationReadOnly ? (
              <>
                <UploadEvidenceButton
                  size="sm"
                  className="hidden md:inline-flex"
                />
                <UploadEvidenceButton
                  variant="outline"
                  iconOnly
                  className="md:hidden"
                />
              </>
            ) : null}
            <EvidenceSearch />
            <button
              type="button"
              aria-label="Toggle theme"
              title="Toggle theme"
              className="jl-theme-toggle hidden sm:grid"
              onClick={() => setDark((value) => !value)}
            >
              {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
            </button>
            <button
              type="button"
              aria-label="Notifications"
              title="Notifications"
              className="jl-theme-toggle hidden sm:grid"
            >
              <Bell aria-hidden />
            </button>
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
            <UserButton />
          </div>
        </header>
        {migrationReadOnly ? (
          <div
            role="status"
            className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          >
            This organisation is read-only during migration.{" "}
            <Link className="font-medium underline" to="/settings/migration">
              View migration
            </Link>
            {activeOrganization?.migrationDestinationWebOrigin ? (
              <>
                {" · "}
                <a
                  className="font-medium underline"
                  href={activeOrganization.migrationDestinationWebOrigin}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open destination
                </a>
              </>
            ) : null}
          </div>
        ) : null}
        <main className="jl-main jl-scroll" data-flush={isEvidenceDetail ? "true" : "false"}>
          {children}
        </main>
    </div>
  );
}
