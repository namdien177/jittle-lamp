import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { formatOffset, type TimelineItem, type TimelineSection } from "@jittle-lamp/shared";
import { deriveSectionTimeline } from "@jittle-lamp/viewer-core";
import { BookOpen, Building2, ChevronDown, Cloud, LogOut, Settings, User } from "lucide-react";
import { MemoryRouter, Navigate, NavLink, Outlet, useLocation, useNavigate, useRoutes } from "react-router";
import {
  ViewerModal,
  buildCurl,
  getResponseBodyString,
  type JittleRouteObject,
  type ViewerContextMenuState,
  type ViewerModalFeedback,
  type ViewerModalRow,
  type ViewerSource as SharedViewerSource
} from "@jittle-lamp/viewer-react";

import {
  DesktopAuthProvider,
  DesktopClerkProvider,
  clerkPublishableKey,
  useDesktopAuth
} from "./auth-context";
import { useDesktopController, type DesktopController } from "./desktop-controller";
import { LibraryPage } from "./pages/library-page";
import { CloudPage } from "./pages/cloud-page";
import { OrganisationPage } from "./pages/organisation-page";
import { AccountPage } from "./pages/account-page";
import { SettingsPage } from "./pages/settings-page";
import { ToastProvider, useToast } from "./ui/toast";
import { createDesktopNotesAdapter } from "./adapters";
import { formatRuntimeLabel } from "./catalog-view";
import { createQueryClient } from "./queries";
import { getInitials } from "./utils";

const signInPath = "/sign-in";
const homePath = "/";

const DesktopControllerContext = React.createContext<DesktopController | null>(null);

function useDesktop(): DesktopController {
  const ctx = React.useContext(DesktopControllerContext);
  if (!ctx) throw new Error("Desktop controller is unavailable");
  return ctx;
}

function AuthStatusPage(props: { title: string; detail?: string }): React.JSX.Element {
  return (
    <main className="auth-page">
      <div className="auth-status" role="status">
        <span className="auth-status-title">{props.title}</span>
        {props.detail ? <span className="auth-status-detail">{props.detail}</span> : null}
      </div>
    </main>
  );
}

function MissingClerkConfigPage(): React.JSX.Element {
  return (
    <AuthStatusPage
      title="Clerk is not configured"
      detail="Set CLERK_PUBLISHABLE_KEY before starting the desktop app."
    />
  );
}

function SignInPage(): React.JSX.Element {
  const navigate = useNavigate();
  const auth = useDesktopAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (auth.state.status === "signed-in") {
    return <Navigate to={homePath} replace />;
  }

  const submitPasswordSignIn = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const result = await auth.signInWithPassword({ identifier: identifier.trim(), password });
    setIsSubmitting(false);
    if (result.ok) {
      navigate(homePath, { replace: true });
      return;
    }
    setError(result.message);
  };

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-card-header">
          <h1>Welcome to Jittle Lamp</h1>
          <p>Sign in with your password or finish OAuth in your browser.</p>
        </div>
        <form className="auth-form" onSubmit={submitPasswordSignIn}>
          <label className="field">
            <span>Email or username</span>
            <input
              className="input field-input"
              type="text"
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.currentTarget.value)}
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input field-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
            />
          </label>
          {error ? <div className="auth-error">{error}</div> : null}
          {auth.state.status === "error" ? <div className="auth-error">{auth.state.message}</div> : null}
          <button className="button primary lg" type="submit" disabled={isSubmitting || auth.state.status === "loading"}>
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="auth-divider" />
        <button
          className="button secondary lg"
          type="button"
          disabled={auth.browserFlow.status === "starting" || auth.browserFlow.status === "polling"}
          onClick={() => void auth.startBrowserSignIn()}
        >
          {auth.browserFlow.status === "starting" ? "Opening browser…" : "Continue in browser"}
        </button>
        {auth.browserFlow.status === "polling" ? (
          <div className="auth-browser-flow" role="status">
            <span>Waiting for browser sign-in</span>
            <strong>{auth.browserFlow.userCode}</strong>
            <a href={auth.browserFlow.verificationUriComplete} target="_blank" rel="noreferrer">
              Open sign-in page
            </a>
            <button className="button ghost xs" type="button" onClick={auth.clearBrowserFlow}>
              Cancel
            </button>
          </div>
        ) : null}
        {auth.browserFlow.status === "error" ? <div className="auth-error">{auth.browserFlow.message}</div> : null}
      </section>
    </main>
  );
}

function RequireAuth(props: { children: React.ReactNode }): React.JSX.Element {
  const auth = useDesktopAuth();

  if (auth.state.status === "loading") {
    return <AuthStatusPage title="Checking session…" />;
  }
  if (auth.state.status === "signed-in") {
    return <>{props.children}</>;
  }
  return <Navigate to={signInPath} replace />;
}

function Sidebar(): React.JSX.Element {
  const desktop = useDesktop();
  const auth = useDesktopAuth();
  const navigate = useNavigate();
  const profile = auth.state.status === "signed-in" ? auth.state.profile ?? null : null;
  const activeOrg = profile?.organizations.find((org) => org.isActive) ?? null;
  const accountLabel = auth.state.status === "signed-in" ? auth.state.label : "Signed out";
  const sessionCount = desktop.state.sessions.length;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (event: MouseEvent): void => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [menuOpen]);

  const goto = (path: string): void => {
    setMenuOpen(false);
    navigate(path);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img className="sidebar-brand-mark" src="./logo.jpg" alt="" aria-hidden="true" />
        <div className="column" style={{ gap: 2 }}>
          <span className="sidebar-brand-name">Jittle Lamp</span>
          <span className="sidebar-brand-version">v0.1.6 · desktop</span>
        </div>
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section-label">Workspace</span>
        <NavLink to="/" end className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
          <BookOpen className="sidebar-link-icon" aria-hidden size={16} strokeWidth={2} />
          <span>Library</span>
          <span className="sidebar-link-count">{sessionCount}</span>
        </NavLink>
        <NavLink to="/cloud" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
          <Cloud className="sidebar-link-icon" aria-hidden size={16} strokeWidth={2} />
          <span>Cloud evidences</span>
        </NavLink>
        <NavLink to="/organisations" className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}>
          <Building2 className="sidebar-link-icon" aria-hidden size={16} strokeWidth={2} />
          <span>Organisations</span>
        </NavLink>
      </div>

      <div className="sidebar-footer" ref={menuRef}>
        {menuOpen ? (
          <div className="sidebar-account-menu" role="menu">
            <button
              className="sidebar-account-menu-item"
              type="button"
              role="menuitem"
              onClick={() => goto("/account")}
            >
              <User aria-hidden size={15} strokeWidth={2} />
              <span>Account</span>
            </button>
            <button
              className="sidebar-account-menu-item"
              type="button"
              role="menuitem"
              onClick={() => goto("/account/companion")}
            >
              <Settings aria-hidden size={15} strokeWidth={2} />
              <span>Companion settings</span>
            </button>
            {auth.state.status === "signed-in" ? (
              <>
                <div className="sidebar-account-menu-divider" />
                <button
                  className="sidebar-account-menu-item danger"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void auth.signOut();
                  }}
                >
                  <LogOut aria-hidden size={15} strokeWidth={2} />
                  <span>Sign out</span>
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="sidebar-account"
          aria-haspopup="menu"
          aria-expanded={menuOpen ? "true" : "false"}
          onClick={() => setMenuOpen((prev) => !prev)}
        >
          <div className="sidebar-account-avatar">{getInitials(accountLabel)}</div>
          <div className="sidebar-account-meta">
            <span className="sidebar-account-name">{accountLabel}</span>
            <span className="sidebar-account-org">{activeOrg ? activeOrg.name : "No active workspace"}</span>
          </div>
          <ChevronDown className="sidebar-account-chevron" aria-hidden size={15} strokeWidth={2} />
        </button>
      </div>
    </aside>
  );
}

function MainHeader(): React.JSX.Element {
  const desktop = useDesktop();
  const status = desktop.state.runtime?.status ?? "starting";
  return (
    <div className="main-header">
      <div className="main-header-title">
        <h1>Asset manager</h1>
        <span>{desktop.state.runtime?.outputDir ?? desktop.state.config?.outputDir ?? "—"}</span>
      </div>
      <div className="main-header-actions">
        <span className="status-pill" data-status={status}>{formatRuntimeLabel(status)}</span>
        <button className="button ghost sm" type="button" onClick={desktop.openLocalSession}>
          Open local
        </button>
        <button className="button ghost sm" type="button" onClick={desktop.importZip}>
          Import ZIP
        </button>
      </div>
    </div>
  );
}

function DesktopAppLayout(): React.JSX.Element {
  const auth = useDesktopAuth();
  const desktop = useDesktopController({ authStatus: auth.state.status, getAuthToken: auth.getToken });

  return (
    <DesktopControllerContext.Provider value={desktop}>
      <div className="app-shell">
        <Sidebar />
        <div className="main-area">
          <MainHeader />
          <div className="main-content">
            <Outlet />
          </div>
        </div>
      </div>
      <DesktopViewerOverlay />
    </DesktopControllerContext.Provider>
  );
}

function LibraryRoute(): React.JSX.Element {
  return <LibraryPage desktop={useDesktop()} />;
}

function SettingsRoute(): React.JSX.Element {
  return <SettingsPage desktop={useDesktop()} />;
}

function AccountLayout(): React.JSX.Element {
  const location = useLocation();
  const isCompanion = location.pathname === "/account/companion";

  return (
    <div className="page">
      <div className="account-tabs" aria-label="Account sections">
        <NavLink to="/account" end className={({ isActive }) => `account-tab ${isActive ? "active" : ""}`}>
          Account
        </NavLink>
        <NavLink
          to="/account/companion"
          className={({ isActive }) => `account-tab ${isActive || isCompanion ? "active" : ""}`}
        >
          Companion
        </NavLink>
      </div>
      <Outlet />
    </div>
  );
}

function DesktopViewerOverlay(): React.JSX.Element | null {
  const desktop = useDesktop();
  const toast = useToast();
  const payload = desktop.viewerState.payload;
  const notesAdapter = useMemo(() => createDesktopNotesAdapter(), []);
  const [contextMenu, setContextMenu] = useState<ViewerContextMenuState>({
    open: false,
    x: 0,
    y: 0,
    rowId: null,
    kind: "network",
    canMerge: false,
    canUnmerge: false
  });
  const [feedback, setFeedback] = useState<ViewerModalFeedback | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);

  const viewerState = desktop.viewerState;
  const { activeSection, mergeGroups, selectedActionIds, networkSubtypeFilter, networkSearchQuery } = viewerState;

  // `sectionItems` and `rows` are rebuilt only when the viewer-state slices that
  // actually feed them change, instead of on every render of this overlay.
  const sectionItems = useMemo(
    () =>
      payload
        ? deriveSectionTimeline(payload.archive, activeSection, networkSubtypeFilter, networkSearchQuery)
        : [],
    [payload, activeSection, networkSubtypeFilter, networkSearchQuery]
  );

  const rows = useMemo(
    () => buildTimelineRows(desktop).map((row) => mapToModalRow(row, sectionItems)),
    // `buildTimelineRows` reads exactly these viewer-state slices off `desktop`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payload, activeSection, mergeGroups, selectedActionIds, networkSubtypeFilter, networkSearchQuery, sectionItems]
  );

  const onContextMenuClose = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, open: false }));
  }, []);

  const downloadZip = useCallback(async (): Promise<void> => {
    if (!payload) return;
    if (downloadingZip) return;
    setDownloadingZip(true);
    try {
      const result = await desktop.exportSessionZip(payload.archive.sessionId);
      toast.success(`ZIP saved to ${result.savedPath}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export ZIP.");
    } finally {
      setDownloadingZip(false);
    }
  }, [payload, downloadingZip, desktop, toast]);

  const onDownloadZip = useCallback(() => void downloadZip(), [downloadZip]);

  const mergeDialog = useMemo(
    () => ({
      open: viewerState.mergeDialogOpen,
      value: viewerState.mergeDialogValue,
      error: viewerState.mergeDialogError
    }),
    [viewerState.mergeDialogOpen, viewerState.mergeDialogValue, viewerState.mergeDialogError]
  );

  if (!desktop.viewerState.open || !payload) return null;

  const readOnlyNotice = notesAdapter.getReadOnlyNotice(payload.source);
  const isReadOnly = !notesAdapter.canEdit(payload.source);

  const drawerItem: TimelineItem | null =
    desktop.viewerState.networkDetailIndex === null
      ? null
      : desktop.viewerState.timeline[desktop.viewerState.networkDetailIndex] ?? null;

  const activeItem = desktop.viewerState.activeIndex >= 0 ? sectionItems[desktop.viewerState.activeIndex] : null;
  const activeItemId = activeItem
    ? desktop.viewerState.activeSection === "actions"
      ? desktop.viewerState.mergeGroups.find((group) => group.memberIds.includes(activeItem.id))?.id ?? activeItem.id
      : activeItem.id
    : null;

  const session = desktop.state.sessions.find(
    (record) => record.sessionId === payload.archive.sessionId
  );
  const tags = session?.tags ?? [];
  const isOwner = payload.source === "library";

  const onCopy = (value: string, label: string): void => {
    void desktop.copyViewerValue(value, label);
    setFeedback({ tone: "success", text: `Copied ${label}.` });
  };

  const findNetworkPayload = (rowId: string): TimelineItem | null => {
    const item = desktop.viewerState.timeline.find((candidate) => candidate.id === rowId);
    return item ?? null;
  };

  return (
    <ViewerModal
      open
      onClose={desktop.closeViewer}
      title={payload.archive.name}
      tags={tags}
      source={mapDesktopSource(payload.source)}
      isOwner={isOwner}
      shareLinkUrl={null}
      onDownloadZip={onDownloadZip}
      downloadingZip={downloadingZip}
      videoRef={desktop.viewerVideoRef}
      notesValue={desktop.viewerState.notesValue}
      notesReadOnly={isReadOnly}
      notesSaving={desktop.viewerState.notesSaving}
      notesDirty={desktop.viewerState.notesDirty}
      notesNotice={readOnlyNotice}
      onNotesChange={desktop.setViewerNotesValue}
      onSaveNotes={desktop.saveViewerNotes}
      onVideoTimeUpdate={desktop.updateTimelineHighlight}
      onVideoError={desktop.handleViewerVideoError}
      activeSection={desktop.viewerState.activeSection}
      onSectionChange={(section: TimelineSection) => desktop.setViewerSection(section)}
      searchQuery={desktop.viewerState.networkSearchQuery}
      onSearchChange={desktop.setViewerSearch}
      subtypeFilter={desktop.viewerState.networkSubtypeFilter}
      onSubtypeFilterChange={desktop.setViewerSubtype}
      rows={rows}
      activeItemId={activeItemId}
      autoFollow={desktop.viewerState.autoFollow}
      onItemClick={(row, event) => {
        desktop.clickTimelineItem(row.id, row.offsetMs, event);
      }}
      onItemContextMenu={(row, event) => {
        if (desktop.viewerState.activeSection === "actions") {
          desktop.openTimelineContext(row.id, event);
          return;
        }
        if (desktop.viewerState.activeSection === "network") {
          setContextMenu({
            open: true,
            x: event.clientX,
            y: event.clientY,
            rowId: row.id,
            kind: "network",
            canMerge: false,
            canUnmerge: false
          });
        }
      }}
      onAutoFollowToggle={desktop.focusViewerTimeline}
      timelineRef={desktop.viewerReactRootRef}
      drawerItem={drawerItem}
      onDrawerClose={desktop.closeNetworkDetail}
      onCopy={onCopy}
      contextMenu={contextMenu}
      onContextMenuClose={onContextMenuClose}
      onCopyCurl={(rowId) => {
        const item = findNetworkPayload(rowId);
        if (item && item.payload.kind === "network") {
          onCopy(buildCurl(item.payload), "cURL command");
        }
      }}
      onCopyResponse={(rowId) => {
        const item = findNetworkPayload(rowId);
        if (item && item.payload.kind === "network") {
          onCopy(getResponseBodyString(item.payload), "response body");
        }
      }}
      mergeDialog={mergeDialog}
      onMergeValueChange={desktop.setMergeValue}
      onMergeConfirm={desktop.submitMergeDialog}
      onMergeCancel={desktop.closeMergeDialog}
      feedback={feedback}
      onFeedbackDismiss={() => setFeedback(null)}
    />
  );
}

function mapDesktopSource(source: "library" | "zip" | "local"): SharedViewerSource {
  if (source === "library") return "local";
  if (source === "zip") return "zip";
  return "local";
}

function mapToModalRow(row: TimelineRow, items: ReadonlyArray<TimelineItem>): ViewerModalRow {
  const item = items.find((candidate) => candidate.id === row.id);
  const status =
    item && item.payload.kind === "network" ? item.payload.status ?? null : null;
  const subtype = item?.kind === "network" ? item.subtype ?? null : null;
  const method = item?.payload.kind === "network" ? item.payload.method : null;
  const url = item?.payload.kind === "network" ? item.payload.url : null;
  const durationMs = item?.payload.kind === "network" ? item.payload.durationMs ?? null : null;
  const base: ViewerModalRow = {
    id: row.id,
    offsetMs: row.offsetMs,
    section: row.section,
    label: row.label,
    kind: row.kind,
    selected: row.selected,
    merged: row.merged,
    tags: row.tags,
    statusCode: status,
    subtype,
    method,
    url,
    durationMs
  };
  return row.mergedRange !== undefined ? { ...base, mergedRange: row.mergedRange } : base;
}

type TimelineRow = {
  id: string;
  offsetMs: number;
  section: TimelineSection;
  label: string;
  kind: string;
  selected: boolean;
  merged: boolean;
  mergedRange?: string;
  tags: string[];
};

function buildTimelineRows(desktop: DesktopController): TimelineRow[] {
  const viewerState = desktop.viewerState;
  const payload = viewerState.payload;
  if (!payload) return [];
  const section = viewerState.activeSection;
  const items = deriveSectionTimeline(payload.archive, section, viewerState.networkSubtypeFilter, viewerState.networkSearchQuery);

  if (section !== "actions") {
    return items.map((item) => ({
      id: item.id,
      offsetMs: item.offsetMs,
      section,
      label: item.label,
      kind: item.kind,
      selected: false,
      merged: false,
      tags: []
    }));
  }

  const mergedMemberIds = new Set(viewerState.mergeGroups.flatMap((group) => group.memberIds));
  const rows: TimelineRow[] = [];
  const seenGroupIds = new Set<string>();

  for (const item of items) {
    const group = viewerState.mergeGroups.find((candidate) => candidate.memberIds.includes(item.id));
    if (group) {
      if (seenGroupIds.has(group.id)) continue;
      seenGroupIds.add(group.id);
      const memberItems = items.filter((candidate) => group.memberIds.includes(candidate.id));
      const firstMs = Math.min(...memberItems.map((candidate) => candidate.offsetMs));
      const lastMs = Math.max(...memberItems.map((candidate) => candidate.offsetMs));
      rows.push({
        id: group.id,
        offsetMs: firstMs,
        section,
        label: group.label,
        kind: "action",
        selected: viewerState.selectedActionIds.has(group.id),
        merged: true,
        mergedRange: `${formatOffset(firstMs)}–${formatOffset(lastMs)}`,
        tags: group.tags
      });
      continue;
    }
    if (mergedMemberIds.has(item.id)) continue;
    rows.push({
      id: item.id,
      offsetMs: item.offsetMs,
      section,
      label: item.label,
      kind: item.kind,
      selected: viewerState.selectedActionIds.has(item.id),
      merged: false,
      tags: item.tags ?? []
    });
  }

  return rows;
}

const desktopRoutes: JittleRouteObject[] = [
  {
    path: `${signInPath}/*`,
    element: <SignInPage />
  },
  {
    path: "/",
    element: (
      <RequireAuth>
        <DesktopAppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <LibraryRoute /> },
      { path: "cloud", element: <CloudPage /> },
      { path: "organisations", element: <OrganisationPage /> },
      { path: "organisations/:orgId", element: <OrganisationPage /> },
      { path: "organisations/:orgId/invitations", element: <OrganisationPage section="invitations" /> },
      { path: "organisations/:orgId/library", element: <OrganisationPage section="library" /> },
      { path: "organisations/:orgId/options", element: <OrganisationPage section="options" /> },
      {
        path: "account",
        element: <AccountLayout />,
        children: [
          { index: true, element: <AccountPage /> },
          { path: "companion", element: <SettingsRoute /> }
        ]
      },
      { path: "settings", element: <Navigate to="/account/companion" replace /> },
      { path: "*", element: <Navigate to={homePath} replace /> }
    ]
  }
];

function DesktopRoutes(): React.JSX.Element {
  const element = useRoutes(desktopRoutes);
  return <>{element}</>;
}

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Desktop main view root element was not found.");

const queryClient = createQueryClient();

createRoot(root).render(
  <MemoryRouter>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        {clerkPublishableKey ? (
          <DesktopClerkProvider>
            <DesktopAuthProvider>
              <DesktopRoutes />
            </DesktopAuthProvider>
          </DesktopClerkProvider>
        ) : (
          <MissingClerkConfigPage />
        )}
        <Analytics />
      </ToastProvider>
    </QueryClientProvider>
  </MemoryRouter>
);
