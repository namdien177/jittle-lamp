import React, { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import {
  Archive,
  Building2,
  ChevronRight,
  ClipboardCheck,
  FileUp,
  FlaskConical,
  Inbox,
  Moon,
  Puzzle,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  UploadCloud,
  Video,
} from "lucide-react";

import { UserButton } from "../../auth";
import { NotificationBell } from "../../notifications/notification-bell";
import { testingSettingsLabel } from "../../pages/settings-test-cases/nav";
import { testingSettingsBase } from "../../pages/settings-test-cases/routes";
import { useAccountProfile } from "../../queries";
import { PageHeaderSlotProvider } from "../page";
import { Kbd } from "../ui/kbd";
import { Separator } from "../ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { TooltipProvider } from "../ui/tooltip";
import { useUploadEvidence } from "../upload-evidence-button";
import { EvidenceSearch, searchShortcutLabel } from "./evidence-search";
import { OrgSwitcher } from "./org-switcher";

const CHROME_EXTENSION_URL = "https://chromewebstore.google.com/detail/ddllejobfkkbmijlflllnnfihfbmhmfh";

type Icon = React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
type NavItem = { to: string; label: string; icon: Icon; tooltip?: string; match?: (pathname: string) => boolean };
type NavGroup = { label: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    label: "Evidence",
    items: [
      { to: "/evidence", label: "Recordings", icon: Video },
      { to: "/quick-view", label: "Open local file", icon: Archive },
    ],
  },
  {
    label: "Testing",
    items: [
      {
        to: "/test-cases",
        label: "Test cases",
        icon: FlaskConical,
        match: (pathname) =>
          (pathname.startsWith("/test-cases") && !/^\/test-cases\/(review|import|settings)(\/|$)/.test(pathname)) || pathname.startsWith("/test-runs"),
      },
      { to: "/test-cases/review", label: "Review queue", icon: ClipboardCheck },
      { to: "/test-cases/import", label: "Import", icon: FileUp },
      { to: testingSettingsBase, label: "Settings", tooltip: "Testing settings", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Workspace",
    items: [
      { to: "/organisations", label: "Organisations", icon: Building2 },
      { to: "/settings", label: "Account", icon: Settings },
    ],
  },
];

function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match(pathname);
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

type Crumb = { label: string; to?: string };

/** Route-derived trail; the last crumb is replaced by the page's own <PageHeader> title. */
export function breadcrumbsFor(pathname: string): Crumb[] {
  if (pathname.startsWith("/evidence")) return [{ label: "Evidence" }, { label: "Recordings" }];
  if (pathname.startsWith("/quick-view")) return [{ label: "Evidence" }, { label: "Open local file" }];
  if (pathname.startsWith(testingSettingsBase)) {
    return [{ label: "Testing" }, { label: "Settings", to: testingSettingsBase }, { label: testingSettingsLabel(pathname) ?? "Variables" }];
  }
  if (pathname.startsWith("/test-cases/review")) return [{ label: "Testing", to: "/test-cases" }, { label: "Review queue" }];
  if (/^\/test-cases\/import\/[^/]+/.test(pathname)) return [{ label: "Testing", to: "/test-cases" }, { label: "Import", to: "/test-cases/import" }, { label: "Batch" }];
  if (pathname.startsWith("/test-cases/import")) return [{ label: "Testing", to: "/test-cases" }, { label: "Import" }];
  if (pathname.startsWith("/test-cases")) return [{ label: "Testing" }, { label: "Test cases" }];
  if (pathname.startsWith("/test-runs")) return [{ label: "Testing" }, { label: "Test cases", to: "/test-cases" }, { label: "Run" }];
  if (/^\/organisations\/[^/]+/.test(pathname)) return [{ label: "Workspace" }, { label: "Organisations", to: "/organisations" }, { label: "Organisation" }];
  if (pathname.startsWith("/organisations")) return [{ label: "Workspace" }, { label: "Organisations" }];
  if (pathname.startsWith("/settings")) return [{ label: "Workspace" }, { label: "Account" }];
  if (pathname.startsWith("/documents")) return [{ label: "Documents" }];
  return [{ label: "Workspace" }];
}

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("jl-theme");
    if (stored === "dark") return true;
    if (stored === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    window.localStorage.setItem("jl-theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, () => setDark((value) => !value)];
}

function NavMenuItem({ item, pathname }: { item: NavItem; pathname: string }): React.JSX.Element {
  const Icon = item.icon;
  const active = isItemActive(item, pathname);
  return (
    <SidebarMenuItem>
      {/* `end` keeps NavLink's aria-current exact; `isActive` also covers nested routes. */}
      <SidebarMenuButton render={<NavLink to={item.to} end />} isActive={active} tooltip={item.tooltip ?? item.label}>
        <Icon aria-hidden />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function QuickActions({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const upload = useUploadEvidence();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <EvidenceSearch
          renderTrigger={(open) => (
            <SidebarMenuButton onClick={open} tooltip={`Search · ${searchShortcutLabel}`}>
              <Search aria-hidden />
              <span>Search</span>
            </SidebarMenuButton>
          )}
        />
        <SidebarMenuBadge>
          <Kbd className="bg-transparent">{searchShortcutLabel}</Kbd>
        </SidebarMenuBadge>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <NotificationBell side="right" align="start">
          {(trigger, state) => (
            <>
              <SidebarMenuButton render={trigger} aria-label={state.label} tooltip={state.badge ? `Inbox · ${state.badge}` : "Inbox"}>
                <Inbox aria-hidden />
                <span>Inbox</span>
              </SidebarMenuButton>
              {state.badge ? (
                <SidebarMenuBadge className="bg-primary/15 text-foreground">{state.badge}</SidebarMenuBadge>
              ) : null}
            </>
          )}
        </NotificationBell>
      </SidebarMenuItem>
      {!readOnly ? (
        <SidebarMenuItem>
          <SidebarMenuButton onClick={upload.pick} disabled={upload.uploading} tooltip="Upload evidence">
            {upload.uploading ? <Spinner /> : <UploadCloud aria-hidden />}
            <span>{upload.uploading ? "Uploading…" : "Upload evidence"}</span>
          </SidebarMenuButton>
          {upload.input}
        </SidebarMenuItem>
      ) : null}
    </SidebarMenu>
  );
}

function SidebarUser({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }): React.JSX.Element {
  const profile = useAccountProfile();
  const user = profile.data?.user;
  return (
    <div className="flex items-center gap-2 group-data-[collapsible=icon]:flex-col">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
        <UserButton />
        <div className="min-w-0 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-sm font-medium text-foreground">{user?.displayName ?? "Signed in"}</p>
          <p className="truncate text-xs text-muted-foreground">{user?.email ?? ""}</p>
        </div>
      </div>
      <SidebarMenuButton
        onClick={onToggleTheme}
        aria-label="Toggle theme"
        tooltip={dark ? "Light theme" : "Dark theme"}
        className="size-7 shrink-0 justify-center p-0"
      >
        {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
      </SidebarMenuButton>
    </div>
  );
}

function AppSidebar({ pathname, readOnly, dark, onToggleTheme }: { pathname: string; readOnly: boolean; dark: boolean; onToggleTheme: () => void }): React.JSX.Element {
  const { setOpenMobile } = useSidebar();
  const profile = useAccountProfile();
  const organisationPath = profile.data?.activeOrgId ? `/organisations/${profile.data.activeOrgId}` : "/organisations";
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  return (
    <Sidebar>
      <SidebarHeader className="gap-2 pb-1 pt-2.5">
        <SidebarMenu>
          <SidebarMenuItem>
            <OrgSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
        <QuickActions readOnly={readOnly} />
      </SidebarHeader>
      <SidebarContent className="pt-1">
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const resolvedItem = item.label === "Organisations" ? { ...item, to: organisationPath } : item;
                  return <NavMenuItem key={item.label} item={resolvedItem} pathname={pathname} />;
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="gap-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href={CHROME_EXTENSION_URL} target="_blank" rel="noreferrer" />} tooltip="Get the browser extension">
              <Puzzle aria-hidden />
              <span>Browser extension</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarUser dark={dark} onToggleTheme={onToggleTheme} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function InsetHeader({ crumbs, titleRef, actionsRef }: { crumbs: Crumb[]; titleRef: (node: HTMLSpanElement | null) => void; actionsRef: (node: HTMLDivElement | null) => void }): React.JSX.Element {
  const parents = crumbs.slice(0, -1);
  const current = crumbs[crumbs.length - 1];
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2 md:px-3">
      <SidebarTrigger className="-ml-0.5" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted-foreground">
        {parents.map((crumb) => (
          <React.Fragment key={crumb.label}>
            {crumb.to ? (
              <Link to={crumb.to} className="hidden shrink-0 transition-colors hover:text-foreground sm:inline">
                {crumb.label}
              </Link>
            ) : (
              <span className="hidden shrink-0 sm:inline">{crumb.label}</span>
            )}
            <ChevronRight aria-hidden className="hidden size-3.5 shrink-0 opacity-60 sm:inline" />
          </React.Fragment>
        ))}
        {/* <PageHeader> portals its title here; the route label shows until it does. */}
        <span ref={titleRef} aria-current="page" className="peer/title flex min-w-0 items-center empty:hidden" />
        <span className="truncate font-medium text-foreground peer-[:not(:empty)]/title:hidden">{current?.label}</span>
      </nav>
      <div ref={actionsRef} className="flex shrink-0 items-center gap-1.5" />
    </header>
  );
}

export function WorkspaceShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const location = useLocation();
  const accountProfile = useAccountProfile();
  const activeOrganization = accountProfile.data?.organizations.find((organization) => organization.id === accountProfile.data.activeOrgId);
  const migrationReadOnly = Boolean(
    activeOrganization?.migrationAccessState && !["writable", "diverged"].includes(activeOrganization.migrationAccessState),
  );
  const [dark, toggleTheme] = useTheme();
  const [titleSlot, setTitleSlot] = useState<HTMLSpanElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);

  const isEvidenceDetail = /^\/evidence\/[^/]+/.test(location.pathname);
  const isFillPage = /^\/(test-cases|test-runs)(\/|$)/.test(location.pathname) && !/^\/test-cases\/(settings|import|review)(\/|$)/.test(location.pathname);

  return (
    <TooltipProvider>
      <SidebarProvider className="jl-app" data-evidence-focus={isEvidenceDetail ? "true" : undefined}>
        <AppSidebar pathname={location.pathname} readOnly={migrationReadOnly} dark={dark} onToggleTheme={toggleTheme} />
        <SidebarInset>
          {/* The evidence viewer brings its own header bar (back, title, share, download). */}
          {!isEvidenceDetail ? <InsetHeader crumbs={breadcrumbsFor(location.pathname)} titleRef={setTitleSlot} actionsRef={setActionsSlot} /> : null}
          {migrationReadOnly ? (
            <div role="status" className="border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-center text-sm text-foreground">
              This organisation is read-only during migration.{" "}
              <Link className="font-medium underline underline-offset-2" to="/settings/migration">
                View migration
              </Link>
              {activeOrganization?.migrationDestinationWebOrigin ? (
                <>
                  {" · "}
                  <a className="font-medium underline underline-offset-2" href={activeOrganization.migrationDestinationWebOrigin} rel="noreferrer" target="_blank">
                    Open destination
                  </a>
                </>
              ) : null}
            </div>
          ) : null}
          <PageHeaderSlotProvider slots={{ title: titleSlot, actions: actionsSlot }}>
            {isEvidenceDetail ? (
              <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            ) : isFillPage ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&>*]:min-h-0 [&>*]:flex-1">{children}</div>
            ) : (
              <div className="jl-scroll min-h-0 flex-1 overflow-y-auto">
                <div className="flex min-h-full flex-col px-4 py-5 md:px-6">{children}</div>
              </div>
            )}
          </PageHeaderSlotProvider>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
