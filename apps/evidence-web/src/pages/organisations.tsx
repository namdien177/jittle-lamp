import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
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
  type ApiCreatedInvitationCode,
  type ApiEvidenceSummary,
  type ApiInvitation,
  type ApiInvitationCode,
  type ApiMember,
  type ApiMembersResponse,
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
  const auth = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [orgs, setOrgs] = useState<ApiOrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("name");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showAccept, setShowAccept] = useState(false);
  const getToken: FetchToken = () => auth.getToken();

  const load = async (): Promise<void> => {
    const [profile, list] = await Promise.all([
      api.fetchAccountProfile(getToken),
      api.listOrganizations(getToken)
    ]);
    setActiveOrgId(profile.activeOrgId);
    setOrgs(list.organizations);
  };

  useEffect(() => {
    if (!auth.isLoaded || !auth.isSignedIn) return;
    setLoading(true);
    void load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load organisations."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isLoaded, auth.isSignedIn]);

  const ordered = useMemo(() => sortOrganizations(orgs, activeOrgId, sort), [activeOrgId, orgs, sort]);

  const activate = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.selectActiveOrganization(getToken, id);
      setActiveOrgId(id);
      toast.success("Active workspace changed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change active organisation.");
    } finally {
      setBusy(false);
    }
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
          <div className="rounded-md border border-destructive/40 bg-destructive/12 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {orgs.length} organisation{orgs.length === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
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
                      <span className="text-xs text-muted-foreground">
                        {org.isPersonal ? "Personal workspace" : "Organisation workspace"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{roleBadge(org.role)}</TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {relTime(org.joinedAt)}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {org.memberCount}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant={org.id === activeOrgId ? "ghost" : "secondary"}
                          size="sm"
                          disabled={busy || org.id === activeOrgId}
                          onClick={() => void activate(org.id)}
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
          getToken={getToken}
          onClose={() => setShowCreate(false)}
          onCreated={async (created) => {
            setShowCreate(false);
            await load();
            navigate(`/organisations/${created.id}`);
          }}
        />
      ) : null}
      {showAccept ? (
        <AcceptInvitationDialog
          getToken={getToken}
          onClose={() => setShowAccept(false)}
          onAccepted={async (id) => {
            setShowAccept(false);
            await load();
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
  getToken: FetchToken;
  activeOrgId: string | null;
  canManage: boolean;
  isOwner: boolean;
  setError: (error: string | null) => void;
  reloadShell: () => Promise<void>;
};

export function OrganisationDetailLayout(): React.JSX.Element {
  const { orgId = "" } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<ApiOrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const getToken: FetchToken = () => auth.getToken();
  const org = orgs.find((candidate) => candidate.id === orgId) ?? null;
  const canManage = org?.role === "owner" || org?.role === "moderator";
  const isOwner = org?.role === "owner";

  const reloadShell = async (): Promise<void> => {
    const [profile, list] = await Promise.all([
      api.fetchAccountProfile(getToken),
      api.listOrganizations(getToken)
    ]);
    setActiveOrgId(profile.activeOrgId);
    setOrgs(list.organizations);
    if (!list.organizations.some((candidate) => candidate.id === orgId)) navigate("/organisations");
  };

  useEffect(() => {
    if (!auth.isLoaded || !auth.isSignedIn) return;
    void reloadShell().catch((err) =>
      setError(err instanceof Error ? err.message : "Unable to load organisation.")
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isLoaded, auth.isSignedIn, orgId]);

  const context: OrgOutletContext = {
    orgId,
    org,
    getToken,
    activeOrgId,
    canManage,
    isOwner,
    setError,
    reloadShell
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
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/12 px-3 py-2 text-sm text-destructive">
            {error}
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
  const [result, setResult] = useState<ApiMembersResponse>({ members: [], total: 0, page: 1, limit: 20 });
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const pages = Math.max(1, Math.ceil(result.total / result.limit));

  const load = async (): Promise<void> => {
    const res = await api.listMembers(ctx.getToken, ctx.orgId, {
      search: search.trim() || undefined,
      role: roleFilter,
      page,
      limit: 20
    });
    setResult(res);
  };

  useEffect(() => {
    void load().catch((err) => ctx.setError(err instanceof Error ? err.message : "Unable to load members."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.orgId, search, roleFilter, page]);

  const updateRole = async (member: ApiMember, role: "moderator" | "member"): Promise<void> => {
    setBusy(true);
    try {
      await api.updateMemberRole(ctx.getToken, ctx.orgId, member.membershipId, role);
      await load();
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to update member.");
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member: ApiMember): Promise<void> => {
    setBusy(true);
    try {
      await api.removeMember(ctx.getToken, ctx.orgId, member.membershipId);
      await load();
      await ctx.reloadShell();
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to remove member.");
    } finally {
      setBusy(false);
    }
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
          {result.members.map((member) => {
            const editable =
              ctx.canManage && member.role !== "owner" && (ctx.isOwner || member.role === "member");
            return (
              <TableRow key={member.membershipId}>
                <TableCell>
                  <span className="block font-medium text-foreground">{memberName(member)}</span>
                  <span className="block text-xs text-muted-foreground">{member.email ?? "No email"}</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{roleBadge(member.role)}</TableCell>
                <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                  {relTime(member.joinedAt)}
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
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
                          onValueChange={(v) => void updateRole(member, v)}
                        />
                      </div>
                    ) : null}
                    {editable ? (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void removeMember(member)}>
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {result.members.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                No members match this filter.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between gap-3 border-t border-border p-3">
        <span className="text-xs text-muted-foreground">
          {result.total} member{result.total === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="text-xs text-muted-foreground">
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
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [codes, setCodes] = useState<ApiInvitationCode[]>([]);
  const [createdCode, setCreatedCode] = useState<ApiCreatedInvitationCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const form = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { label: "Team onboarding", role: "member", password: "", emailDomain: "", expiresDays: "", guestDays: "" }
  });

  const reload = async (): Promise<void> => {
    const res = await api.listInvitations(ctx.getToken, ctx.orgId);
    setInvitations(res.invitations);
    setCodes(res.codes);
  };

  useEffect(() => {
    if (!ctx.canManage) return;
    void reload().catch((err) => ctx.setError(err instanceof Error ? err.message : "Unable to load invitations."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.orgId, ctx.canManage]);

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
    setBusy(true);
    try {
      const result = await api.createInvitationCode(ctx.getToken, ctx.orgId, {
        label: values.label,
        role: values.role,
        emailDomain: values.emailDomain || null,
        expiresAt: values.expiresDays ? Date.now() + Number(values.expiresDays) * 86400000 : null,
        guestExpiresAfterDays: values.guestDays ? Number(values.guestDays) : null,
        ...(values.password?.trim() ? { password: values.password.trim() } : {})
      });
      setCreatedCode(result.code);
      form.setValue("password", "");
      setShowCreate(false);
      await reload();
      toast.success("Invitation code created");
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to create invitation code.");
    } finally {
      setBusy(false);
    }
  };

  const toggleCode = async (code: ApiInvitationCode): Promise<void> => {
    setBusy(true);
    try {
      await api.setInvitationCodeLocked(ctx.getToken, ctx.orgId, code.id, !code.lockedAt);
      await reload();
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to update invitation code.");
    } finally {
      setBusy(false);
    }
  };

  const deleteCode = async (code: ApiInvitationCode): Promise<void> => {
    setBusy(true);
    try {
      await api.deleteInvitationCode(ctx.getToken, ctx.orgId, code.id);
      await reload();
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to delete invitation code.");
    } finally {
      setBusy(false);
    }
  };

  const roleValue = form.watch("role");
  const guestDaysValue = form.watch("guestDays");

  return (
    <div className="space-y-4">
      <Card className="p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">Invitation codes</h2>
            <p className="text-sm text-muted-foreground">Reusable codes for member onboarding.</p>
          </div>
          <Button onClick={() => setShowCreate(true)} disabled={busy || codes.length >= 3}>
            <Plus aria-hidden />
            Create
          </Button>
        </div>
        {createdCode ? (
          <div className="m-4 space-y-2 rounded-lg border border-primary/30 bg-primary/[0.07] p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-brand-300">
              New static joining code
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-black/40 px-2.5 py-2 font-mono text-sm">
                {createdCode.code}
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
            {codes.map((code) => (
              <TableRow key={code.id}>
                <TableCell>
                  <span className="block font-medium text-foreground">{code.label}</span>
                  <span className="block text-xs capitalize text-muted-foreground">{code.role}</span>
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                  {[
                    code.hasPassword ? "password" : null,
                    code.emailDomain ? `@${code.emailDomain}` : null,
                    code.expiresAt ? `expires ${relTime(code.expiresAt)}` : null
                  ]
                    .filter(Boolean)
                    .join(" · ") || "None"}
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
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
            ))}
            {codes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
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
            <h2 className="text-sm font-semibold">Direct invitations</h2>
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
                  <TableCell className="text-sm">{invitation.email}</TableCell>
                  <TableCell>{roleBadge(invitation.role)}</TableCell>
                  <TableCell className="text-sm capitalize text-muted-foreground">{invitation.status}</TableCell>
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
  const [evidences, setEvidences] = useState<ApiEvidenceSummary[]>([]);
  const [creators, setCreators] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void Promise.all([
      api.listEvidences(ctx.getToken, ctx.orgId),
      api.listMembers(ctx.getToken, ctx.orgId, { limit: 100 })
    ])
      .then(([evidenceResult, memberResult]) => {
        setEvidences(evidenceResult.evidences);
        setCreators(new Map(memberResult.members.map((m) => [m.userId, memberName(m)])));
      })
      .catch((err) => ctx.setError(err instanceof Error ? err.message : "Unable to load library."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.orgId]);

  return (
    <Card className="overflow-hidden p-0">
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
                  <span className="block truncate font-mono text-xs text-muted-foreground">{evidence.id}</span>
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                  {creators.get(evidence.createdBy) ?? evidence.createdBy}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge variant="muted" className="capitalize">
                    {evidence.sourceType}
                  </Badge>
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
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
  const [busy, setBusy] = useState(false);

  const leave = async (): Promise<void> => {
    if (!ctx.org || !window.confirm(`Leave ${ctx.org.name}?`)) return;
    setBusy(true);
    try {
      await api.leaveOrganization(ctx.getToken, ctx.org.id);
      toast.success("Left organisation");
      navigate("/organisations");
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "Unable to leave organisation.");
    } finally {
      setBusy(false);
    }
  };

  if (!ctx.org) return <Skeleton className="h-24 w-full" />;

  return (
    <Card className="divide-y divide-border p-0">
      <div className="flex items-center justify-between gap-3 p-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <LogOut className="size-4 text-muted-foreground" aria-hidden />
            Leave organisation
          </h3>
          <p className="text-sm text-muted-foreground">Remove your membership from this organisation.</p>
        </div>
        <Button variant="destructive" disabled={busy || ctx.org.isPersonal} onClick={() => void leave()}>
          Leave
        </Button>
      </div>
      {ctx.isOwner ? (
        <div className="flex items-center justify-between gap-3 p-4">
          <div>
            <h3 className="text-sm font-semibold">Transfer organisation</h3>
            <p className="text-sm text-muted-foreground">
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
  getToken: FetchToken;
  onClose: () => void;
  onCreated: (organization: ApiOrgSummary) => Promise<void>;
}): React.JSX.Element {
  const form = useForm<CreateOrgValues>({ resolver: zodResolver(createOrgSchema), defaultValues: { name: "" } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: CreateOrgValues): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createOrganization(props.getToken, values.name.trim());
      await props.onCreated(result.organization);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create organisation.");
    } finally {
      setBusy(false);
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
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </Dialog>
  );
}

function AcceptInvitationDialog(props: {
  getToken: FetchToken;
  onClose: () => void;
  onAccepted: (orgId: string) => Promise<void>;
}): React.JSX.Element {
  const form = useForm<AcceptInvitationValues>({
    resolver: zodResolver(acceptInvitationSchema),
    defaultValues: { token: "", password: "" }
  });
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: AcceptInvitationValues): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (!requiresPassword) {
        const lookup = await api.lookupInvitation(props.getToken, values.token.trim()).catch(() => null);
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
      const result = await api.acceptInvitationWithPassword(
        props.getToken,
        values.token.trim(),
        requiresPassword ? values.password : undefined
      );
      await props.onAccepted(result.organizationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to accept invitation.");
    } finally {
      setBusy(false);
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
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </Dialog>
  );
}
