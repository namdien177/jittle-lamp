import React from "react";
import { useNavigate } from "react-router";
import {
  Building2,
  Check,
  ChevronsUpDown,
  KeyRound,
  Settings2,
} from "lucide-react";

import { cn } from "../../lib/cn";
import { useAccountProfile, useSelectActiveOrganization } from "../../queries";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";

export function OrgSwitcher(): React.JSX.Element {
  const navigate = useNavigate();
  const profileQuery = useAccountProfile();
  const selectOrg = useSelectActiveOrganization();

  const orgs = profileQuery.data?.organizations ?? [];
  const activeOrg = orgs.find((org) => org.isActive) ?? null;
  const busyOrgId = selectOrg.isPending ? (selectOrg.variables ?? null) : null;
  const label =
    activeOrg?.name ??
    (profileQuery.isPending ? "Loading…" : "Select workspace");

  return (
    <DropdownMenu
      align="end"
      trigger={
        <button
          type="button"
          className="inline-flex h-10 max-w-[15rem] items-center gap-2 rounded-md border border-border-strong bg-secondary px-3 text-base font-medium text-foreground outline-none transition-colors hover:border-white/20 focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Building2
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronsUpDown
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </button>
      }
    >
      <DropdownMenuLabel>Your organisations</DropdownMenuLabel>
      {orgs.length === 0 ? (
        <div className="px-2.5 py-2 text-base text-muted-foreground">
          {profileQuery.isPending ? "Loading…" : "No organisations yet."}
        </div>
      ) : (
        orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            disabled={busyOrgId !== null || org.isActive}
            onClick={() => selectOrg.mutate(org.id)}
          >
            <Check
              aria-hidden
              className={cn(
                "size-4 text-primary",
                org.isActive ? "opacity-100" : "opacity-0",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{org.name}</span>
            <span className=" capitalize text-muted-foreground">
              {org.isPersonal ? "personal" : org.role}
            </span>
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
    </DropdownMenu>
  );
}
