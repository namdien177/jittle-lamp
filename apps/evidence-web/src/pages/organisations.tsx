import React, { useMemo, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  Navigate,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams
} from "react-router";
import { z } from "zod/v4";
import {
  ArrowLeft,
  Building2,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  LogOut,
  Plus,
  Search,
  Users
} from "lucide-react";

import {
  api,
  type ApiInvitationCode,
  type ApiMember,
  type ApiOrgSummary,
  type FetchToken
} from "../api";
import { PageBody, PageHeader, PageTabs } from "../components/page";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Dialog } from "../components/ui/dialog";
import { EmptyState, Skeleton } from "../components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import {
  useAcceptInvitation,
  useAccountProfile,
  useCreateInvitationCode,
  useCreateOrganization,
  useDeleteInvitationCode,
  useEvidences,
  useLeaveOrganization,
  useOrganizationInvitations,
  useOrganizationMembers,
  useOrganizations,
  useRemoveMember,
  useSelectActiveOrganization,
  useSetInvitationCodeLocked,
  useUpdateMemberRole
} from "../queries";
import { useToast } from "../toast";

type SortKey = "name" | "joinedAt" | "role";
type RoleFilter = "all" | "owner" | "moderator" | "member";

const createOrgSchema = z.object({
  name: z.string().trim().min(1, "Organisation name is required.").max(100)
});
const acceptInvitationSchema = z.object({
  token: z.string().trim().min(1, "Invitation code is required."),
  password: z.string().optional()
});
const codeSchema = z.object({
  label: z.string().trim().min(1, "Label is required.").max(80),
  role: z.enum(["moderator", "member"]),
  password: z.string().optional(),
  emailDomain: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, "").toLowerCase())
    .pipe(z.union([z.literal(""), z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Use a valid domain.")])),
  expiresDays: z.string().regex(/^\d*$/, "Use whole days only."),
  guestDays: z.string()
});

type CreateOrgValues = z.infer<typeof createOrgSchema>;
type AcceptInvitationValues = z.infer<typeof acceptInvitationSchema>;
type CodeValues = z.infer<typeof codeSchema>;

const sortOptions: Array<{ label: string; value: SortKey }> = [
  { label: "Name", value: "name" },
  { label: "Date joined", value: "joinedAt" },
  { label: "Role", value: "role" }
];
const roleFilterOptions: Array<{ label: string; value: RoleFilter }> = [
  { label: "All roles", value: "all" },
  { label: "Owner", value: "owner" },
  { label: "Moderator", value: "moderator" },
  { label: "Member", value: "member" }
];
const editableRoleOptions: Array<{ label: string; value: "member" | "moderator" }> = [
  { label: "Member", value: "member" },
  { label: "Moderator", value: "moderator" }
];
const guestDayOptions: Array<{ label: string; value: string }> = [
  { label: "Permanent", value: "" },
  { label: "1 day", value: "1" },
  { label: "3 days", value: "3" },
  { label: "7 days", value: "7" },
  { label: "14 days", value: "14" },
  { label: "30 days", value: "30" }
];

function relTime(value: number): string {
  const diff = Date.now() - value;
  const day = 24 * 60 * 60 * 1000;
  if (Math.abs(diff) < day) return "today";
  const days = Math.round(Math.abs(diff) / day);
  return diff >= 0 ? `${days}d ago` : `in ${days}d`;
}

function memberName(member: ApiMember): string {
  const fullName = [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
  return fullName || member.displayName || member.email || "Unknown user";
}

function roleBadge(role: string): React.JSX.Element {
  const variant = role === "owner" ? "brand" : role === "moderator" ? "default" : "muted";
  return (
    <Badge variant={variant} className="capitalize">
      {role}
    </Badge>
  );
}

function sortOrganizations(orgs: ApiOrgSummary[], activeOrgId: string | null, sort: SortKey): ApiOrgSummary[] {
  return [...orgs].sort((a, b) => {
    if (a.id === activeOrgId) return -1;
    if (b.id === activeOrgId) return 1;
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "role") return a.role.localeCompare(b.role) || a.name.localeCompare(b.name);
    return a.joinedAt - b.joinedAt;
  });
}

/* ── List ─────────────────────────────────────────────────────────────────── */

export function OrganisationsListPage(): React.JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const profileQuery = useAccountProfile();
  const orgsQuery = useOrganizations();
  const selectActiveOrganization = useSelectActiveOrganization();
  const [sort, setSort] = useState<SortKey>("name");
  const [showCreate, setShowCreate] = useState(false);
  const [showAccept, setShowAccept] = useState(false);

  const orgs = orgsQuery.data?.organizations ?? [];
  const activeOrgId = profileQuery.data?.activeOrgId ?? null;
  const ordered = useMemo(() => sortOrganizations(orgs, activeOrgId, sort), [activeOrgId, orgs, sort]);
  const loading = profileQuery.isPending || orgsQuery.isPending;
  const busy = selectActiveOrganization.isPending;
  const error =
    profileQuery.error instanceof Error
      ? profileQuery.error.message
      : orgsQuery.error instanceof Error
        ? orgsQuery.error.message
        : selectActiveOrganization.error instanceof Error
          ? selectActiveOrganization.error.message
          : null;

  const activate = async (id: string): Promise<void> => {
    await selectActiveOrganization.mutateAsync(id);
    toast.success("Active workspace changed");
  };

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Organisations"
        description="Workspaces you belong to. The active organisation receives new uploads and is always listed first."
        actions={
          <>
            <Button variant="outline" onClick={() => setShowAccept(true)}>
              <KeyRound aria-hidden />
              Accept invite
            </Button>
            <Button onClick={() => setShowCreate(true)}>
              <Plus aria-hidden />
              Create
            </Button>
          </>
        }
      />
      <PageBody>
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/12 px-3 py-2 text-base text-destructive">
            {error}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {orgs.length} organisation{orgs.length === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2 text-base text-muted-foreground">
            <span>Order by</span>
            <div className="w-40">
              <Select ariaLabel="Order organisations" size="sm" options={sortOptions} value={sort} onValueChange={setSort} />
            </div>
          </div>
        </div>

        <Card className="overflow-hidden p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : ordered.length === 0 ? (
            <EmptyState
              className="m-2 border-0"
              icon={<Building2 aria-hidden />}
              title="No organisations yet"
              description="Create a workspace or accept an invitation to collaborate on evidence."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organisation</TableHead>
                  <TableHead className="hidden sm:table-cell">Role</TableHead>
                  <TableHead className="hidden md:table-cell">Joined</TableHead>
                  <TableHead className="hidden md:table-cell">Members</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.map((org) => (
                  <TableRow key={org.id} data-active={org.id === activeOrgId}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{org.name}</span>
                        {org.id === activeOrgId ? <Badge variant="brand">Active</Badge> : null}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {org.isPersonal ? "Personal workspace" : "Organisation workspace"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{roleBadge(org.role)}</TableCell>
                    <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                      {relTime(org.joinedAt)}
                    </TableCell>
                    <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                      {org.memberCount}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant={org.id === activeOrgId ? "ghost" : "secondary"}
                          size="sm"
                          disabled={busy || org.id === activeOrgId}
                          onClick={() =>
                            void activate(org.id).catch((err) =>
                              toast.error(
                                "Unable to change active organisation",
                                err instanceof Error ? err.message : undefined
                              )
                            )
                          }
                        >
                          {org.id === activeOrgId ? "Active" : "Set active"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => navigate(`/organisations/${org.id}`)}>
                          Manage
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </PageBody>

      {showCreate ? (
        <CreateOrganizationDialog
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setShowCreate(false);
            navigate(`/organisations/${created.id}`);
          }}
        />
      ) : null}
      {showAccept ? (
        <AcceptInvitationDialog
          onClose={() => setShowAccept(false)}
          onAccepted={(id) => {
            setShowAccept(false);
            navigate(`/organisations/${id}`);
          }}
        />
      ) : null}
    </>
  );
}

/* ── Detail layout (nested routes) ──────────────────────────────────────────── */

type OrgOutletContext = {
  orgId: string;
  org: ApiOrgSummary | null;
  activeOrgId: string | null;
  canManage: boolean;
  isOwner: boolean;
  setError: (error: string | null) => void;
};

export function OrganisationDetailLayout(): React.JSX.Element {
  const { orgId = "" } = useParams();
  const navigate = useNavigate();
  const profileQuery = useAccountProfile();
  const orgsQuery = useOrganizations();
  const [error, setError] = useState<string | null>(null);
  const orgs = orgsQuery.data?.organizations ?? [];
  const activeOrgId = profileQuery.data?.activeOrgId ?? null;
  const org = orgs.find((candidate) => candidate.id === orgId) ?? null;
  const canManage = org?.role === "owner" || org?.role === "moderator";
  const isOwner = org?.role === "owner";

  if (!org && orgsQuery.isSuccess) return <Navigate to="/organisations" replace />;

  const queryError =
    profileQuery.error instanceof Error
      ? profileQuery.error.message
      : orgsQuery.error instanceof Error
        ? orgsQuery.error.message
        : null;

  const context: OrgOutletContext = {
    orgId,
    org,
    activeOrgId,
    canManage,
    isOwner,
    setError
  };

  const base = `/organisations/${orgId}`;

  return (
    <>
      <PageHeader
        eyebrow={
          <button
            type="button"
            onClick={() => navigate("/organisations")}
            className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Organisations
          </button>
        }
        title={org?.name ?? "Organisation"}
        description={
          org
            ? `${org.memberCount} member${org.memberCount === 1 ? "" : "s"} · your role is ${org.role}`
            : "Loading organisation…"
        }
        actions={org?.id === activeOrgId ? <Badge variant="brand">Active workspace</Badge> : undefined}
      />
      <PageBody>
        <PageTabs
          items={[
            { to: base, label: "Members", end: true },
            { to: `${base}/invitations`, label: "Invitations" },
            { to: `${base}/library`, label: "Library" },
            { to: `${base}/options`, label: "Options" }
          ]}
        />
        {error || queryError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/12 px-3 py-2 text-base text-destructive">
            {error ?? queryError}
          </div>
        ) : null}
        <Outlet context={context} />
      </PageBody>
    </>
  );
}

function useOrgContext(): OrgOutletContext {
  return useOutletContext<OrgOutletContext>();
}

/* ── Members tab ────────────────────────────────────────────────────────────── */

export function OrgMembersTab(): React.JSX.Element {
  const ctx = useOrgContext();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [page, setPage] = useState(1);
  const trimmedSearch = search.trim();
  const membersQuery = useOrganizationMembers(ctx.orgId, {
    role: roleFilter,
    page,
    limit: 20,
    ...(trimmedSearch ? { search: trimmedSearch } : {})
  });
  const updateMemberRole = useUpdateMemberRole();
  const removeMemberMutation = useRemoveMember();
  const result = membersQuery.data ?? { members: [], total: 0, page: 1, limit: 20 };
  const pages = Math.max(1, Math.ceil(result.total / result.limit));
  const busy = updateMemberRole.isPending || removeMemberMutation.isPending;
  const loading = membersQuery.isPending;
  const memberError =
    membersQuery.error instanceof Error
      ? membersQuery.error.message
      : updateMemberRole.error instanceof Error
        ? updateMemberRole.error.message
        : removeMemberMutation.error instanceof Error
          ? removeMemberMutation.error.message
          : null;

  const updateRole = async (member: ApiMember, role: "moderator" | "member"): Promise<void> => {
    ctx.setError(null);
    await updateMemberRole.mutateAsync({ orgId: ctx.orgId, membershipId: member.membershipId, role });
  };

  const removeMember = async (member: ApiMember): Promise<void> => {
    ctx.setError(null);
    await removeMemberMutation.mutateAsync({ orgId: ctx.orgId, membershipId: member.membershipId });
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            placeholder="Search members"
            className="pl-9"
            onChange={(e) => {
              setPage(1);
              setSearch(e.currentTarget.value);
            }}
          />
        </div>
        <div className="w-full sm:w-44">
          <Select
            ariaLabel="Filter members by role"
            options={roleFilterOptions}
            value={roleFilter}
            onValueChange={(v) => {
              setPage(1);
              setRoleFilter(v);
            }}
          />
        </div>
      </div>
      {memberError ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-base text-destructive">
          {memberError}
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead className="hidden sm:table-cell">Role</TableHead>
            <TableHead className="hidden md:table-cell">Joined</TableHead>
            <TableHead className="hidden lg:table-cell">Guest until</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            [0, 1, 2].map((i) => (
              <TableRow key={i}>
                <TableCell colSpan={5}>
                  <Skeleton className="h-10 w-full" />
                </TableCell>
              </TableRow>
            ))
          ) : (
            result.members.map((member) => {
            const editable =
              ctx.canManage && member.role !== "owner" && (ctx.isOwner || member.role === "member");
            return (
              <TableRow key={member.membershipId}>
                <TableCell>
                  <span className="block font-medium text-foreground">{memberName(member)}</span>
                  <span className="block text-sm text-muted-foreground">{member.email ?? "No email"}</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{roleBadge(member.role)}</TableCell>
                <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                  {relTime(member.joinedAt)}
                </TableCell>
                <TableCell className="hidden text-base text-muted-foreground lg:table-cell">
                  {member.guestExpiresAt ? relTime(member.guestExpiresAt) : "Permanent"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    {editable && ctx.isOwner ? (
                      <div className="w-32">
                        <Select
                          ariaLabel={`Change role for ${memberName(member)}`}
                          size="sm"
                          options={editableRoleOptions}
                          value={member.role === "moderator" ? "moderator" : "member"}
                          disabled={busy}
                          onValueChange={(v) =>
                            void updateRole(member, v).catch((err) =>
                              ctx.setError(err instanceof Error ? err.message : "Unable to update member.")
                            )
                          }
                        />
                      </div>
                    ) : null}
                    {editable ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void removeMember(member).catch((err) =>
                            ctx.setError(err instanceof Error ? err.message : "Unable to remove member.")
                          )
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
            })
          )}
          {!loading && result.members.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-base text-muted-foreground">
                No members match this filter.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between gap-3 border-t border-border p-3">
        <span className="text-sm text-muted-foreground">
          {result.total} member{result.total === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {pages}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ── Invitations tab ────────────────────────────────────────────────────────── */

export function OrgInvitationsTab(): React.JSX.Element {
  const ctx = useOrgContext();
  const toast = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const invitationsQuery = useOrganizationInvitations(ctx.orgId, ctx.canManage);
  const createInvitationCode = useCreateInvitationCode();
  const setInvitationCodeLocked = useSetInvitationCodeLocked();
  const deleteInvitationCode = useDeleteInvitationCode();
  const invitations = invitationsQuery.data?.invitations ?? [];
  const codes = invitationsQuery.data?.codes ?? [];
  const busy =
    createInvitationCode.isPending ||
    setInvitationCodeLocked.isPending ||
    deleteInvitationCode.isPending;
  const invitationError =
    invitationsQuery.error instanceof Error
      ? invitationsQuery.error.message
      : createInvitationCode.error instanceof Error
        ? createInvitationCode.error.message
        : setInvitationCodeLocked.error instanceof Error
          ? setInvitationCodeLocked.error.message
          : deleteInvitationCode.error instanceof Error
            ? deleteInvitationCode.error.message
            : null;
  const form = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { label: "Team onboarding", role: "member", password: "", emailDomain: "", expiresDays: "", guestDays: "" }
  });

  if (!ctx.canManage) {
    return (
      <EmptyState
        icon={<Users aria-hidden />}
        title="Member access"
        description="Owners and moderators manage invitation codes for this organisation."
      />
    );
  }

  const createCode = async (values: CodeValues): Promise<void> => {
    ctx.setError(null);
    try {
      const result = await createInvitationCode.mutateAsync({
        orgId: ctx.orgId,
        body: {
          label: values.label,
          role: values.role,
          emailDomain: values.emailDomain || null,
          expiresAt: values.expiresDays ? Date.now() + Number(values.expiresDays) * 86400000 : null,
          guestExpiresAfterDays: values.guestDays ? Number(values.guestDays) : null,
          ...(values.password?.trim() ? { password: values.password.trim() } : {})
        }
      });
      setCreatedCode(result.code.code);
      form.setValue("password", "");
      setShowCreate(false);
      toast.success("Invitation code created");
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to create invitation code.");
    }
  };

  const toggleCode = async (code: ApiInvitationCode): Promise<void> => {
    ctx.setError(null);
    try {
      await setInvitationCodeLocked.mutateAsync({
        orgId: ctx.orgId,
        codeId: code.id,
        locked: !code.lockedAt
      });
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to update invitation code.");
    }
  };

  const deleteCode = async (code: ApiInvitationCode): Promise<void> => {
    ctx.setError(null);
    try {
      await deleteInvitationCode.mutateAsync({ orgId: ctx.orgId, codeId: code.id });
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to delete invitation code.");
    }
  };

  const roleValue = form.watch("role");
  const guestDaysValue = form.watch("guestDays");

  return (
    <div className="space-y-4">
      <Card className="p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-base font-semibold">Invitation codes</h2>
            <p className="text-base text-muted-foreground">Reusable codes for member onboarding.</p>
          </div>
          <Button onClick={() => setShowCreate(true)} disabled={busy || codes.length >= 3}>
            <Plus aria-hidden />
            Create
          </Button>
        </div>
        {invitationError ? (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-base text-destructive">
            {invitationError}
          </div>
        ) : null}
        {createdCode ? (
          <div className="m-4 space-y-2 rounded-lg border border-primary/30 bg-primary/[0.07] p-3">
            <p className="text-sm font-semibold uppercase tracking-[0.06em] text-brand-300">
              New static joining code
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-black/40 px-2.5 py-2 font-mono text-base">
                {createdCode}
              </code>
              <Button variant="ghost" size="sm" onClick={() => setCreatedCode(null)}>
                Done
              </Button>
            </div>
          </div>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead className="hidden md:table-cell">Restrictions</TableHead>
              <TableHead className="hidden lg:table-cell">Guest</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitationsQuery.isPending ? (
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-10 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              codes.map((code) => (
              <TableRow key={code.id}>
                <TableCell>
                  <span className="block font-medium text-foreground">{code.label}</span>
                  <span className="block text-sm capitalize text-muted-foreground">{code.role}</span>
                </TableCell>
                <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                  {[
                    code.hasPassword ? "password" : null,
                    code.emailDomain ? `@${code.emailDomain}` : null,
                    code.expiresAt ? `expires ${relTime(code.expiresAt)}` : null
                  ]
                    .filter(Boolean)
                    .join(" · ") || "None"}
                </TableCell>
                <TableCell className="hidden text-base text-muted-foreground lg:table-cell">
                  {code.guestExpiresAfterDays ? `${code.guestExpiresAfterDays} days` : "Permanent"}
                </TableCell>
                <TableCell>
                  <Badge variant={code.lockedAt ? "muted" : "success"}>{code.lockedAt ? "Locked" : "Active"}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    {ctx.isOwner ? (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggleCode(code)}>
                        {code.lockedAt ? "Unlock" : "Lock"}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void deleteCode(code)}>
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              ))
            )}
            {!invitationsQuery.isPending && codes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-base text-muted-foreground">
                  No static codes yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Card>

      {invitations.length > 0 ? (
        <Card className="p-0">
          <div className="border-b border-border p-4">
            <h2 className="text-base font-semibold">Direct invitations</h2>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell className="text-base">{invitation.email}</TableCell>
                  <TableCell>{roleBadge(invitation.role)}</TableCell>
                  <TableCell className="text-base capitalize text-muted-foreground">{invitation.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {showCreate ? (
        <Dialog
          title="Create invitation code"
          description="Generate a reusable code your teammates can redeem to join."
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void form.handleSubmit(createCode)()} disabled={busy}>
                {busy ? "Creating…" : "Create"}
              </Button>
            </>
          }
        >
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit(createCode)(e);
            }}
          >
            <Field label="Label" error={form.formState.errors.label?.message} className="sm:col-span-2">
              <Input autoFocus {...form.register("label")} />
            </Field>
            <Field label="Role">
              <Select
                ariaLabel="Invitation role"
                options={editableRoleOptions}
                value={roleValue}
                onValueChange={(v) => form.setValue("role", v, { shouldDirty: true, shouldValidate: true })}
              />
            </Field>
            <Field label="Password">
              <Input type="password" placeholder="Optional" {...form.register("password")} />
            </Field>
            <Field label="Email domain" error={form.formState.errors.emailDomain?.message}>
              <Input placeholder="littlelives.com" {...form.register("emailDomain")} />
            </Field>
            <Field label="Code expires (days)" error={form.formState.errors.expiresDays?.message}>
              <Input type="number" min="1" placeholder="No expiry" {...form.register("expiresDays")} />
            </Field>
            <Field label="Guest duration" className="sm:col-span-2">
              <Select
                ariaLabel="Guest duration"
                options={guestDayOptions}
                value={guestDaysValue}
                onValueChange={(v) => form.setValue("guestDays", v, { shouldDirty: true, shouldValidate: true })}
              />
            </Field>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}

/* ── Library tab ────────────────────────────────────────────────────────────── */

export function OrgLibraryTab(): React.JSX.Element {
  const ctx = useOrgContext();
  const navigate = useNavigate();
  const evidencesQuery = useEvidences({ orgId: ctx.orgId, page: 1, limit: 100 });
  const membersQuery = useOrganizationMembers(ctx.orgId, { limit: 100 });
  const evidences = evidencesQuery.data?.evidences ?? [];
  const creators = useMemo(
    () => new Map((membersQuery.data?.members ?? []).map((member) => [member.userId, memberName(member)])),
    [membersQuery.data?.members]
  );
  const loading = evidencesQuery.isPending || membersQuery.isPending;
  const libraryError =
    evidencesQuery.error instanceof Error
      ? evidencesQuery.error.message
      : membersQuery.error instanceof Error
        ? membersQuery.error.message
        : null;

  return (
    <Card className="overflow-hidden p-0">
      {libraryError ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-base text-destructive">
          {libraryError}
        </div>
      ) : null}
      {loading ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : evidences.length === 0 ? (
        <EmptyState className="m-2 border-0" title="No organisation evidence yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Evidence</TableHead>
              <TableHead className="hidden md:table-cell">Creator</TableHead>
              <TableHead className="hidden sm:table-cell">Type</TableHead>
              <TableHead className="hidden lg:table-cell">Updated</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {evidences.map((evidence) => (
              <TableRow key={evidence.id}>
                <TableCell>
                  <span className="block font-medium text-foreground">{evidence.title}</span>
                  <span className="block truncate font-mono text-sm text-muted-foreground">{evidence.id}</span>
                </TableCell>
                <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                  {creators.get(evidence.createdBy) ?? evidence.createdBy}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge variant="muted" className="capitalize">
                    {evidence.sourceType}
                  </Badge>
                </TableCell>
                <TableCell className="hidden text-base text-muted-foreground lg:table-cell">
                  {relTime(evidence.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/evidence/${encodeURIComponent(evidence.id)}`)}>
                    Open
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

/* ── Options tab ────────────────────────────────────────────────────────────── */

export function OrgOptionsTab(): React.JSX.Element {
  const ctx = useOrgContext();
  const navigate = useNavigate();
  const toast = useToast();
  const leaveOrganization = useLeaveOrganization();

  const leave = async (): Promise<void> => {
    if (!ctx.org || !window.confirm(`Leave ${ctx.org.name}?`)) return;
    try {
      await leaveOrganization.mutateAsync(ctx.org.id);
      toast.success("Left organisation");
      navigate("/organisations");
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to leave organisation.");
    }
  };

  if (!ctx.org) return <Skeleton className="h-24 w-full" />;

  return (
    <Card className="divide-y divide-border p-0">
      <div className="flex items-center justify-between gap-3 p-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <LogOut className="size-4 text-muted-foreground" aria-hidden />
            Leave organisation
          </h3>
          <p className="text-base text-muted-foreground">Remove your membership from this organisation.</p>
        </div>
        <Button variant="destructive" disabled={leaveOrganization.isPending || ctx.org.isPersonal} onClick={() => void leave()}>
          Leave
        </Button>
      </div>
      {ctx.isOwner ? (
        <div className="flex items-center justify-between gap-3 p-4">
          <div>
            <h3 className="text-base font-semibold">Transfer organisation</h3>
            <p className="text-base text-muted-foreground">
              Transfer ownership to another member before stepping away.
            </p>
          </div>
          <Button variant="ghost" disabled>
            Transfer
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/* ── Dialogs ────────────────────────────────────────────────────────────────── */

function CreateOrganizationDialog(props: {
  onClose: () => void;
  onCreated: (organization: ApiOrgSummary) => void;
}): React.JSX.Element {
  const form = useForm<CreateOrgValues>({ resolver: zodResolver(createOrgSchema), defaultValues: { name: "" } });
  const createOrganization = useCreateOrganization();
  const [error, setError] = useState<string | null>(null);
  const busy = createOrganization.isPending;

  const submit = async (values: CreateOrgValues): Promise<void> => {
    setError(null);
    try {
      const result = await createOrganization.mutateAsync(values.name.trim());
      props.onCreated(result.organization);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create organisation.");
    }
  };

  return (
    <Dialog
      title="Create organisation"
      description="Spin up a new workspace for your team’s evidence."
      onClose={props.onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void form.handleSubmit(submit)()} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit(submit)(e);
        }}
      >
        <Field label="Name" error={form.formState.errors.name?.message}>
          <Input autoFocus {...form.register("name")} />
        </Field>
      </form>
      {error ? <p className="text-base text-destructive">{error}</p> : null}
    </Dialog>
  );
}

function AcceptInvitationDialog(props: {
  onClose: () => void;
  onAccepted: (orgId: string) => void;
}): React.JSX.Element {
  const auth = useAuth();
  const form = useForm<AcceptInvitationValues>({
    resolver: zodResolver(acceptInvitationSchema),
    defaultValues: { token: "", password: "" }
  });
  const acceptInvitation = useAcceptInvitation();
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = acceptInvitation.isPending;
  const getToken: FetchToken = () => auth.getToken();

  const submit = async (values: AcceptInvitationValues): Promise<void> => {
    setError(null);
    try {
      if (!requiresPassword) {
        const lookup = await api.lookupInvitation(getToken, values.token.trim()).catch(() => null);
        if (lookup?.code.requiresPassword) {
          setRequiresPassword(true);
          setError("This invitation code requires a password.");
          return;
        }
      }
      if (requiresPassword && !values.password) {
        setError("Enter the invitation password.");
        return;
      }
      const result = await acceptInvitation.mutateAsync({
        token: values.token.trim(),
        ...(requiresPassword && values.password ? { password: values.password } : {})
      });
      props.onAccepted(result.organizationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to accept invitation.");
    }
  };

  return (
    <Dialog
      title="Accept invitation"
      description="Paste an invitation code an organisation owner shared with you."
      onClose={props.onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void form.handleSubmit(submit)()} disabled={busy}>
            {busy ? "Joining…" : "Join"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit(submit)(e);
        }}
      >
        <Field label="Invitation code" error={form.formState.errors.token?.message}>
          <Input autoFocus className="font-mono" {...form.register("token")} />
        </Field>
        {requiresPassword ? (
          <Field label="Password">
            <Input type="password" {...form.register("password")} />
          </Field>
        ) : null}
      </form>
      {error ? <p className="text-base text-destructive">{error}</p> : null}
    </Dialog>
  );
}
