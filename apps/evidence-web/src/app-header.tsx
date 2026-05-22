import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { SignInButton, SignedIn, SignedOut, UserButton } from "@clerk/clerk-react";
import { Link, useNavigate } from "react-router";

import { clerkPublishableKey } from "./env";
import { useAccountProfile, useSelectActiveOrganization } from "./queries";

export function AppHeader(): React.JSX.Element | null {
  if (!clerkPublishableKey) return null;
  return (
    <header className="ed-nav">
      <Link to="/" className="ed-nav-brand">
        Jittle Lamp
      </Link>
      <div className="ed-nav-right">
        <SignedIn>
          <OrganisationMenu />
          <span className="ed-nav-sep" aria-hidden="true" />
          <UserButton />
        </SignedIn>
        <SignedOut>
          <SignInButton mode="modal">
            <button className="ed-nav-link" type="button">
              Sign in
            </button>
          </SignInButton>
        </SignedOut>
      </div>
    </header>
  );
}

function OrganisationMenu(): React.JSX.Element {
  const navigate = useNavigate();
  const profileQuery = useAccountProfile();
  const selectOrgMutation = useSelectActiveOrganization();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const orgs = profileQuery.data?.organizations ?? [];
  const loading = profileQuery.isFetching;
  const error =
    profileQuery.error instanceof Error
      ? profileQuery.error.message
      : selectOrgMutation.error instanceof Error
        ? selectOrgMutation.error.message
        : null;
  const busyOrgId = selectOrgMutation.isPending ? selectOrgMutation.variables ?? null : null;

  const handleSwitch = (orgId: string): void => {
    selectOrgMutation.mutate(orgId, {
      onSuccess: () => setOpen(false)
    });
  };

  const goToJoin = (): void => {
    setOpen(false);
    navigate("/join");
  };

  const activeOrg = orgs.find((org) => org.isActive) ?? null;
  const triggerLabel = activeOrg?.name ?? (loading ? "Loading…" : "Select organisation");

  return (
    <div className="ed-org-menu" ref={containerRef}>
      <button
        type="button"
        className="ed-nav-link ed-org-menu-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="ed-org-menu-label">{triggerLabel}</span>
        <ChevronDown className="ed-org-menu-caret" aria-hidden size={14} strokeWidth={1.5} />
      </button>
      {open ? (
        <div className="ed-org-menu-popover" role="menu">
          <div className="ed-org-menu-heading">Your organisations</div>
          {loading && orgs.length === 0 ? (
            <div className="ed-org-menu-empty">Loading…</div>
          ) : orgs.length === 0 ? (
            <div className="ed-org-menu-empty">You&apos;re not in any organisation yet.</div>
          ) : (
            <ul className="ed-org-menu-list">
              {orgs.map((org) => (
                <li key={org.id}>
                  <button
                    type="button"
                    className="ed-org-menu-item"
                    data-active={org.isActive ? "true" : "false"}
                    disabled={busyOrgId !== null}
                    onClick={() => handleSwitch(org.id)}
                  >
                    <span className="ed-org-menu-item-name">{org.name}</span>
                    <span className="ed-org-menu-item-meta">
                      {org.isPersonal ? "Personal" : org.role}
                      {org.isActive ? " · active" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error ? <div className="ed-org-menu-error">{error}</div> : null}
          <div className="ed-org-menu-rule" />
          <button
            type="button"
            className="ed-org-menu-item ed-org-menu-action"
            onClick={goToJoin}
          >
            Join organisation with code
          </button>
        </div>
      ) : null}
    </div>
  );
}
