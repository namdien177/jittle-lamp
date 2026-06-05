import React from "react";
import { UserButton } from "@clerk/clerk-react";
import { Archive, Building2, Cloud } from "lucide-react";
import { NavLink } from "react-router";

import { useAccountProfile } from "./queries";

export function AuthSidebar(props: { evidenceCount?: number }): React.JSX.Element {
  const profileQuery = useAccountProfile();
  const profile = profileQuery.data ?? null;
  const activeOrg = profile?.organizations.find((org) => org.isActive) ?? null;
  const accountLabel = profile?.user.displayName ?? profile?.user.email ?? "Signed in";

  return (
    <aside className="ed-side">
      <NavLink to="/" end className="ed-side-brand">
        Jittle Lamp
      </NavLink>

      <nav className="ed-side-nav" aria-label="Workspace navigation">
        <p className="ed-side-heading">Workspace</p>
        <NavLink
          to="/"
          end
          className={({ isActive }) => `ed-side-link${isActive ? " is-active" : ""}`}
        >
          <Cloud className="ed-side-link-icon" aria-hidden="true" size={15} strokeWidth={2} />
          <span className="ed-side-link-label">Cloud evidences</span>
          {props.evidenceCount !== undefined ? (
            <span className="ed-side-link-count">{props.evidenceCount}</span>
          ) : null}
        </NavLink>
        <NavLink
          to="/quick-view"
          className={({ isActive }) => `ed-side-link${isActive ? " is-active" : ""}`}
        >
          <Archive className="ed-side-link-icon" aria-hidden="true" size={15} strokeWidth={2} />
          <span className="ed-side-link-label">Quick view (ZIP)</span>
        </NavLink>
        <NavLink
          to="/organisations"
          className={({ isActive }) => `ed-side-link${isActive ? " is-active" : ""}`}
        >
          <Building2 className="ed-side-link-icon" aria-hidden="true" size={15} strokeWidth={2} />
          <span className="ed-side-link-label">Organisations</span>
        </NavLink>
      </nav>

      <div className="ed-side-account">
        <UserButton />
        <div className="ed-side-account-meta">
          <span className="ed-side-account-name">{accountLabel}</span>
          <span className="ed-side-account-org">
            {activeOrg ? activeOrg.name : "No active workspace"}
          </span>
        </div>
      </div>
    </aside>
  );
}

export function AuthenticatedWebLayout(props: {
  children: React.ReactNode;
  evidenceCount?: number;
}): React.JSX.Element {
  return (
    <div className="ed-shell">
      <AuthSidebar {...(props.evidenceCount !== undefined ? { evidenceCount: props.evidenceCount } : {})} />
      {props.children}
    </div>
  );
}
