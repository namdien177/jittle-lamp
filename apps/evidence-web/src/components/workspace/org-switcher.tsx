import React from "react";
import { useNavigate } from "react-router";
import { Check, ChevronDown, KeyRound, Settings2 } from "lucide-react";

import { useAccountProfile, useSelectActiveOrganization } from "../../queries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { SidebarMenuButton } from "../ui/sidebar";

function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return (letters || "?").toUpperCase();
}

export function OrgAvatar(props: { name: string; className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={
        props.className ??
        "grid size-5 shrink-0 place-items-center rounded-[5px] bg-gradient-to-br from-brand-400 to-brand-700 text-2xs font-semibold text-white"
      }
    >
      {initialsOf(props.name)}
    </span>
  );
}

/** Workspace switcher at the top of the sidebar (Linear style). */
export function OrgSwitcher(): React.JSX.Element {
  const navigate = useNavigate();
  const profileQuery = useAccountProfile();
  const selectOrg = useSelectActiveOrganization();

  const orgs = profileQuery.data?.organizations ?? [];
  const activeOrg = orgs.find((org) => org.isActive) ?? null;
  const busyOrgId = selectOrg.isPending ? (selectOrg.variables ?? null) : null;
  const label = activeOrg?.name ?? (profileQuery.isPending ? "Loading…" : "Select workspace");

  return (
    <DropdownMenu>
      <SidebarMenuButton
        render={<DropdownMenuTrigger />}
        tooltip={label}
        aria-label={`Workspace: ${label}`}
        className="h-8 gap-2 px-1.5 data-[popup-open]:bg-sidebar-accent"
      >
        <OrgAvatar name={activeOrg?.name ?? "?"} />
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">{label}</span>
        <ChevronDown aria-hidden className="ml-auto size-3.5! opacity-60" />
      </SidebarMenuButton>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Organisations</DropdownMenuLabel>
        {orgs.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">{profileQuery.isPending ? "Loading…" : "No organisations yet."}</div>
        ) : (
          orgs.map((org) => (
            <DropdownMenuItem key={org.id} disabled={busyOrgId !== null || org.isActive} onClick={() => selectOrg.mutate(org.id)}>
              <OrgAvatar name={org.name} />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {org.isActive ? <Check aria-hidden className="size-3.5 text-foreground" /> : <span className="text-xs capitalize text-muted-foreground">{org.isPersonal ? "personal" : org.role}</span>}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/organisations")}>
          <Settings2 aria-hidden />
          Manage organisations
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/join")}>
          <KeyRound aria-hidden />
          Join with a code
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
