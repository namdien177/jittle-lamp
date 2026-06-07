import React, { useMemo, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  Navigate,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams,
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
  Users,
} from "lucide-react";

import {
  api,
  type ApiActivityLog,
  type ApiInvitationCode,
  type ApiJoinRequest,
  type ApiMember,
  type ApiOrgSummary,
  type FetchToken,
  type OrganizationPermission,
  type OrganizationRoleKey,
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
  TableRow,
} from "../components/ui/table";
import {
  useAcceptInvitation,
  useAccountProfile,
  useCreateInvitation,
  useCreateInvitationCode,
  useCreateOrganization,
  useDeleteInvitationCode,
  useEvidences,
  useLeaveOrganization,
  useOrganizationActivity,
  useOrganizationInvitations,
  useOrganizationJoinRequests,
  useOrganizationMembers,
  useOrganizationRoles,
  useOrganizations,
  useRemoveMember,
  useReviewJoinRequest,
  useSelectActiveOrganization,
  useSetInvitationCodeLocked,
  useUpdateOrganizationRole,
  useUpdateOrganizationSettings,
  useUpdateMemberRole,
} from "../queries";
import { useToast } from "../toast";

type SortKey = "name" | "joinedAt" | "role";
type RoleFilter = "all" | OrganizationRoleKey;

const createOrgSchema = z.object({
  name: z.string().trim().min(1, "Organisation name is required.").max(100),
});
const acceptInvitationSchema = z.object({
  token: z.string().trim().min(1, "Invitation code is required."),
  password: z.string().optional(),
});
const codeSchema = z.object({
  label: z.string().trim().min(1, "Label is required.").max(80),
  role: z.enum(["admin", "moderator", "developer", "qa_engineer"]),
  password: z.string().optional(),
  emailDomain: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, "").toLowerCase())
    .pipe(
      z.union([
        z.literal(""),
        z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Use a valid domain."),
      ]),
    ),
  expiresDays: z.string().regex(/^\d*$/, "Use whole days only."),
  guestDays: z.string(),
});
const directInvitationSchema = z.object({
  email: z.string().trim().email("Use a valid email address."),
  role: z.enum(["admin", "moderator", "developer", "qa_engineer"]),
  expiresDays: z.string().regex(/^\d+$/, "Use whole days only."),
});

type CreateOrgValues = z.infer<typeof createOrgSchema>;
type AcceptInvitationValues = z.infer<typeof acceptInvitationSchema>;
type CodeValues = z.infer<typeof codeSchema>;
type DirectInvitationValues = z.infer<typeof directInvitationSchema>;

const sortOptions: Array<{ label: string; value: SortKey }> = [
  { label: "Name", value: "name" },
  { label: "Date joined", value: "joinedAt" },
  { label: "Role", value: "role" },
];
const roleFilterOptions: Array<{ label: string; value: RoleFilter }> = [
  { label: "All roles", value: "all" },
  { label: "Admin", value: "admin" },
  { label: "Moderator", value: "moderator" },
  { label: "QA Engineer", value: "qa_engineer" },
  { label: "Developer", value: "developer" },
];
const editableRoleOptions: Array<{
  label: string;
  value: OrganizationRoleKey;
}> = [
  { label: "Admin", value: "admin" },
  { label: "Moderator", value: "moderator" },
  { label: "QA Engineer", value: "qa_engineer" },
  { label: "Developer", value: "developer" },
];
const guestDayOptions: Array<{ label: string; value: string }> = [
  { label: "Permanent", value: "" },
  { label: "1 day", value: "1" },
  { label: "3 days", value: "3" },
  { label: "7 days", value: "7" },
  { label: "14 days", value: "14" },
  { label: "30 days", value: "30" },
];

function relTime(value: number): string {
  const diff = Date.now() - value;
  const day = 24 * 60 * 60 * 1000;
  if (Math.abs(diff) < day) return "today";
  const days = Math.round(Math.abs(diff) / day);
  return diff >= 0 ? `${days}d ago` : `in ${days}d`;
}

function memberName(member: ApiMember): string {
  const fullName = [member.firstName, member.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return fullName || member.displayName || member.email || "Unknown user";
}

function roleLabel(role: string): string {
  if (role === "admin") return "Admin";
  if (role === "moderator") return "Moderator";
  if (role === "qa_engineer") return "QA Engineer";
  if (role === "developer") return "Developer";
  return role;
}

function roleBadge(role: string): React.JSX.Element {
  const variant =
    role === "admin" ? "brand" : role === "moderator" ? "default" : "muted";
  return <Badge variant={variant}>{roleLabel(role)}</Badge>;
}

function sortOrganizations(
  orgs: ApiOrgSummary[],
  activeOrgId: string | null,
  sort: SortKey,
): ApiOrgSummary[] {
  return [...orgs].sort((a, b) => {
    if (a.id === activeOrgId) return -1;
    if (b.id === activeOrgId) return 1;
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "role")
      return a.role.localeCompare(b.role) || a.name.localeCompare(b.name);
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
  const ordered = useMemo(
    () => sortOrganizations(orgs, activeOrgId, sort),
    [activeOrgId, orgs, sort],
  );
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
          <span className=" text-muted-foreground">
            {orgs.length} organisation{orgs.length === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2 text-base text-muted-foreground">
            <span>Order by</span>
            <div className="w-40">
              <Select
                ariaLabel="Order organisations"
                size="sm"
                options={sortOptions}
                value={sort}
                onValueChange={setSort}
              />
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
                  <TableHead className="hidden md:table-cell">
                    Members
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.map((org) => (
                  <TableRow key={org.id} data-active={org.id === activeOrgId}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {org.name}
                        </span>
                        {org.id === activeOrgId ? (
                          <Badge variant="brand">Active</Badge>
                        ) : null}
                      </div>
                      <span className=" text-muted-foreground">
                        {org.isPersonal
                          ? "Personal workspace"
                          : "Organisation workspace"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {roleBadge(org.role)}
                    </TableCell>
                    <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                      {relTime(org.joinedAt)}
                    </TableCell>
                    <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                      {org.memberCount}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant={
                            org.id === activeOrgId ? "ghost" : "secondary"
                          }
                          size="sm"
                          disabled={busy || org.id === activeOrgId}
                          onClick={() =>
                            void activate(org.id).catch((err) =>
                              toast.error(
                                "Unable to change active organisation",
                                err instanceof Error ? err.message : undefined,
                              ),
                            )
                          }
                        >
                          {org.id === activeOrgId ? "Active" : "Set active"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/organisations/${org.id}`)}
                        >
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
  canAdmin: boolean;
  canReviewRequests: boolean;
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
  const canAdmin = org?.role === "admin";
  const canReviewRequests = org?.role === "admin" || org?.role === "moderator";
  const canManage = canAdmin || canReviewRequests;

  if (!org && orgsQuery.isSuccess)
    return <Navigate to="/organisations" replace />;

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
    canAdmin,
    canReviewRequests,
    setError,
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
        actions={
          org?.id === activeOrgId ? (
            <Badge variant="brand">Active workspace</Badge>
          ) : undefined
        }
      />
      <PageBody>
        <PageTabs
          items={[
            { to: base, label: "Members", end: true },
            { to: `${base}/roles`, label: "Roles" },
            { to: `${base}/invitations`, label: "Invitations" },
            { to: `${base}/activity`, label: "Activity" },
            { to: `${base}/library`, label: "Library" },
            { to: `${base}/options`, label: "Options" },
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
    ...(trimmedSearch ? { search: trimmedSearch } : {}),
  });
  const updateMemberRole = useUpdateMemberRole();
  const removeMemberMutation = useRemoveMember();
  const result = membersQuery.data ?? {
    members: [],
    total: 0,
    page: 1,
    limit: 20,
  };
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

  const updateRole = async (
    member: ApiMember,
    role: OrganizationRoleKey,
  ): Promise<void> => {
    ctx.setError(null);
    await updateMemberRole.mutateAsync({
      orgId: ctx.orgId,
      membershipId: member.membershipId,
      role,
    });
  };

  const removeMember = async (member: ApiMember): Promise<void> => {
    ctx.setError(null);
    await removeMemberMutation.mutateAsync({
      orgId: ctx.orgId,
      membershipId: member.membershipId,
    });
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
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
          {loading
            ? [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-10 w-full" />
                  </TableCell>
                </TableRow>
              ))
            : result.members.map((member) => {
                const editable = ctx.canAdmin;
                return (
                  <TableRow key={member.membershipId}>
                    <TableCell>
                      <span className="block font-medium text-foreground">
                        {memberName(member)}
                      </span>
                      <span className="block text-muted-foreground">
                        {member.email ?? "No email"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {roleBadge(member.role)}
                    </TableCell>
                    <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                      {relTime(member.joinedAt)}
                    </TableCell>
                    <TableCell className="hidden text-base text-muted-foreground lg:table-cell">
                      {member.guestExpiresAt
                        ? relTime(member.guestExpiresAt)
                        : "Permanent"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1.5">
                        {editable ? (
                          <div className="w-32">
                            <Select
                              ariaLabel={`Change role for ${memberName(member)}`}
                              size="sm"
                              options={editableRoleOptions}
                              value={member.role as OrganizationRoleKey}
                              disabled={busy}
                              onValueChange={(v) =>
                                void updateRole(member, v).catch((err) =>
                                  ctx.setError(
                                    err instanceof Error
                                      ? err.message
                                      : "Unable to update member.",
                                  ),
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
                                ctx.setError(
                                  err instanceof Error
                                    ? err.message
                                    : "Unable to remove member.",
                                ),
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
              })}
          {!loading && result.members.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="py-8 text-center text-base text-muted-foreground"
              >
                No members match this filter.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between gap-3 border-t border-border p-3">
        <span className=" text-muted-foreground">
          {result.total} member{result.total === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className=" text-muted-foreground">
            Page {page} of {pages}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
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
  const [showDirectInvite, setShowDirectInvite] = useState(false);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [createdDirectToken, setCreatedDirectToken] = useState<string | null>(
    null,
  );
  const invitationsQuery = useOrganizationInvitations(
    ctx.orgId,
    ctx.canReviewRequests,
  );
  const createInvitation = useCreateInvitation();
  const createInvitationCode = useCreateInvitationCode();
  const setInvitationCodeLocked = useSetInvitationCodeLocked();
  const deleteInvitationCode = useDeleteInvitationCode();
  const invitations = invitationsQuery.data?.invitations ?? [];
  const codes = invitationsQuery.data?.codes ?? [];
  const busy =
    createInvitation.isPending ||
    createInvitationCode.isPending ||
    setInvitationCodeLocked.isPending ||
    deleteInvitationCode.isPending;
  const invitationError =
    invitationsQuery.error instanceof Error
      ? invitationsQuery.error.message
      : createInvitation.error instanceof Error
        ? createInvitation.error.message
        : createInvitationCode.error instanceof Error
          ? createInvitationCode.error.message
          : setInvitationCodeLocked.error instanceof Error
            ? setInvitationCodeLocked.error.message
            : deleteInvitationCode.error instanceof Error
              ? deleteInvitationCode.error.message
              : null;
  const form = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: {
      label: "Team onboarding",
      role: "developer",
      password: "",
      emailDomain: "",
      expiresDays: "",
      guestDays: "",
    },
  });
  const directForm = useForm<DirectInvitationValues>({
    resolver: zodResolver(directInvitationSchema),
    defaultValues: {
      email: "",
      role: "developer",
      expiresDays: "7",
    },
  });

  if (!ctx.canReviewRequests) {
    return (
      <EmptyState
        icon={<Users aria-hidden />}
        title="Member access"
        description="Moderators and admins manage invitation links for this organisation."
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
          expiresAt: values.expiresDays
            ? Date.now() + Number(values.expiresDays) * 86400000
            : null,
          guestExpiresAfterDays: values.guestDays
            ? Number(values.guestDays)
            : null,
          ...(values.password?.trim()
            ? { password: values.password.trim() }
            : {}),
        },
      });
      setCreatedCode(result.code.code);
      form.setValue("password", "");
      setShowCreate(false);
      toast.success("Invitation code created");
    } catch (err) {
      ctx.setError(
        err instanceof Error
          ? err.message
          : "Unable to create invitation code.",
      );
    }
  };

  const createDirectInvite = async (
    values: DirectInvitationValues,
  ): Promise<void> => {
    ctx.setError(null);
    try {
      const result = await createInvitation.mutateAsync({
        orgId: ctx.orgId,
        body: {
          email: values.email,
          role: values.role,
          ttlMs: Number(values.expiresDays) * 86400000,
        },
      });
      setCreatedDirectToken(result.invitation.token);
      directForm.reset({ email: "", role: "developer", expiresDays: "7" });
      setShowDirectInvite(false);
      toast.success("Invitation created");
    } catch (err) {
      ctx.setError(
        err instanceof Error ? err.message : "Unable to create invitation.",
      );
    }
  };

  const toggleCode = async (code: ApiInvitationCode): Promise<void> => {
    ctx.setError(null);
    try {
      await setInvitationCodeLocked.mutateAsync({
        orgId: ctx.orgId,
        codeId: code.id,
        locked: !code.lockedAt,
      });
    } catch (err) {
      ctx.setError(
        err instanceof Error
          ? err.message
          : "Unable to update invitation code.",
      );
    }
  };

  const deleteCode = async (code: ApiInvitationCode): Promise<void> => {
    ctx.setError(null);
    try {
      await deleteInvitationCode.mutateAsync({
        orgId: ctx.orgId,
        codeId: code.id,
      });
    } catch (err) {
      ctx.setError(
        err instanceof Error
          ? err.message
          : "Unable to delete invitation code.",
      );
    }
  };

  const roleValue = form.watch("role");
  const guestDaysValue = form.watch("guestDays");
  const directRoleValue = directForm.watch("role");

  return (
    <div className="space-y-4">
      <JoinRequestsPanel
        orgId={ctx.orgId}
        enabled={ctx.canReviewRequests}
        setError={ctx.setError}
      />
      <Card className="p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-base font-semibold">Invitation codes</h2>
            <p className="text-base text-muted-foreground">
              Reusable codes for member onboarding.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setShowDirectInvite(true)}
              disabled={!ctx.canAdmin || busy}
            >
              <Plus aria-hidden />
              Invite email
            </Button>
            <Button
              onClick={() => setShowCreate(true)}
              disabled={!ctx.canAdmin || busy || codes.length >= 3}
            >
              <Plus aria-hidden />
              Create code
            </Button>
          </div>
        </div>
        {invitationError ? (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-base text-destructive">
            {invitationError}
          </div>
        ) : null}
        {createdCode ? (
          <div className="m-4 space-y-2 rounded-lg border border-primary/30 bg-primary/[0.07] p-3">
            <p className=" font-semibold uppercase tracking-[0.06em] text-brand-300">
              New static joining code
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-black/40 px-2.5 py-2 font-mono text-base">
                {createdCode}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreatedCode(null)}
              >
                Done
              </Button>
            </div>
          </div>
        ) : null}
        {createdDirectToken ? (
          <div className="m-4 space-y-2 rounded-lg border border-primary/30 bg-primary/[0.07] p-3">
            <p className="font-semibold uppercase tracking-[0.06em] text-brand-300">
              New direct invitation token
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-black/40 px-2.5 py-2 font-mono text-base">
                {createdDirectToken}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreatedDirectToken(null)}
              >
                Done
              </Button>
            </div>
          </div>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead className="hidden md:table-cell">
                Restrictions
              </TableHead>
              <TableHead className="hidden lg:table-cell">Guest</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitationsQuery.isPending
              ? [0, 1, 2].map((i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-10 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : codes.map((code) => (
                  <TableRow key={code.id}>
                    <TableCell>
                      <span className="block font-medium text-foreground">
                        {code.label}
                      </span>
                      <span className="block capitalize text-muted-foreground">
                        {code.role}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-base text-muted-foreground md:table-cell">
                      {[
                        code.hasPassword ? "password" : null,
                        code.emailDomain ? `@${code.emailDomain}` : null,
                        code.expiresAt
                          ? `expires ${relTime(code.expiresAt)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "None"}
                    </TableCell>
                    <TableCell className="hidden text-base text-muted-foreground lg:table-cell">
                      {code.guestExpiresAfterDays
                        ? `${code.guestExpiresAfterDays} days`
                        : "Permanent"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={code.lockedAt ? "muted" : "success"}>
                        {code.lockedAt ? "Locked" : "Active"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1.5">
                        {ctx.canReviewRequests ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => void toggleCode(code)}
                          >
                            {code.lockedAt ? "Unlock" : "Lock"}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void deleteCode(code)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            {!invitationsQuery.isPending && codes.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-base text-muted-foreground"
                >
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
                  <TableCell className="text-base">
                    {invitation.email}
                  </TableCell>
                  <TableCell>{roleBadge(invitation.role)}</TableCell>
                  <TableCell className="text-base capitalize text-muted-foreground">
                    {invitation.status}
                  </TableCell>
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCreate(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void form.handleSubmit(createCode)()}
                disabled={busy}
              >
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
            <Field
              label="Label"
              error={form.formState.errors.label?.message}
              className="sm:col-span-2"
            >
              <Input autoFocus {...form.register("label")} />
            </Field>
            <Field label="Role">
              <Select
                ariaLabel="Invitation role"
                options={editableRoleOptions}
                value={roleValue}
                onValueChange={(v) =>
                  form.setValue("role", v, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                placeholder="Optional"
                {...form.register("password")}
              />
            </Field>
            <Field
              label="Email domain"
              error={form.formState.errors.emailDomain?.message}
            >
              <Input
                placeholder="littlelives.com"
                {...form.register("emailDomain")}
              />
            </Field>
            <Field
              label="Code expires (days)"
              error={form.formState.errors.expiresDays?.message}
            >
              <Input
                type="number"
                min="1"
                placeholder="No expiry"
                {...form.register("expiresDays")}
              />
            </Field>
            <Field label="Guest duration" className="sm:col-span-2">
              <Select
                ariaLabel="Guest duration"
                options={guestDayOptions}
                value={guestDaysValue}
                onValueChange={(v) =>
                  form.setValue("guestDays", v, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
            </Field>
          </form>
        </Dialog>
      ) : null}

      {showDirectInvite ? (
        <Dialog
          title="Invite by email"
          description="Create a single-use invitation with a required role."
          onClose={() => setShowDirectInvite(false)}
          footer={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDirectInvite(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void directForm.handleSubmit(createDirectInvite)()
                }
                disabled={busy}
              >
                {busy ? "Creating…" : "Create"}
              </Button>
            </>
          }
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void directForm.handleSubmit(createDirectInvite)(event);
            }}
          >
            <Field
              label="Email"
              error={directForm.formState.errors.email?.message}
            >
              <Input autoFocus {...directForm.register("email")} />
            </Field>
            <Field label="Role">
              <Select
                ariaLabel="Invitation role"
                options={editableRoleOptions}
                value={directRoleValue}
                onValueChange={(value) =>
                  directForm.setValue("role", value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
            </Field>
            <Field
              label="Expires (days)"
              error={directForm.formState.errors.expiresDays?.message}
            >
              <Input
                type="number"
                min="1"
                {...directForm.register("expiresDays")}
              />
            </Field>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}

/* ── Roles tab ──────────────────────────────────────────────────────────────── */

const permissionLabels: Record<OrganizationPermission, string> = {
  "evidence.view": "View evidence",
  "evidence.download": "Download evidence",
  "evidence.comment": "Comment",
  "evidence.create": "Create sessions",
  "evidence.update.own": "Edit own evidence",
  "evidence.delete.own": "Delete own evidence",
  "evidence.move.own": "Move own evidence",
  "evidence.update.any": "Edit all evidence",
  "evidence.delete.any": "Delete all evidence",
  "evidence.move.any": "Move all evidence",
  "invitations.create": "Create invitation links",
  "invitations.disable": "Disable invitation links",
  "join_requests.manage": "Review join requests",
  "roles.manage": "Manage roles",
  "members.assign_role": "Assign roles",
  "members.kick": "Remove members",
  "activity.view": "View activity",
};
const adminOnlyPermissions = new Set<OrganizationPermission>([
  "invitations.create",
  "roles.manage",
  "members.assign_role",
  "members.kick",
]);

export function OrgRolesTab(): React.JSX.Element {
  const ctx = useOrgContext();
  const rolesQuery = useOrganizationRoles(ctx.orgId);
  const updateRole = useUpdateOrganizationRole();
  const settingsMutation = useUpdateOrganizationSettings();
  const roles = rolesQuery.data?.roles ?? [];
  const permissions = rolesQuery.data?.permissions ?? [];
  const busy = updateRole.isPending || settingsMutation.isPending;

  const togglePermission = async (
    role: OrganizationRoleKey,
    permission: OrganizationPermission,
    enabled: boolean,
  ): Promise<void> => {
    const current = roles.find((candidate) => candidate.key === role);
    if (!current) return;
    const next = enabled
      ? Array.from(new Set([...current.permissions, permission]))
      : current.permissions.filter((item) => item !== permission);
    await updateRole.mutateAsync({ orgId: ctx.orgId, role, permissions: next });
  };

  if (rolesQuery.isPending) return <Skeleton className="h-64 w-full" />;

  if (rolesQuery.error instanceof Error) {
    return (
      <EmptyState
        icon={<KeyRound aria-hidden />}
        title="Roles unavailable"
        description={rolesQuery.error.message}
      />
    );
  }

  return (
    <div className="space-y-4">
      {ctx.org ? (
        <Card className="flex items-center justify-between gap-4 p-4">
          <div>
            <h2 className="text-base font-semibold">Join approval</h2>
            <p className="text-base text-muted-foreground">
              Invitation links accept members immediately unless approval is
              enabled.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-base">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={ctx.org.requireInvitationApproval}
              disabled={!ctx.canAdmin || busy}
              onChange={(event) =>
                void settingsMutation
                  .mutateAsync({
                    orgId: ctx.orgId,
                    requireInvitationApproval: event.currentTarget.checked,
                  })
                  .catch((err) =>
                    ctx.setError(
                      err instanceof Error
                        ? err.message
                        : "Unable to update settings.",
                    ),
                  )
              }
            />
            Require approval
          </label>
        </Card>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {roles.map((role) => (
          <Card key={role.key} className="p-0">
            <div className="flex items-center justify-between gap-3 border-b border-border p-4">
              <div>
                <h2 className="text-base font-semibold">{role.name}</h2>
                <p className="text-base text-muted-foreground">
                  {role.permissions.length} permissions enabled
                </p>
              </div>
              {roleBadge(role.key)}
            </div>
            <div className="grid gap-2 p-4 sm:grid-cols-2">
              {permissions.map((permission) => {
                const adminOnly = adminOnlyPermissions.has(permission);
                const checked =
                  role.key === "admin" ||
                  (!adminOnly && role.permissions.includes(permission));
                const locked = role.key === "admin" || adminOnly;
                return (
                  <label
                    key={permission}
                    className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-black/15 px-3 py-2 text-base"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={checked}
                      disabled={!ctx.canAdmin || locked || busy}
                      onChange={(event) =>
                        void togglePermission(
                          role.key,
                          permission,
                          event.currentTarget.checked,
                        ).catch((err) =>
                          ctx.setError(
                            err instanceof Error
                              ? err.message
                              : "Unable to update role.",
                          ),
                        )
                      }
                    />
                    <span>{permissionLabels[permission]}</span>
                  </label>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ── Activity tab ───────────────────────────────────────────────────────────── */

function activityTarget(log: ApiActivityLog): string | null {
  const url = log.metadata.entityUrl;
  return typeof url === "string" && url ? url : null;
}

export function OrgActivityTab(): React.JSX.Element {
  const ctx = useOrgContext();
  const navigate = useNavigate();
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const fromMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
  const toMs = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;
  const activityQuery = useOrganizationActivity(
    ctx.orgId,
    {
      ...(action.trim() ? { action: action.trim() } : {}),
      ...(userId.trim() ? { userId: userId.trim() } : {}),
      ...(fromMs !== null && Number.isFinite(fromMs) ? { from: fromMs } : {}),
      ...(toMs !== null && Number.isFinite(toMs) ? { to: toMs } : {}),
      page,
      limit: 25,
    },
    ctx.canReviewRequests,
  );
  const logs = activityQuery.data?.logs ?? [];

  if (!ctx.canReviewRequests) {
    return (
      <EmptyState
        icon={<KeyRound aria-hidden />}
        title="Activity unavailable"
        description="Only moderators and admins can view activity logs."
      />
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="grid gap-2 border-b border-border p-3 md:grid-cols-2 xl:grid-cols-4">
        <Input
          value={action}
          placeholder="Filter by action"
          onChange={(event) => {
            setPage(1);
            setAction(event.currentTarget.value);
          }}
        />
        <Input
          value={userId}
          placeholder="Filter by user id"
          onChange={(event) => {
            setPage(1);
            setUserId(event.currentTarget.value);
          }}
        />
        <Input
          type="date"
          value={fromDate}
          aria-label="Filter activity from date"
          onChange={(event) => {
            setPage(1);
            setFromDate(event.currentTarget.value);
          }}
        />
        <Input
          type="date"
          value={toDate}
          aria-label="Filter activity to date"
          onChange={(event) => {
            setPage(1);
            setToDate(event.currentTarget.value);
          }}
        />
      </div>
      {activityQuery.error instanceof Error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-base text-destructive">
          {activityQuery.error.message}
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Activity</TableHead>
            <TableHead className="hidden md:table-cell">Action</TableHead>
            <TableHead className="hidden lg:table-cell">IP</TableHead>
            <TableHead className="text-right">When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {activityQuery.isPending
            ? [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-10 w-full" />
                  </TableCell>
                </TableRow>
              ))
            : logs.map((log) => {
                const target = activityTarget(log);
                return (
                  <TableRow key={log.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left font-medium text-foreground hover:text-primary disabled:hover:text-foreground"
                        disabled={!target}
                        onClick={() => target && navigate(target)}
                      >
                        {log.message}
                      </button>
                      <span className="block truncate font-mono text-muted-foreground">
                        {log.actorUserId ?? "System"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden font-mono text-base text-muted-foreground md:table-cell">
                      {log.action}
                    </TableCell>
                    <TableCell className="hidden font-mono text-base text-muted-foreground lg:table-cell">
                      {log.ipAddress ?? "-"}
                    </TableCell>
                    <TableCell className="text-right text-base text-muted-foreground">
                      {relTime(log.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
          {!activityQuery.isPending && logs.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="py-8 text-center text-base text-muted-foreground"
              >
                No activity matches this filter.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <div className="flex items-center justify-end gap-2 border-t border-border p-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <span className=" text-muted-foreground">Page {page}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={logs.length < 25}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </Card>
  );
}

/* ── Join requests tab content ──────────────────────────────────────────────── */

function JoinRequestsPanel(props: {
  orgId: string;
  enabled: boolean;
  setError: (error: string | null) => void;
}): React.JSX.Element {
  const requestsQuery = useOrganizationJoinRequests(props.orgId, props.enabled);
  const review = useReviewJoinRequest();
  const requests = requestsQuery.data?.requests ?? [];

  if (!props.enabled) return <></>;
  if (requests.length === 0 && !requestsQuery.isPending) return <></>;

  const decide = async (
    request: ApiJoinRequest,
    decision: "approved" | "rejected",
  ): Promise<void> => {
    props.setError(null);
    await review.mutateAsync({
      orgId: props.orgId,
      joinRequestId: request.id,
      decision,
    });
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-border p-4">
        <h2 className="text-base font-semibold">Join requests</h2>
      </div>
      <Table>
        <TableBody>
          {requests.map((request) => (
            <TableRow key={request.id}>
              <TableCell>
                <span className="block font-medium">{request.displayName}</span>
                <span className="block text-muted-foreground">
                  {request.email ?? request.clerkUserId}
                </span>
              </TableCell>
              <TableCell>{roleBadge(request.requestedRole)}</TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={review.isPending}
                  onClick={() =>
                    void decide(request, "rejected").catch((err) =>
                      props.setError(
                        err instanceof Error
                          ? err.message
                          : "Unable to reject request.",
                      ),
                    )
                  }
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  disabled={review.isPending}
                  onClick={() =>
                    void decide(request, "approved").catch((err) =>
                      props.setError(
                        err instanceof Error
                          ? err.message
                          : "Unable to approve request.",
                      ),
                    )
                  }
                >
                  Accept
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/* ── Library tab ────────────────────────────────────────────────────────────── */

export function OrgLibraryTab(): React.JSX.Element {
  const ctx = useOrgContext();
  const navigate = useNavigate();
  const evidencesQuery = useEvidences({
    orgId: ctx.orgId,
    page: 1,
    limit: 100,
  });
  const membersQuery = useOrganizationMembers(ctx.orgId, { limit: 100 });
  const evidences = evidencesQuery.data?.evidences ?? [];
  const creators = useMemo(
    () =>
      new Map(
        (membersQuery.data?.members ?? []).map((member) => [
          member.userId,
          memberName(member),
        ]),
      ),
    [membersQuery.data?.members],
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
        <EmptyState
          className="m-2 border-0"
          title="No organisation evidence yet"
        />
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
                  <span className="block font-medium text-foreground">
                    {evidence.title}
                  </span>
                  <span className="block truncate font-mono text-muted-foreground">
                    {evidence.id}
                  </span>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      navigate(`/evidence/${encodeURIComponent(evidence.id)}`)
                    }
                  >
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
      ctx.setError(
        err instanceof Error ? err.message : "Unable to leave organisation.",
      );
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
          <p className="text-base text-muted-foreground">
            Remove your membership from this organisation.
          </p>
        </div>
        <Button
          variant="destructive"
          disabled={leaveOrganization.isPending || ctx.org.isPersonal}
          onClick={() => void leave()}
        >
          Leave
        </Button>
      </div>
      {ctx.canAdmin ? (
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
  const form = useForm<CreateOrgValues>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: "" },
  });
  const createOrganization = useCreateOrganization();
  const [error, setError] = useState<string | null>(null);
  const busy = createOrganization.isPending;

  const submit = async (values: CreateOrgValues): Promise<void> => {
    setError(null);
    try {
      const result = await createOrganization.mutateAsync(values.name.trim());
      props.onCreated(result.organization);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to create organisation.",
      );
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
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void form.handleSubmit(submit)()}
            disabled={busy}
          >
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
    defaultValues: { token: "", password: "" },
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
        const lookup = await api
          .lookupInvitation(getToken, values.token.trim())
          .catch(() => null);
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
        ...(requiresPassword && values.password
          ? { password: values.password }
          : {}),
      });
      props.onAccepted(result.organizationId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to accept invitation.",
      );
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
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void form.handleSubmit(submit)()}
            disabled={busy}
          >
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
        <Field
          label="Invitation code"
          error={form.formState.errors.token?.message}
        >
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
