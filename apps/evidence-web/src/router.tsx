import React from "react";
import {
  createBrowserRouter,
  Outlet,
  redirect,
  ScrollRestoration,
  useLocation,
  useNavigation
} from "react-router";

import { clerkPublishableKey } from "./env";
import { StatusScreen } from "./components/status-screen";
import { Button } from "./components/ui/button";
import { RequireAuth } from "./components/workspace/require-auth";
import { WorkspaceShell } from "./components/workspace/workspace-shell";
import { DesktopAuthApprovalPage, ExtensionAuthApprovalPage } from "./desktop-auth-page";
import { ComingSoonPage } from "./pages/coming-soon";
import { DashboardPage } from "./pages/dashboard";
import { EvidenceLibraryPage } from "./pages/evidence-library";
import { CloudEvidencePage, SharedEvidencePage } from "./pages/evidence-viewer";
import { JoinPage } from "./pages/join";
import { LandingPage } from "./pages/landing";
import {
  OrganisationDetailLayout,
  OrganisationsListPage,
  OrgInvitationsTab,
  OrgLibraryTab,
  OrgMembersTab,
  OrgOptionsTab
} from "./pages/organisations";
import { PrivacyPage } from "./pages/privacy";
import { QuickViewPage } from "./pages/quick-view";
import { RouteError } from "./pages/route-error";
import { SettingsPage } from "./pages/settings";

/** Thin progress bar shown during route transitions. */
function GlobalPendingBar(): React.JSX.Element | null {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[1000] h-0.5 overflow-hidden bg-transparent" aria-hidden>
      <div className="h-full w-2/5 animate-[shimmer_1s_linear_infinite] bg-[linear-gradient(90deg,transparent,var(--primary),transparent)] bg-[length:200%_100%]" />
    </div>
  );
}

function RootLayout(): React.JSX.Element {
  return (
    <>
      <GlobalPendingBar />
      <ScrollRestoration />
      <Outlet />
    </>
  );
}

/**
 * Signed-out fallback for the workspace. The marketing landing owns "/", every
 * other workspace route prompts sign-in (or explains a missing Clerk config).
 */
function WorkspaceGateFallback(): React.JSX.Element {
  const location = useLocation();
  if (location.pathname === "/") return <LandingPage />;
  if (!clerkPublishableKey) {
    return (
      <StatusScreen
        tone="error"
        title="Sign-in is not configured"
        detail="Set CLERK_PUBLISHABLE_KEY to access the authenticated workspace."
      >
        <Button onClick={() => window.location.assign("/")}>Back to home</Button>
      </StatusScreen>
    );
  }
  // RequireAuth renders the Clerk sign-in screen for its default signed-out state.
  return <RequireAuth>{null}</RequireAuth>;
}

function WorkspaceLayout(): React.JSX.Element {
  const fallback = <WorkspaceGateFallback />;
  return (
    <RequireAuth signedOut={fallback} notConfigured={fallback}>
      <WorkspaceShell>
        <Outlet />
      </WorkspaceShell>
    </RequireAuth>
  );
}

function NotFoundPage(): React.JSX.Element {
  return (
    <StatusScreen
      tone="error"
      title="Page not found"
      detail="The page you’re looking for doesn’t exist or may have moved."
    >
      <Button onClick={() => window.location.assign("/")}>Back to workspace</Button>
    </StatusScreen>
  );
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      // Authenticated workspace (persistent shell across these routes).
      {
        element: <WorkspaceLayout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "evidence", element: <EvidenceLibraryPage /> },
          { path: "test-cases", element: <ComingSoonPage variant="test-cases" /> },
          { path: "documents", element: <ComingSoonPage variant="documents" /> },
          { path: "organisations", element: <OrganisationsListPage /> },
          {
            path: "organisations/:orgId",
            element: <OrganisationDetailLayout />,
            loader: ({ params }) => {
              if (!params.orgId) throw redirect("/organisations");
              return null;
            },
            children: [
              { index: true, element: <OrgMembersTab /> },
              // Legacy alias: members lived at .../members before becoming the index.
              { path: "members", loader: ({ params }) => redirect(`/organisations/${params.orgId}`) },
              { path: "invitations", element: <OrgInvitationsTab /> },
              { path: "library", element: <OrgLibraryTab /> },
              { path: "options", element: <OrgOptionsTab /> }
            ]
          },
          { path: "settings", element: <SettingsPage /> }
        ]
      },

      // Public / standalone routes.
      { path: "quick-view", element: <QuickViewPage /> },
      { path: "privacy", element: <PrivacyPage /> },
      { path: "join", element: <JoinPage /> },
      { path: "share/:shareToken", element: <SharedEvidencePage /> },
      { path: "evidence/:evidenceId", element: <CloudEvidencePage /> },
      { path: "desktop-auth", element: <DesktopAuthApprovalPage /> },
      { path: "extension-auth", element: <ExtensionAuthApprovalPage /> },
      { path: "home", loader: () => redirect("/") },

      { path: "*", element: <NotFoundPage /> }
    ]
  }
]);
